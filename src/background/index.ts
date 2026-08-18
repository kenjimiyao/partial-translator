import { TranslationCache, createCacheKey } from "./cache";
import { createTranslationChunks } from "./chunking";
import { mapWithConcurrency } from "./concurrency";
import { runWithDeadline } from "./deadline";
import { ExtensionError, toPublicError } from "./errors";
import { InFlightWorkRegistry } from "./in-flight";
import { requestTranslations, validateTranslations } from "./openai";
import { reconcileAutomaticContentScript } from "./registration";
import { SettingsRepository } from "./settings";
import { restrictStorageToTrustedContexts } from "./storage-isolation";
import {
  MAX_PARALLEL_API_REQUESTS,
  MODEL_NAME,
  PROMPT_VERSION,
  TRANSLATION_JOB_TIMEOUT_MS,
} from "../shared/constants";
import {
  domainToMatchPatterns,
  domainsToMatchPatterns,
  minimizeDomains,
  normalizeDomain,
} from "../shared/domain";
import { calculateTargetCount } from "../shared/target-count";
import type {
  ExtensionSettings,
  Translation,
  TranslationInputItem,
  TranslationResponse,
} from "../shared/types";

interface TranslatePageMessage {
  type: "TRANSLATE_PAGE";
  pageTitle: string;
  pageUrl: string;
  items: TranslationInputItem[];
}

interface SaveSettingsMessage {
  type: "SAVE_SETTINGS";
  translationRate: number;
  domains: string[];
  apiKey?: string;
}

type ContentStatus = "processing" | "translated" | "restored" | "error" | "empty" | "zero";

const settingsRepository = new SettingsRepository(chrome.storage.local);
const translationCache = new TranslationCache(chrome.storage.local);
const translationWork = new InFlightWorkRegistry<Translation[]>();

// storage.local is otherwise exposed to extension content scripts by default.
// Every path that can read or write it is gated on this promise. Keep a rejection
// handler attached immediately so a failed browser API call is never unhandled.
const storageIsolationReady = restrictStorageToTrustedContexts(chrome.storage.local);
void storageIsolationReady.catch(() => undefined);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSettings(message: SaveSettingsMessage): ExtensionSettings {
  if (
    !Number.isFinite(message.translationRate) ||
    message.translationRate < 0 ||
    message.translationRate > 100 ||
    !Number.isInteger(message.translationRate)
  ) {
    throw new ExtensionError("INTERNAL_ERROR", "翻訳率は0〜100の整数で入力してください。");
  }
  if (!Array.isArray(message.domains) || !message.domains.every((value) => typeof value === "string")) {
    throw new ExtensionError("INTERNAL_ERROR", "自動翻訳対象ドメインの形式が正しくありません。");
  }

  let domains: string[];
  try {
    domains = minimizeDomains(
      [...new Set(message.domains.map((domain) => normalizeDomain(domain)))],
    );
  } catch {
    throw new ExtensionError("INTERNAL_ERROR", "自動翻訳対象ドメインの形式が正しくありません。");
  }

  return { translationRate: message.translationRate, domains };
}

async function assertSitePermissions(domains: string[]): Promise<void> {
  const origins = domainsToMatchPatterns(domains);
  if (origins.length > 0 && !(await chrome.permissions.contains({ origins }))) {
    throw new ExtensionError(
      "SITE_PERMISSION_MISSING",
      "自動翻訳対象サイトの権限がありません。Chromeの権限ダイアログで許可してください。",
    );
  }
}

async function findMissingPermissionDomains(domains: string[]): Promise<string[]> {
  const checks = await Promise.all(
    domains.map(async (domain) => ({
      domain,
      granted: await chrome.permissions.contains({
        origins: domainToMatchPatterns(domain),
      }),
    })),
  );
  return checks.filter((check) => !check.granted).map((check) => check.domain);
}

function validateTranslatePageMessage(value: unknown): TranslatePageMessage {
  if (
    !isPlainObject(value) ||
    value.type !== "TRANSLATE_PAGE" ||
    typeof value.pageTitle !== "string" ||
    typeof value.pageUrl !== "string" ||
    !Array.isArray(value.items)
  ) {
    throw new ExtensionError("INTERNAL_ERROR", "翻訳リクエストの形式が正しくありません。");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value.pageUrl);
  } catch {
    throw new ExtensionError("UNSUPPORTED_PAGE", "このページでは拡張機能を実行できません。");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new ExtensionError("UNSUPPORTED_PAGE", "このページでは拡張機能を実行できません。");
  }

  const seenIds = new Set<string>();
  const items: TranslationInputItem[] = value.items.map((item) => {
    if (
      !isPlainObject(item) ||
      typeof item.id !== "string" ||
      typeof item.text !== "string" ||
      typeof item.section_heading !== "string" ||
      item.id.length === 0 ||
      item.text.trim().length === 0 ||
      seenIds.has(item.id)
    ) {
      throw new ExtensionError("INTERNAL_ERROR", "翻訳対象文章の形式が正しくありません。");
    }
    seenIds.add(item.id);
    return {
      id: item.id,
      text: item.text,
      section_heading: item.section_heading,
    };
  });

  return {
    type: "TRANSLATE_PAGE",
    pageTitle: value.pageTitle,
    pageUrl: parsedUrl.href,
    items,
  };
}

