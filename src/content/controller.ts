import { extractJapaneseSentences } from "./extractor";
import {
  applyTranslations,
  TranslationSession,
  TranslationValidationError,
  validateTranslations,
} from "./translations";
import type {
  ContentRuntime,
  TabStatus,
  ToastPort,
  TranslatePageMessage,
  TranslatePageResponse,
} from "./types";

type ControllerMode = "idle" | "processing" | "translated";

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  MISSING_API_KEY: "OpenAI APIキーが設定されていません。設定画面で保存してください。",
  API_KEY_MISSING: "OpenAI APIキーが設定されていません。設定画面で保存してください。",
  UNAUTHORIZED: "OpenAI APIキーが拒否されました。設定を確認してください。",
  API_UNAUTHORIZED: "OpenAI APIキーが拒否されました。設定を確認してください。",
  OPENAI_UNAUTHORIZED: "OpenAI APIキーが拒否されました。設定を確認してください。",
  RATE_LIMITED: "OpenAI APIの利用上限に達しました。しばらくしてから再試行してください。",
  API_RATE_LIMITED: "OpenAI APIの利用上限に達しました。しばらくしてから再試行してください。",
  OPENAI_RATE_LIMIT: "OpenAI APIの利用上限に達しました。しばらくしてから再試行してください。",
  TIMEOUT: "翻訳がタイムアウトしました。もう一度お試しください。",
  INVALID_RESPONSE: "翻訳サービスから不正な応答が返されました。",
  UNSUPPORTED_PAGE: "このページでは拡張機能を実行できません。",
  MISSING_PERMISSION: "このサイトを翻訳する権限がありません。",
  SITE_PERMISSION_MISSING: "このサイトを翻訳する権限がありません。",
  NETWORK_ERROR: "翻訳サービスへ接続できませんでした。",
  API_ERROR: "OpenAI APIでエラーが発生しました。しばらくしてから再試行してください。",
  INPUT_TOO_LARGE: "ページ内の文章が長すぎるため翻訳できませんでした。",
  DOM_CHANGED: "処理中にページ内容が変更されたため、翻訳を適用できませんでした。",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isTranslatePageResponse(
  value: unknown,
): value is TranslatePageResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return false;
  }
  if (value.ok) {
    return Array.isArray(value.translations);
  }
  return (
    isRecord(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string"
  );
}

export function sendRuntimeMessage<T>(
  runtime: ContentRuntime,
  message: unknown,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const succeed = (response: unknown): void => {
      if (!settled) {
        settled = true;
        resolve(response as T);
      }
    };
    const fail = (error: unknown): void => {
      if (!settled) {
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    try {
      const result = runtime.sendMessage(message, (response) => {
        const lastError = runtime.lastError;
        if (lastError) {
          fail(new Error(lastError.message || "拡張機能との通信に失敗しました。"));
          return;
        }
        succeed(response);
      });
      if (result && typeof result.then === "function") {
        result.then(succeed, fail);
      }
    } catch (error) {
      fail(error);
    }
  });
}

function userFacingError(code: string, message: string): string {
  const known = ERROR_MESSAGES[code];
  if (known) {
    return known;
  }

  const trimmed = message.trim();
  return trimmed
    ? trimmed.slice(0, 240)
    : "翻訳中にエラーが発生しました。もう一度お試しください。";
}

function textPositionAtPoint(
  documentNode: Document,
  x: number,
  y: number,
): { node: Text; offset: number } | undefined {
  const caretDocument = documentNode as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };

  const position = caretDocument.caretPositionFromPoint?.(x, y);
  if (position?.offsetNode.nodeType === Node.TEXT_NODE) {
    return {
      node: position.offsetNode as Text,
      offset: position.offset,
    };
  }

  const range = caretDocument.caretRangeFromPoint?.(x, y);
  if (range?.startContainer.nodeType === Node.TEXT_NODE) {
    return {
      node: range.startContainer as Text,
      offset: range.startOffset,
    };
  }
  return undefined;
}

export class TranslationController {
  private mode: ControllerMode = "idle";
  private session: TranslationSession | undefined;
  private statusQueue: Promise<void> = Promise.resolve();
  private interactionVersion = 0;

  constructor(
    private readonly runtime: ContentRuntime,
    private readonly toast: ToastPort,
    private readonly documentNode: Document = document,
    private readonly pageUrl: () => string = () => location.href,
  ) {}

  get currentMode(): ControllerMode {
    return this.mode;
  }

