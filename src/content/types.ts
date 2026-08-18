export interface ExtractedSentence {
  id: string;
  text: string;
  sectionHeading: string;
  node: Text;
  start: number;
  end: number;
}

export interface TranslationItem {
  id: string;
  english: string;
}

export interface TranslatePageMessage {
  type: "TRANSLATE_PAGE";
  pageTitle: string;
  pageUrl: string;
  items: Array<{
    id: string;
    text: string;
    section_heading: string;
  }>;
}

export interface TranslatePageSuccess {
  ok: true;
  translations: TranslationItem[];
}

export interface TranslatePageFailure {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type TranslatePageResponse = TranslatePageSuccess | TranslatePageFailure;

export type TabStatus =
  | "processing"
  | "translated"
  | "restored"
  | "error"
  | "empty"
  | "zero";

export interface RuntimeLastError {
  message?: string;
}

export interface ContentRuntime {
  readonly lastError?: RuntimeLastError;
  sendMessage(
    message: unknown,
    callback?: (response: unknown) => void,
  ): Promise<unknown> | void;
  onMessage: {
    addListener(
      listener: (
        message: unknown,
        sender: unknown,
        sendResponse: (response?: unknown) => void,
      ) => boolean | void,
    ): void;
  };
}

export interface ToastPort {
  show(message: string, kind?: "info" | "success" | "error"): void;
}
