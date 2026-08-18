import type { ExtensionErrorCode, PublicExtensionError } from "../shared/types";

export class ExtensionError extends Error {
  readonly code: ExtensionErrorCode;

  constructor(code: ExtensionErrorCode, message: string) {
    super(message);
    this.name = "ExtensionError";
    this.code = code;
  }
}

export function toPublicError(error: unknown): PublicExtensionError {
  if (error instanceof ExtensionError) {
    return { code: error.code, message: error.message };
  }

  return {
    code: "INTERNAL_ERROR",
    message: "予期しないエラーが発生しました。もう一度お試しください。",
  };
}
