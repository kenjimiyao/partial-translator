import "./styles.css";

import {
  domainIncludes,
  domainsToMatchPatterns,
  minimizeDomains,
  parseDomainLines,
  type DomainInputError,
} from "../shared/domain";
import { permissionRollbackPlanForDomain } from "../shared/permission-pattern";

interface SettingsOverview {
  translationRate: number;
  domains: string[];
  apiKeyConfigured: boolean;
  missingPermissionDomains: string[];
}

interface RuntimeErrorDetails {
  code?: string;
  message?: string;
}

interface RuntimeActionResponse {
  ok: boolean;
  error?: RuntimeErrorDetails | string;
}

type StatusKind = "success" | "error" | "info";

const form = requireElement<HTMLFormElement>("settings-form");
const apiKeyInput = requireElement<HTMLInputElement>("api-key");
const apiKeyState = requireElement<HTMLSpanElement>("api-key-state");
const toggleApiKeyButton = requireElement<HTMLButtonElement>("toggle-api-key");
const rateSlider = requireElement<HTMLInputElement>("translation-rate-slider");
const rateNumber = requireElement<HTMLInputElement>("translation-rate-number");
const domainsTextarea = requireElement<HTMLTextAreaElement>("domains");
const domainErrors = requireElement<HTMLDivElement>("domains-errors");
const saveButton = requireElement<HTMLButtonElement>("save-settings");
const clearCacheButton = requireElement<HTMLButtonElement>("clear-cache");
const statusMessage = requireElement<HTMLDivElement>("status-message");

let savedDomains: string[] = [];
let apiKeyConfigured = false;

toggleApiKeyButton.addEventListener("click", () => {
  const shouldShow = apiKeyInput.type === "password";
  apiKeyInput.type = shouldShow ? "text" : "password";
  toggleApiKeyButton.textContent = shouldShow ? "非表示" : "表示";
  toggleApiKeyButton.setAttribute("aria-pressed", String(shouldShow));
  apiKeyInput.focus();
});

rateSlider.addEventListener("input", () => {
  rateNumber.value = rateSlider.value;
});

rateNumber.addEventListener("input", () => {
  const value = Number(rateNumber.value);
  if (Number.isInteger(value) && value >= 0 && value <= 100) {
    rateSlider.value = String(value);
  }
});

rateNumber.addEventListener("blur", () => {
  const rate = readTranslationRate(false);
  if (rate !== null) {
    setTranslationRate(rate);
  }
});