  handlePageClick(event: MouseEvent): boolean {
    if (this.mode !== "translated" || !this.session) {
      return false;
    }

    const position = textPositionAtPoint(
      this.documentNode,
      event.clientX,
      event.clientY,
    );
    if (!position) {
      return false;
    }

    const result = this.session.restoreAt(position.node, position.offset);
    if (result === "none") {
      return false;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    const interactionVersion = ++this.interactionVersion;

    if (result === "conflict") {
      void this.reportClickedRestoreConflict(interactionVersion);
      return true;
    }

    const fullyRestored = !this.session.hasActiveTranslations;
    if (fullyRestored) {
      this.session = undefined;
      this.mode = "idle";
    }
    void this.reportClickedRestore(fullyRestored, interactionVersion);
    return true;
  }

  async toggle(): Promise<void> {
    if (this.mode === "processing") {
      this.toast.show("翻訳処理中です。", "info");
      return;
    }

    if (this.mode === "translated" && this.session) {
      const interactionVersion = ++this.interactionVersion;
      const fullyRestored = this.session.restore();
      if (!fullyRestored) {
        await this.setStatus("error");
        if (this.interactionVersion === interactionVersion) {
          this.toast.show(
            "ページ内容が更新されたため、一部の文章を復元できませんでした。ページを再読み込みしてください。",
            "error",
          );
        }
        return;
      }
      this.session = undefined;
      this.mode = "idle";
      await this.setStatus("restored");
      if (this.interactionVersion === interactionVersion) {
        this.toast.show("日本語表示に戻しました。", "success");
      }
      return;
    }

    await this.translate();
  }

  async translate(): Promise<void> {
    if (this.mode !== "idle") {
      return;
    }
    const interactionVersion = ++this.interactionVersion;

    const root = this.documentNode.body ?? this.documentNode.documentElement;
    const candidates = extractJapaneseSentences(root);
    const requestPageTitle = this.documentNode.title;
    const requestPageUrl = this.pageUrl();
    if (candidates.length === 0) {
      await this.setStatus("empty");
      this.toast.show("翻訳対象の日本語文章が見つかりませんでした。", "info");
      return;
    }

    this.mode = "processing";
    this.toast.show("日本語の文章を翻訳しています…", "info");

    const message: TranslatePageMessage = {
      type: "TRANSLATE_PAGE",
      pageTitle: requestPageTitle,
      pageUrl: requestPageUrl,
      items: candidates.map(({ id, text, sectionHeading }) => ({
        id,
        text,
        section_heading: sectionHeading,
      })),
    };

    try {
      await this.setStatus("processing");
      if (this.pageUrl() !== requestPageUrl) {
        throw new TranslationValidationError(
          "処理中にページが移動したため、翻訳を開始できませんでした。",
        );
      }

      const response = await sendRuntimeMessage<unknown>(this.runtime, message);
      if (!isTranslatePageResponse(response)) {
        throw new Error("翻訳サービスから不正な応答が返されました。");
      }
      if (!response.ok) {
        if (response.error.code === "ZERO_RATE") {
          this.mode = "idle";
          await this.setStatus("zero");
          this.toast.show("翻訳率が0%のため、文章は変更されませんでした。", "info");
          return;
        }
        if (response.error.code === "NO_JAPANESE_TEXT") {
          this.mode = "idle";
          await this.setStatus("empty");
          this.toast.show("翻訳対象の日本語文章が見つかりませんでした。", "info");
          return;
        }
        throw new BackgroundTranslationError(
          response.error.code,
          response.error.message,
        );
      }

      if (this.pageUrl() !== message.pageUrl) {
        throw new TranslationValidationError(
          "処理中にページが移動したため、翻訳を適用できませんでした。",
        );
      }

      const translations = validateTranslations(
        candidates,
        response.translations,
      );
      if (translations.length === 0) {
        this.mode = "idle";
        await this.setStatus("zero");
        this.toast.show("翻訳率が0%のため、文章は変更されませんでした。", "info");
        return;
      }

      const session = applyTranslations(candidates, translations);
      this.session = session;
      this.mode = "translated";
      await this.setStatus("translated");
      if (
        this.interactionVersion !== interactionVersion ||
        this.mode !== "translated" ||
        this.session !== session
      ) {
        return;
      }
      this.toast.show(
        `${translations.length}件の文章を英語に置き換えました。英語の文章をクリックすると、その文章だけ日本語に戻せます。`,
        "success",
      );
    } catch (error) {
      this.mode = "idle";
      this.session = undefined;
      await this.setStatus("error");
      if (error instanceof BackgroundTranslationError) {
        this.toast.show(userFacingError(error.code, error.message), "error");
      } else {
        this.toast.show(
          error instanceof Error && error.message
            ? error.message.slice(0, 240)
            : "翻訳中にエラーが発生しました。",
          "error",
        );
      }
    }
  }

  private async setStatus(status: TabStatus): Promise<void> {
    const operation = this.statusQueue.then(async () => {
      try {
        await sendRuntimeMessage(this.runtime, {
          type: "SET_TAB_STATUS",
          status,
        });
      } catch {
        // A navigation can tear down the service worker connection. Status is best effort.
      }
    });
    this.statusQueue = operation;
    await operation;
  }

  private async reportClickedRestore(
    fullyRestored: boolean,
    interactionVersion: number,
  ): Promise<void> {
    await this.setStatus(fullyRestored ? "restored" : "translated");
    if (this.interactionVersion !== interactionVersion) {
      return;
    }
    this.toast.show(
      fullyRestored
        ? "すべての文章を日本語に戻しました。"
        : "クリックした文章を日本語に戻しました。",
      "success",
    );
  }

  private async reportClickedRestoreConflict(
    interactionVersion: number,
  ): Promise<void> {
    await this.setStatus("error");
    if (this.interactionVersion === interactionVersion) {
      this.toast.show(
        "ページ内容が更新されたため、この文章を復元できませんでした。ページを再読み込みしてください。",
        "error",
      );
    }
  }
}

class BackgroundTranslationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BackgroundTranslationError";
  }
}
