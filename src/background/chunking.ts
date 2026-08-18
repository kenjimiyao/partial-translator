import type { TranslationInputItem, TranslationPayload } from "../shared/types";
import { ExtensionError } from "./errors";
import { createResponsesRequestBody } from "./openai";

export interface TranslationChunk {
  items: TranslationInputItem[];
  targetCount: number;
}

export interface ChunkLimits {
  maxItems: number;
  /** Soft limit for the complete serialized Responses API request body. */
  maxRequestBytes: number;
  /** A single sentence is never split, but requests above this fail closed. */
  maxSingleRequestBytes: number;
}

export interface ChunkPayloadContext {
  pageTitle: string;
  pageUrl: string;
  targetCount: number;
}

const DEFAULT_LIMITS: ChunkLimits = {
  maxItems: 100,
  maxRequestBytes: 96_000,
  maxSingleRequestBytes: 512_000,
};

const textEncoder = new TextEncoder();

function asPayload(
  items: TranslationInputItem[],
  context: ChunkPayloadContext,
): TranslationPayload {
  return {
    page_title: context.pageTitle,
    page_url: context.pageUrl,
    // The page-level value is conservative: a real chunk allocation never has
    // more digits and request-size differences are otherwise item-driven.
    target_count: context.targetCount,
    items,
  };
}

export function estimateResponsesRequestBytes(
  items: TranslationInputItem[],
  context: ChunkPayloadContext,
): number {
  const body = createResponsesRequestBody(asPayload(items, context));
  return textEncoder.encode(JSON.stringify(body)).byteLength;
}

export function splitIntoChunks(
  items: TranslationInputItem[],
  context: ChunkPayloadContext,
  limits: ChunkLimits = DEFAULT_LIMITS,
): TranslationInputItem[][] {
  if (
    !Number.isInteger(limits.maxItems) ||
    limits.maxItems < 1 ||
    !Number.isFinite(limits.maxRequestBytes) ||
    limits.maxRequestBytes < 1 ||
    !Number.isFinite(limits.maxSingleRequestBytes) ||
    limits.maxSingleRequestBytes < limits.maxRequestBytes
  ) {
    throw new Error("Chunk limits are invalid");
  }

  const chunks: TranslationInputItem[][] = [];
  let current: TranslationInputItem[] = [];

  for (const item of items) {
    const singleRequestBytes = estimateResponsesRequestBytes([item], context);
    if (singleRequestBytes > limits.maxSingleRequestBytes) {
      throw new ExtensionError(
        "INPUT_TOO_LARGE",
        "ページ内の1文章が長すぎるため翻訳できませんでした。本文を短くして再試行してください。",
      );
    }

    const candidate = [...current, item];
    const wouldOverflow =
      current.length > 0 &&
      (current.length >= limits.maxItems ||
        estimateResponsesRequestBytes(candidate, context) >
          limits.maxRequestBytes);

    if (wouldOverflow) {
      chunks.push(current);
      current = [];
    }

    current.push(item);
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

export function allocateTargetCounts(
  chunks: TranslationInputItem[][],
  targetCount: number,
): TranslationChunk[] {
  const totalItems = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (targetCount < 0 || targetCount > totalItems) {
    throw new Error("Target count must fit within the available items");
  }
  if (totalItems === 0 || targetCount === 0) {
    return chunks.map((items) => ({ items, targetCount: 0 }));
  }

  // Rounding cumulative quotas keeps the exact page-level total while
  // distributing equal remainders across the page instead of front-loading
  // them into the earliest chunks.
  let cumulativeItems = 0;
  let allocatedTargets = 0;
  return chunks.map((items) => {
    cumulativeItems += items.length;
    const cumulativeTarget = Math.round(
      (targetCount * cumulativeItems) / totalItems,
    );
    const chunkTarget = cumulativeTarget - allocatedTargets;
    allocatedTargets = cumulativeTarget;
    return { items, targetCount: chunkTarget };
  });
}

export function createTranslationChunks(
  items: TranslationInputItem[],
  targetCount: number,
  context: Omit<ChunkPayloadContext, "targetCount">,
  limits?: ChunkLimits,
): TranslationChunk[] {
  const completeContext = { ...context, targetCount };
  return allocateTargetCounts(
    splitIntoChunks(items, completeContext, limits),
    targetCount,
  );
}