domainsTextarea.addEventListener("input", () => {
  if (!domainErrors.hidden) {
    renderDomainErrors(parseDomainLines(domainsTextarea.value).errors);
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const translationRate = readTranslationRate(true);
  const parsed = parseDomainLines(domainsTextarea.value);
  renderDomainErrors(parsed.errors);

  if (translationRate === null || parsed.errors.length > 0) {
    showStatus("入力内容を確認してください。", "error");
    return;
  }

  const domains = minimizeDomains(parsed.domains);
  const nextPatterns = domainsToMatchPatterns(domains);

  // Both calls start directly in the submit user gesture. There is no awaited
  // operation before request(), or Chrome would reject the permission prompt.
  // The snapshot lets us roll back only grants acquired by a failed save.
  const permissionsBeforeRequest = chrome.permissions
    .getAll()
    .catch(() => undefined);
  // Request every current origin so saving also repairs permissions the user
  // may have revoked from Chrome's extension settings.
  const permissionRequest = nextPatterns.length
    ? chrome.permissions.request({ origins: nextPatterns })
    : Promise.resolve(true);

  void saveSettings({
    translationRate,
    domains,
    permissionRequest,
    permissionsBeforeRequest,
  });
});

clearCacheButton.addEventListener("click", () => {
  void clearTranslationCache();
});

void loadSettings();

async function loadSettings(): Promise<void> {
  setFormBusy(true);
  showStatus("設定を読み込んでいます…", "info");

  try {
    const response = (await chrome.runtime.sendMessage({
      type: "GET_SETTINGS_OVERVIEW",
    })) as SettingsOverview | RuntimeActionResponse | undefined;

    if (!isSettingsOverview(response)) {
      throw new Error(getRuntimeErrorMessage(response, "設定を読み込めませんでした。"));
    }

    const rate = normalizeStoredRate(response.translationRate);
    savedDomains = minimizeValidStoredDomains(response.domains);
    apiKeyConfigured = response.apiKeyConfigured;

    setTranslationRate(rate);
    domainsTextarea.value = savedDomains.join("\n");
    updateApiKeyState();
    if (response.missingPermissionDomains.length > 0) {
      showStatus(
        `サイト権限がない自動翻訳対象があります（${response.missingPermissionDomains.join(
          "、",
        )}）。設定を保存し直して権限を許可してください。`,
        "error",
      );
    } else {
      hideStatus();
    }
  } catch (error) {
    setTranslationRate(20);
    savedDomains = [];
    apiKeyConfigured = false;
    updateApiKeyState();
    showStatus(safeErrorMessage(error, "設定を読み込めませんでした。"), "error");
  } finally {
    setFormBusy(false);
  }
}

async function saveSettings(options: {
  translationRate: number;
  domains: string[];
  permissionRequest: Promise<boolean>;
  permissionsBeforeRequest: Promise<chrome.permissions.Permissions | undefined>;
}): Promise<void> {
  setFormBusy(true);
  showStatus("サイト権限を確認しています…", "info");

  let rollbackOrigins: string[] = [];
  let rollbackHasUnsafeOverlap = false;
  let confirmedSaveFailure = false;

  try {
    const [permissionGranted, permissionsBeforeRequest] = await Promise.all([
      options.permissionRequest,
      options.permissionsBeforeRequest,
    ]);
    if (!permissionGranted) {
      throw new Error(
        "サイト権限が許可されなかったため、設定を保存していません。対象ドメインの自動翻訳には権限が必要です。",
      );
    }

    if (permissionsBeforeRequest?.origins) {
      const rollbackPlans = options.domains.map((domain) =>
        permissionRollbackPlanForDomain(
          permissionsBeforeRequest.origins ?? [],
          domain,
        ),
      );
      rollbackOrigins = rollbackPlans.flatMap((plan) => plan.origins);
      rollbackHasUnsafeOverlap = rollbackPlans.some(
        (plan) => plan.hasUnsafeOverlap,
      );
    }

    const newApiKey = apiKeyInput.value.trim();
    const request: {
      type: "SAVE_SETTINGS";
      translationRate: number;
      domains: string[];
      apiKey?: string;
    } = {
      type: "SAVE_SETTINGS",
      translationRate: options.translationRate,
      domains: options.domains,
    };

    if (newApiKey) {
      request.apiKey = newApiKey;
    }

    showStatus("設定を保存しています…", "info");
    const response = (await chrome.runtime.sendMessage(request)) as
      | RuntimeActionResponse
      | undefined;

    if (!response?.ok) {
      confirmedSaveFailure = response !== undefined;
      throw new Error(getRuntimeErrorMessage(response, "設定を保存できませんでした。"));
    }

    const narrowedParentDomains = savedDomains.filter(
      (savedDomain) =>
        !options.domains.includes(savedDomain) &&
        options.domains.some((nextDomain) =>
          domainIncludes(savedDomain, nextDomain),
        ),
    );
    const narrowedParentSet = new Set(narrowedParentDomains);
    const removableDomains = savedDomains.filter(
      (savedDomain) =>
        !options.domains.includes(savedDomain) &&
        !narrowedParentSet.has(savedDomain),
    );
    const originsToRemove = domainsToMatchPatterns(removableDomains);

    let removalWarning = "";
    if (narrowedParentDomains.length > 0) {
      removalWarning =
        " 自動実行範囲は狭まりましたが、Chromeの仕様上、包含元のサイト権限は残しています。権限も狭める場合はChromeの拡張機能サイト設定で旧権限を削除し、もう一度保存してください。";
    }
    if (originsToRemove.length > 0) {
      try {
        const removed = await chrome.permissions.remove({ origins: originsToRemove });
        if (!removed) {
          removalWarning =
            " 以前のサイト権限の一部を削除できませんでした。拡張機能のサイト設定から確認できます。";
        }
      } catch {
        removalWarning =
          " 以前のサイト権限の一部を削除できませんでした。拡張機能のサイト設定から確認できます。";
      }
    }

    savedDomains = [...options.domains];
    domainsTextarea.value = savedDomains.join("\n");
    if (newApiKey) {
      apiKeyConfigured = true;
      // Do not leave the plaintext key in the options page DOM after saving.
      apiKeyInput.value = "";
      apiKeyInput.type = "password";
      toggleApiKeyButton.textContent = "表示";
      toggleApiKeyButton.setAttribute("aria-pressed", "false");
    }
    updateApiKeyState();
    renderDomainErrors([]);
    const statusSuffix = removalWarning;
    showStatus(
      `設定を保存しました。${statusSuffix}`,
      removalWarning ? "info" : "success",
    );
  } catch (error) {
    let rollbackWarning = "";
    if (confirmedSaveFailure && rollbackHasUnsafeOverlap) {
      rollbackWarning =
        " 既存権限と範囲が重なるサイトでは、既存権限を消さないため新しく広がった権限の一部を自動で元に戻していません。Chromeの拡張機能サイト設定を確認してください。";
    }
    if (confirmedSaveFailure && rollbackOrigins.length > 0) {
      try {
        const removed = await chrome.permissions.remove({ origins: rollbackOrigins });
        if (!removed) {
          rollbackWarning =
            " 取得したサイト権限を元に戻せなかったため、Chromeの拡張機能サイト設定を確認してください。";
        }
      } catch {
        rollbackWarning =
          " 取得したサイト権限を元に戻せなかったため、Chromeの拡張機能サイト設定を確認してください。";
      }
    }
    showStatus(
      `${safeErrorMessage(error, "設定を保存できませんでした。")}${rollbackWarning}`,
      "error",
    );
  } finally {
    setFormBusy(false);
  }
}

async function clearTranslationCache(): Promise<void> {
  setFormBusy(true);
  showStatus("翻訳キャッシュを削除しています…", "info");

  try {
    const response = (await chrome.runtime.sendMessage({ type: "CLEAR_CACHE" })) as
      | RuntimeActionResponse
      | undefined;
    if (!response?.ok) {
      throw new Error(
        getRuntimeErrorMessage(response, "翻訳キャッシュを削除できませんでした。"),
      );
    }
    showStatus("翻訳キャッシュを削除しました。", "success");
  } catch (error) {
    showStatus(
      safeErrorMessage(error, "翻訳キャッシュを削除できませんでした。"),
      "error",
    );
  } finally {
    setFormBusy(false);
  }
}

function readTranslationRate(reportError: boolean): number | null {
  const value = Number(rateNumber.value);
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    rateNumber.setAttribute("aria-invalid", "true");
    if (reportError) {
      showStatus("翻訳率は0〜100の整数で入力してください。", "error");
    }
    return null;
  }

  rateNumber.removeAttribute("aria-invalid");
  return value;
}

