import { CONTENT_SCRIPT_ID } from "../shared/constants";
import { domainToMatchPatterns } from "../shared/domain";
import { ExtensionError } from "./errors";

let registrationQueue: Promise<void> = Promise.resolve();

function uniqueMatchPatterns(domains: string[]): string[] {
  return [...new Set(domains.flatMap((domain) => domainToMatchPatterns(domain)))];
}

async function grantedMatchPatterns(matches: string[]): Promise<{
  granted: string[];
  missing: string[];
}> {
  const checks = await Promise.all(
    matches.map(async (origin) => ({
      origin,
      granted: await chrome.permissions.contains({ origins: [origin] }),
    })),
  );
  return {
    granted: checks.filter((check) => check.granted).map((check) => check.origin),
    missing: checks.filter((check) => !check.granted).map((check) => check.origin),
  };
}

async function reconcile(domains: string[], requireAllPermissions: boolean): Promise<void> {
  const requestedMatches = uniqueMatchPatterns(domains);
  const { granted: matches, missing } = await grantedMatchPatterns(requestedMatches);
  const existing = await chrome.scripting.getRegisteredContentScripts({
    ids: [CONTENT_SCRIPT_ID],
  });

  if (matches.length === 0) {
    if (existing.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    }
    if (requireAllPermissions && missing.length > 0) {
      throw new ExtensionError(
        "SITE_PERMISSION_MISSING",
        "自動翻訳対象サイトの権限がありません。設定を保存し直してください。",
      );
    }
    return;
  }

  const script: chrome.scripting.RegisteredContentScript = {
    id: CONTENT_SCRIPT_ID,
    js: ["content.js"],
    matches,
    allFrames: false,
    runAt: "document_idle",
    persistAcrossSessions: true,
  };

  if (existing.length === 0) {
    await chrome.scripting.registerContentScripts([script]);
  } else {
    await chrome.scripting.updateContentScripts([script]);
  }

  if (requireAllPermissions && missing.length > 0) {
    throw new ExtensionError(
      "SITE_PERMISSION_MISSING",
      "一部の自動翻訳対象サイトに権限がありません。設定を保存し直してください。",
    );
  }
}

export function reconcileAutomaticContentScript(
  domains: string[],
  requireAllPermissions = false,
): Promise<void> {
  const operation = registrationQueue.then(
    () => reconcile(domains, requireAllPermissions),
    () => reconcile(domains, requireAllPermissions),
  );
  registrationQueue = operation.catch(() => undefined);
  return operation;
}