async function fetchAndCacheTranslations(
  message: TranslatePageMessage,
  settings: ExtensionSettings,
  apiKey: string,
  targetCount: number,
  cacheKey: string,
  cacheEpoch: number,
): Promise<Translation[]> {
  const chunks = createTranslationChunks(message.items, targetCount, {
    pageTitle: message.pageTitle,
    pageUrl: message.pageUrl,
  }).filter(
    (chunk) => chunk.targetCount > 0,
  );
  const chunkTranslations = await runWithDeadline(
    TRANSLATION_JOB_TIMEOUT_MS,
    (signal) =>
      mapWithConcurrency(
        chunks,
        MAX_PARALLEL_API_REQUESTS,
        (chunk) =>
          requestTranslations(
            apiKey,
            {
              page_title: message.pageTitle,
              page_url: message.pageUrl,
              target_count: chunk.targetCount,
              items: chunk.items,
            },
            { signal },
          ),
      ),
  );
  const translations = chunkTranslations.flat();

  const validated = validateTranslations(
    { translations },
    message.items,
    targetCount,
  );
  // CLEAR_CACHE invalidates the epoch before deleting storage. A request that
  // was already on the wire may still finish, but it must not repopulate the
  // cache after the user has cleared it.
  if (translationWork.isCurrent(cacheEpoch)) {
    await translationCache.set(cacheKey, validated).catch(() => undefined);
  }
  return validated;
}

async function translatePage(messageValue: unknown): Promise<TranslationResponse> {
  try {
    await storageIsolationReady;
    const message = validateTranslatePageMessage(messageValue);
    if (message.items.length === 0) {
      throw new ExtensionError("NO_JAPANESE_TEXT", "翻訳対象の日本語文章が見つかりませんでした。");
    }

    const [settings, apiKey] = await Promise.all([
      settingsRepository.getSettings(),
      settingsRepository.getApiKey(),
    ]);
    if (!apiKey) {
      throw new ExtensionError("API_KEY_MISSING", "OpenAI APIキーが設定されていません。");
    }

    const targetCount = calculateTargetCount(message.items.length, settings.translationRate);
    if (targetCount === 0) {
      throw new ExtensionError("ZERO_RATE", "翻訳率が0%のため、翻訳は行いませんでした。");
    }

    const cacheKey = await createCacheKey({
      pageTitle: message.pageTitle,
      pageUrl: message.pageUrl,
      items: message.items,
      translationRate: settings.translationRate,
      model: MODEL_NAME,
      promptVersion: PROMPT_VERSION,
    });
    const cached = await translationCache.get(cacheKey).catch(() => undefined);
    if (cached) {
      try {
        return {
          ok: true,
          translations: validateTranslations(
            { translations: cached },
            message.items,
            targetCount,
          ),
          fromCache: true,
        };
      } catch {
        await translationCache.delete(cacheKey).catch(() => undefined);
      }
    }

    const work = translationWork.getOrCreate(
      cacheKey,
      (cacheEpoch) => fetchAndCacheTranslations(
        message,
        settings,
        apiKey,
        targetCount,
        cacheKey,
        cacheEpoch,
      ),
    );
    return { ok: true, translations: await work.promise, fromCache: false };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

function isSupportedPageUrl(urlValue: string | undefined): boolean {
  if (!urlValue) {
    return false;
  }
  try {
    const url = new URL(urlValue);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }
    if (url.hostname === "chromewebstore.google.com") {
      return false;
    }
    return !(url.hostname === "chrome.google.com" && url.pathname.startsWith("/webstore"));
  } catch {
    return false;
  }
}

const badgeByStatus: Record<ContentStatus | "key" | "unsupported", { text: string; color: string; title: string }> = {
  processing: { text: "…", color: "#3155c6", title: "英訳を処理しています" },
  translated: { text: "EN", color: "#16794a", title: "英訳を表示中です。クリックで日本語へ戻します" },
  restored: { text: "", color: "#5f6368", title: "クリックして一部を英訳します" },
  error: { text: "ERR", color: "#b3261e", title: "翻訳中にエラーが発生しました" },
  empty: { text: "0", color: "#5f6368", title: "翻訳対象の日本語文章がありません" },
  zero: { text: "0%", color: "#5f6368", title: "翻訳率が0%です" },
  key: { text: "KEY", color: "#b3261e", title: "OpenAI APIキーを設定してください" },
  unsupported: { text: "ERR", color: "#b3261e", title: "このページでは実行できません" },
};

async function setTabBadge(
  tabId: number,
  status: ContentStatus | "key" | "unsupported",
): Promise<void> {
  const badge = badgeByStatus[status];
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text: badge.text }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color }),
    chrome.action.setTitle({ tabId, title: badge.title }),
  ]);
}