function setTranslationRate(rate: number): void {
  const value = String(rate);
  rateSlider.value = value;
  rateNumber.value = value;
  rateNumber.removeAttribute("aria-invalid");
}

function normalizeStoredRate(rate: number): number {
  return Number.isInteger(rate) && rate >= 0 && rate <= 100 ? rate : 20;
}

function minimizeValidStoredDomains(domains: unknown): string[] {
  if (!Array.isArray(domains)) {
    return [];
  }

  const valid: string[] = [];
  for (const domain of domains) {
    if (typeof domain !== "string") {
      continue;
    }
    const parsed = parseDomainLines(domain);
    if (parsed.errors.length === 0) {
      valid.push(...parsed.domains);
    }
  }
  return minimizeDomains(valid);
}

function renderDomainErrors(errors: DomainInputError[]): void {
  if (errors.length === 0) {
    domainErrors.hidden = true;
    domainErrors.replaceChildren();
    domainsTextarea.removeAttribute("aria-invalid");
    return;
  }

  const heading = document.createElement("p");
  heading.textContent = "入力できないドメインがあります。";
  const list = document.createElement("ul");
  for (const error of errors) {
    const item = document.createElement("li");
    item.textContent = `${error.line}行目（${error.value}）: ${error.message}`;
    list.append(item);
  }
  domainErrors.replaceChildren(heading, list);
  domainErrors.hidden = false;
  domainsTextarea.setAttribute("aria-invalid", "true");
}

function updateApiKeyState(): void {
  apiKeyState.textContent = apiKeyConfigured ? "保存済み" : "未設定";
  apiKeyState.classList.toggle("state-badge--set", apiKeyConfigured);
  apiKeyState.classList.toggle("state-badge--unset", !apiKeyConfigured);
  apiKeyInput.placeholder = apiKeyConfigured ? "変更する場合のみ入力" : "sk-...";
}

function setFormBusy(busy: boolean): void {
  saveButton.disabled = busy;
  clearCacheButton.disabled = busy;
  rateSlider.disabled = busy;
  rateNumber.disabled = busy;
  domainsTextarea.disabled = busy;
  apiKeyInput.disabled = busy;
  toggleApiKeyButton.disabled = busy;
}

function showStatus(message: string, kind: StatusKind): void {
  statusMessage.textContent = message;
  statusMessage.className = `status-message status-message--${kind}`;
  statusMessage.hidden = false;
}

function hideStatus(): void {
  statusMessage.hidden = true;
  statusMessage.textContent = "";
}

function getRuntimeErrorMessage(
  response: RuntimeActionResponse | undefined,
  fallback: string,
): string {
  if (!response || !("error" in response)) {
    return fallback;
  }
  if (typeof response.error === "string") {
    return response.error || fallback;
  }
  return response.error?.message || fallback;
}

function safeErrorMessage(error: unknown, fallback: string): string {
  // Background responses are responsible for redacting secrets and page text.
  // Locally generated errors never interpolate form values.
  return error instanceof Error && error.message ? error.message : fallback;
}

function isSettingsOverview(value: unknown): value is SettingsOverview {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<SettingsOverview>;
  return (
    typeof candidate.translationRate === "number" &&
    Array.isArray(candidate.domains) &&
    typeof candidate.apiKeyConfigured === "boolean" &&
    Array.isArray(candidate.missingPermissionDomains) &&
    candidate.missingPermissionDomains.every((domain) => typeof domain === "string")
  );
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Options page element is missing: ${id}`);
  }
  return element as T;
}
