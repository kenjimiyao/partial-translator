import {
  canAvoidAdjacentSelection,
  characterTargetTolerance,
  selectClosestCharacterPlan,
  totalSourceCharacters,
} from "../shared/selection";
import type { TranslationPayload, TranslationPromptItem } from "../shared/types";
import { ExtensionError } from "./errors";
import { createResponsesRequestBody } from "./openai";

export interface TranslationChunk {
  items: TranslationPromptItem[];
  targetCharacters: number;
  maxCharacterDeviation: number;
  avoidAdjacent: boolean;
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
  targetCharacters: number;
  avoidAdjacent: boolean;
}

const DEFAULT_LIMITS: ChunkLimits = {
  maxItems: 100,
  maxRequestBytes: 96_000,
  maxSingleRequestBytes: 512_000,
};

const textEncoder = new TextEncoder();

function asPayload(
  items: TranslationPromptItem[],
  context: ChunkPayloadContext,
): TranslationPayload {
  return {
    page_title: context.pageTitle,
    page_url: context.pageUrl,
    // Page-level values are conservative: chunk values never need more digits
    // and request-size differences are otherwise item-driven.
    target_characters: context.targetCharacters,
    // Deliberately wider than any real deviation budget so byte estimation is
    // conservative even when the actual number has more digits than target.
    max_character_deviation: Number.MAX_SAFE_INTEGER,
    avoid_adjacent: context.avoidAdjacent,
    items,
  };
}

export function estimateResponsesRequestBytes(
  items: TranslationPromptItem[],
  context: ChunkPayloadContext,
): number {
  const body = createResponsesRequestBody(asPayload(items, context));
  return textEncoder.encode(JSON.stringify(body)).byteLength;
}

export function splitIntoChunks(
  items: TranslationPromptItem[],
  context: ChunkPayloadContext,
  limits: ChunkLimits = DEFAULT_LIMITS,
): TranslationPromptItem[][] {
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

  const chunks: TranslationPromptItem[][] = [];
  let current: TranslationPromptItem[] = [];

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

export function allocateTargetCharacters(
  chunks: TranslationPromptItem[][],
  targetCharacters: number,
  avoidAdjacent: boolean,
): TranslationChunk[] {
  const totalCharacters = chunks.reduce(
    (sum, chunk) => sum + totalSourceCharacters(chunk),
    0,
  );
  if (targetCharacters < 0) {
    throw new Error("Target characters must not be negative");
  }
  if (totalCharacters === 0 || targetCharacters === 0) {
    return chunks.map((items) => ({
      items,
      targetCharacters: 0,
      maxCharacterDeviation: 0,
      avoidAdjacent: false,
    }));
  }

  const plan = selectClosestCharacterPlan(
    chunks.flat(),
    targetCharacters,
    avoidAdjacent,
  );
  const selectedIds = new Set(plan.map((item) => item.id));

  return chunks.map((items) => {
    const chunkTarget = items.reduce(
      (sum, item) =>
        sum + (selectedIds.has(item.id) ? item.character_count : 0),
      0,
    );
    return {
      items,
      targetCharacters: chunkTarget,
      maxCharacterDeviation: 0,
      avoidAdjacent: avoidAdjacent && chunkTarget > 0,
    };
  });
}

function addBoundaryGaps(
  chunks: TranslationPromptItem[][],
  selectedIds: ReadonlySet<string>,
): TranslationPromptItem[][] {
  const excludedIds = new Set<string>();
  for (let index = 0; index < chunks.length - 1; index += 1) {
    const left = chunks[index].at(-1);
    const right = chunks[index + 1][0];
    if (!left || !right || right.position !== left.position + 1) {
      continue;
    }
    excludedIds.add(selectedIds.has(left.id) ? right.id : left.id);
  }

  return chunks
    .map((chunk) => chunk.filter((item) => !excludedIds.has(item.id)))
    .filter((chunk) => chunk.length > 0);
}

export function createTranslationChunks(
  items: TranslationPromptItem[],
  targetCharacters: number,
  context: Omit<ChunkPayloadContext, "targetCharacters" | "avoidAdjacent">,
  limits?: ChunkLimits,
): TranslationChunk[] {
  const pageAvoidAdjacent = canAvoidAdjacentSelection(items, targetCharacters);
  const completeContext = {
    ...context,
    targetCharacters,
    avoidAdjacent: pageAvoidAdjacent,
  };
  const initialChunks = splitIntoChunks(items, completeContext, limits);

  // Independent API calls cannot coordinate their boundary choices. Leaving
  // one candidate as a gap prevents the last selection in one chunk from being
  // adjacent to the first selection in the next chunk.
  const initialPlan = selectClosestCharacterPlan(
    initialChunks.flat(),
    targetCharacters,
    pageAvoidAdjacent,
  );
  const chunks = pageAvoidAdjacent
    ? addBoundaryGaps(
        initialChunks,
        new Set(initialPlan.map((item) => item.id)),
      )
    : initialChunks;

  const allocatedChunks = allocateTargetCharacters(
    chunks,
    targetCharacters,
    pageAvoidAdjacent,
  );
  const allocatedCharacters = allocatedChunks.reduce(
    (sum, chunk) => sum + chunk.targetCharacters,
    0,
  );
  const pageTolerance = characterTargetTolerance(
    items,
    targetCharacters,
    pageAvoidAdjacent,
  );
  const distributableDeviation = Math.max(
    0,
    pageTolerance - Math.abs(allocatedCharacters - targetCharacters),
  );
  const activeCharacters = allocatedChunks.reduce(
    (sum, chunk) =>
      sum +
      (chunk.targetCharacters > 0 ? totalSourceCharacters(chunk.items) : 0),
    0,
  );
  let cumulativeCharacters = 0;
  let allocatedDeviation = 0;

  return allocatedChunks.map((chunk) => {
    if (chunk.targetCharacters === 0 || activeCharacters === 0) {
      return chunk;
    }
    cumulativeCharacters += totalSourceCharacters(chunk.items);
    const cumulativeDeviation = Math.round(
      (distributableDeviation * cumulativeCharacters) / activeCharacters,
    );
    const maxCharacterDeviation = cumulativeDeviation - allocatedDeviation;
    allocatedDeviation = cumulativeDeviation;
    return { ...chunk, maxCharacterDeviation };
  });
}