async function handleActionClick(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) {
    return;
  }
  if (!isSupportedPageUrl(tab.url)) {
    await setTabBadge(tab.id, "unsupported");
    return;
  }

  try {
    await storageIsolationReady;
  } catch {
    await setTabBadge(tab.id, "error");
    return;
  }

  const apiKey = await settingsRepository.getApiKey();
  if (!apiKey) {
    await setTabBadge(tab.id, "key");
    await chrome.runtime.openOptionsPage();
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_TRANSLATION" });
    return;
  } catch {
    await setTabBadge(tab.id, "processing");
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      files: ["content.js"],
    });
  } catch {
    await setTabBadge(tab.id, "unsupported");
  }
}

async function handleMessage(
  message: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  if (!isPlainObject(message) || typeof message.type !== "string") {
    return { ok: false, error: toPublicError(new ExtensionError("INTERNAL_ERROR", "不正な操作です。")) };
  }

  if (message.type !== "SET_TAB_STATUS") {
    try {
      await storageIsolationReady;
    } catch (error) {
      return { ok: false, error: toPublicError(error) };
    }
  }

  switch (message.type) {
    case "GET_SETTINGS_OVERVIEW":
      {
        const overview = await settingsRepository.getOverview();
        return {
          ...overview,
          missingPermissionDomains: await findMissingPermissionDomains(
            overview.domains,
          ),
        };
      }

    case "SAVE_SETTINGS": {
      try {
        const saveMessage = message as unknown as SaveSettingsMessage;
        if (saveMessage.apiKey !== undefined && typeof saveMessage.apiKey !== "string") {
          throw new ExtensionError("INTERNAL_ERROR", "APIキーの形式が正しくありません。");
        }
        const settings = normalizeSettings(saveMessage);
        const previousSettings = await settingsRepository.getSettings();
        const apiKeyWasConfigured =
          (await settingsRepository.getApiKey()) !== undefined;
        await assertSitePermissions(settings.domains);
        try {
          // Register first so a registration failure cannot persist settings or
          // an API key while reporting that the save failed.
          await reconcileAutomaticContentScript(settings.domains, true);
          await settingsRepository.saveSettings(settings, saveMessage.apiKey);
          if (saveMessage.apiKey?.trim()) {
            // A request already using the old key may finish, but requests that
            // start after a key rotation must not join that old in-flight work.
            translationWork.invalidate();
          }
        } catch (error) {
          await reconcileAutomaticContentScript(previousSettings.domains).catch(
            () => undefined,
          );
          throw error;
        }
        return {
          ok: true,
          apiKeyConfigured:
            Boolean(saveMessage.apiKey?.trim()) || apiKeyWasConfigured,
        };
      } catch (error) {
        return { ok: false, error: toPublicError(error) };
      }
    }

    case "CLEAR_CACHE":
      try {
        translationWork.invalidate();
        await translationCache.clear();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: toPublicError(error) };
      }

    case "RECONCILE_AUTOMATIC_CONTENT_SCRIPT":
      try {
        const settings = await settingsRepository.getSettings();
        await reconcileAutomaticContentScript(settings.domains, true);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: toPublicError(error) };
      }

    case "TRANSLATE_PAGE":
      return translatePage(message);

    case "SET_TAB_STATUS": {
      if (
        sender.tab?.id !== undefined &&
        typeof message.status === "string" &&
        Object.hasOwn(badgeByStatus, message.status)
      ) {
        await setTabBadge(sender.tab.id, message.status as ContentStatus);
      }
      return { ok: true };
    }

    default:
      return { ok: false, error: toPublicError(new ExtensionError("INTERNAL_ERROR", "不正な操作です。")) };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message, sender).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: toPublicError(error) });
  });
  return true;
});

chrome.action.onClicked.addListener((tab) => {
  void handleActionClick(tab).catch(() => {
    if (tab.id !== undefined) {
      void setTabBadge(tab.id, "error").catch(() => undefined);
    }
  });
});

chrome.runtime.onInstalled.addListener(() => {
  void storageIsolationReady
    .then(() => settingsRepository.getSettings())
    .then((settings) => reconcileAutomaticContentScript(settings.domains))
    .catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  void storageIsolationReady
    .then(() => settingsRepository.getSettings())
    .then((settings) => reconcileAutomaticContentScript(settings.domains))
    .catch(() => undefined);
});

chrome.permissions.onRemoved.addListener(() => {
  void storageIsolationReady
    .then(() => settingsRepository.getSettings())
    .then((settings) => reconcileAutomaticContentScript(settings.domains))
    .catch(() => undefined);
});

chrome.permissions.onAdded.addListener(() => {
  void storageIsolationReady
    .then(() => settingsRepository.getSettings())
    .then((settings) => reconcileAutomaticContentScript(settings.domains))
    .catch(() => undefined);
});

export { handleActionClick, handleMessage, isSupportedPageUrl, translatePage };
