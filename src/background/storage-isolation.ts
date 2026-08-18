import { ExtensionError } from "./errors";

interface StorageAccessController {
  setAccessLevel?: (options: {
    accessLevel: "TRUSTED_CONTEXTS";
  }) => Promise<void>;
}

/**
 * chrome.storage.local is exposed to content scripts unless its access level
 * is narrowed. Treat inability to establish that boundary as a hard failure.
 */
export async function restrictStorageToTrustedContexts(
  storage: StorageAccessController,
): Promise<void> {
  if (typeof storage.setAccessLevel !== "function") {
    throw new ExtensionError(
      "INTERNAL_ERROR",
      "安全なストレージを初期化できませんでした。Chromeを更新して拡張機能を再読み込みしてください。",
    );
  }

  try {
    await storage.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch {
    throw new ExtensionError(
      "INTERNAL_ERROR",
      "安全なストレージを初期化できませんでした。拡張機能を再読み込みしてください。",
    );
  }
}
