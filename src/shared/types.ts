export interface ExtensionSettings {
  translationRate: number;
  domains: string[];
}

export interface TranslationInputItem {
  id: string;
  text: string;
  section_heading: string;
}

export interface Translation {
  id: string;
  english: string;
}

export interface TranslationPayload {
  page_title: string;
  page_url: string;
  target_count: number;
  items: TranslationInputItem[];
}

export type ExtensionErrorCode =
  | "API_KEY_MISSING"
  | "NO_JAPANESE_TEXT"
  | "ZERO_RATE"
  | "API_UNAUTHORIZED"
  | "API_RATE_LIMITED"
  | "API_ERROR"
  | "TIMEOUT"
  | "INVALID_RESPONSE"
  | "UNSUPPORTED_PAGE"
  | "SITE_PERMISSION_MISSING"
  | "INPUT_TOO_LARGE"
  | "DOM_CHANGED"
  | "INTERNAL_ERROR";

export interface PublicExtensionError {
  code: ExtensionErrorCode;
  message: string;
}

export type TranslationResponse =
  | { ok: true; translations: Translation[]; fromCache: boolean }
  | { ok: false; error: PublicExtensionError };
