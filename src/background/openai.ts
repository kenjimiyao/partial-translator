import {
  API_TIMEOUT_MS,
  MODEL_NAME,
  TRANSLATION_INSTRUCTIONS,
} from "../shared/constants";
import {
  characterTargetTolerance,
  totalSourceCharacters,
} from "../shared/selection";
import type {
  Translation,
  TranslationPayload,
  TranslationPromptItem,
} from "../shared/types";
import { ExtensionError } from "./errors";

const TRANSLATION_SCHEMA = {
  type: "object",
  properties: {
    translations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          english: { type: "string" },
        },
        required: ["id", "english"],
        additionalProperties: false,
      },
    },
  },
  required: ["translations"],
  additionalProperties: false,
} as const;

interface ResponsesApiContent {
  type?: unknown;
  text?: unknown;
}

interface ResponsesApiOutput {
  type?: unknown;
  content?: unknown;
}

export interface RequestOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateTranslations(
  value: unknown,
  inputItems: TranslationPromptItem[],
  targetCharacters: number,
  avoidAdjacent: boolean,
  maxCharacterDeviation?: number,
): Translation[] {
  if (!isPlainObject(value) || !Array.isArray(value.translations)) {
    throw new ExtensionError("INVALID_RESPONSE", "OpenAI APIから不正なレスポンスを受信しました。");
  }

  if (targetCharacters > 0 && value.translations.length === 0) {
    throw new ExtensionError("INVALID_RESPONSE", "OpenAI APIの翻訳件数が正しくありません。");
  }

  const itemById = new Map(inputItems.map((item) => [item.id, item]));
  const seenIds = new Set<string>();
  const translations: Translation[] = [];

  for (const candidate of value.translations) {
    if (
      !isPlainObject(candidate) ||
      typeof candidate.id !== "string" ||
      typeof candidate.english !== "string"
    ) {
      throw new ExtensionError("INVALID_RESPONSE", "OpenAI APIから不正なレスポンスを受信しました。");
    }
    if (!itemById.has(candidate.id) || seenIds.has(candidate.id)) {
      throw new ExtensionError("INVALID_RESPONSE", "OpenAI APIの翻訳IDが正しくありません。");
    }
    if (candidate.english.trim().length === 0) {
      throw new ExtensionError("INVALID_RESPONSE", "OpenAI APIから空の翻訳を受信しました。");
    }

    seenIds.add(candidate.id);
    translations.push({ id: candidate.id, english: candidate.english.trim() });
  }

  const selectedItems = translations.map((translation) => itemById.get(translation.id)!);
  const selectedCharacters = totalSourceCharacters(selectedItems);
  const availableCharacters = totalSourceCharacters(inputItems);
  const tolerance = maxCharacterDeviation ?? characterTargetTolerance(
    inputItems,
    targetCharacters,
    avoidAdjacent,
  );
  if (
    (targetCharacters >= availableCharacters && selectedCharacters !== availableCharacters) ||
    Math.abs(selectedCharacters - targetCharacters) > tolerance
  ) {
    throw new ExtensionError(
      "INVALID_RESPONSE",
      "OpenAI APIの翻訳文字数が指定割合から外れています。",
    );
  }

  if (avoidAdjacent) {
    const selectedPositions = new Set(selectedItems.map((item) => item.position));
    if (
      [...selectedPositions].some(
        (position) => selectedPositions.has(position + 1),
      )
    ) {
      throw new ExtensionError(
        "INVALID_RESPONSE",
        "OpenAI APIが連続する文章を選択しました。",
      );
    }
  }

  return translations;
}

function extractOutputText(response: unknown): string {
  if (
    !isPlainObject(response) ||
    response.status !== "completed" ||
    !Array.isArray(response.output)
  ) {
    throw new ExtensionError("INVALID_RESPONSE", "OpenAI APIの応答が完了しませんでした。");
  }

  const texts: string[] = [];
  for (const output of response.output as ResponsesApiOutput[]) {
    if (output?.type !== "message" || !Array.isArray(output.content)) {
      continue;
    }
    for (const content of output.content as ResponsesApiContent[]) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        texts.push(content.text);
      }
    }
  }

  if (texts.length !== 1) {
    throw new ExtensionError("INVALID_RESPONSE", "OpenAI APIから翻訳データを取得できませんでした。");
  }
  return texts[0];
}

export function createResponsesRequestBody(
  payload: TranslationPayload,
): Record<string, unknown> {
  return {
    model: MODEL_NAME,
    reasoning: { effort: "none" },
    store: false,
    instructions: TRANSLATION_INSTRUCTIONS,
    input: JSON.stringify(payload),
    text: {
      format: {
        type: "json_schema",
        name: "n_percent_english_translations",
        strict: true,
        schema: TRANSLATION_SCHEMA,
      },
    },
  };
}

async function fetchOnce(
  apiKey: string,
  payload: TranslationPayload,
  options: RequestOptions,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (options.signal?.aborted) {
    controller.abort();
  } else {
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? API_TIMEOUT_MS);

  try {
    if (controller.signal.aborted) {
      throw new ExtensionError("TIMEOUT", "翻訳処理の制限時間を超えました。");
    }
    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createResponsesRequestBody(payload)),
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new ExtensionError(
          "API_UNAUTHORIZED",
          "OpenAI APIキーが無効です。設定画面で確認してください。",
        );
      }
      if (response.status === 429) {
        throw new ExtensionError(
          "API_RATE_LIMITED",
          "OpenAI APIの利用上限に達しました。時間をおいて再試行してください。",
        );
      }
      throw new ExtensionError(
        "API_ERROR",
        `OpenAI APIでエラーが発生しました（HTTP ${response.status}）。`,
      );
    }

    try {
      return (await response.json()) as unknown;
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        throw error;
      }
      throw new ExtensionError(
        "INVALID_RESPONSE",
        "OpenAI APIから不正なレスポンスを受信しました。",
      );
    }
  } catch (error) {
    if (error instanceof ExtensionError) {
      throw error;
    }
    if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw new ExtensionError("TIMEOUT", "OpenAI APIへの接続がタイムアウトしました。");
    }
    throw new ExtensionError("API_ERROR", "OpenAI APIへ接続できませんでした。");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function requestTranslations(
  apiKey: string,
  payload: TranslationPayload,
  options: RequestOptions = {},
): Promise<Translation[]> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const rawResponse = await fetchOnce(apiKey, payload, options);
      const outputText = extractOutputText(rawResponse);
      const parsed = JSON.parse(outputText) as unknown;
      return validateTranslations(
        parsed,
        payload.items,
        payload.target_characters,
        payload.avoid_adjacent,
        payload.max_character_deviation,
      );
    } catch (error) {
      const isValidationFailure =
        error instanceof SyntaxError ||
        (error instanceof ExtensionError && error.code === "INVALID_RESPONSE");
      if (!isValidationFailure || attempt === 1) {
        if (error instanceof ExtensionError) {
          throw error;
        }
        throw new ExtensionError("INVALID_RESPONSE", "OpenAI APIから不正なレスポンスを受信しました。");
      }
    }
  }

  throw new ExtensionError("INVALID_RESPONSE", "OpenAI APIから不正なレスポンスを受信しました。");
}
