import { describe, expect, it } from "vitest";

import {
  allocateTargetCharacters,
  createTranslationChunks,
  estimateResponsesRequestBytes,
  splitIntoChunks,
  type ChunkLimits,
} from "../src/background/chunking";
import { addSelectionMetadata } from "../src/shared/selection";

const context = {
  pageTitle: "記事タイトル",
  pageUrl: "https://example.com/article",
  targetCharacters: 30,
  avoidAdjacent: true,
};

function makeItems(count: number) {
  return addSelectionMetadata(Array.from({ length: count }, (_, index) => ({
    id: `sentence-${index}`,
    text: `文章${index}です。`,
    section_heading: "",
  })));
}

function limits(overrides: Partial<ChunkLimits>): ChunkLimits {
  return {
    maxItems: 100,
    maxRequestBytes: 1_000_000,
    maxSingleRequestBytes: 2_000_000,
    ...overrides,
  };
}

describe("translation chunking", () => {
  it("keeps sentences whole and leaves safe gaps at request boundaries", () => {
    const chunks = createTranslationChunks(
      makeItems(7),
      14,
      context,
      limits({ maxItems: 3 }),
    );
    expect(chunks.flatMap((chunk) => chunk.items.map((item) => item.id))).toEqual([
      "sentence-0",
      "sentence-1",
      "sentence-3",
      "sentence-4",
      "sentence-5",
    ]);
  });

  it("allocates the exact character total and spreads active chunks", () => {
    const itemChunks = makeItems(4).map((item) => [item]);
    const chunks = allocateTargetCharacters(itemChunks, 10, true);

    expect(chunks.map((chunk) => chunk.targetCharacters)).toEqual([0, 6, 0, 6]);
    expect(chunks.reduce((sum, chunk) => sum + chunk.targetCharacters, 0)).toBe(12);
  });

  it("does not force one sentence from every chunk at very low rates", () => {
    const itemChunks = makeItems(10).map((item) => [item]);
    const chunks = allocateTargetCharacters(itemChunks, 1, true);

    expect(chunks.filter((chunk) => chunk.targetCharacters > 0)).toHaveLength(1);
    expect(chunks.reduce((sum, chunk) => sum + chunk.targetCharacters, 0)).toBe(6);
  });

  it("allocates a page-optimal sentence instead of proportional chunk quotas", () => {
    const candidates = addSelectionMetadata(
      [60, 100, 60, 60].map((length, index) => ({
        id: `sentence-${index}`,
        text: "文".repeat(length),
        section_heading: "",
      })),
    );
    const chunks = createTranslationChunks(
      candidates,
      100,
      context,
      limits({ maxItems: 2 }),
    );

    expect(chunks.flatMap((chunk) => chunk.items.map((item) => item.id))).toContain(
      "sentence-1",
    );
    expect(chunks.map((chunk) => chunk.targetCharacters)).toEqual([100, 0]);
  });

  it("shares one page-level deviation budget across active chunks", () => {
    const candidates = addSelectionMetadata(
      Array.from({ length: 8 }, (_, index) => ({
        id: `sentence-${index}`,
        text: "文".repeat(10),
        section_heading: "",
      })),
    );
    const chunks = createTranslationChunks(
      candidates,
      20,
      context,
      limits({ maxItems: 2 }),
    );

    expect(chunks.reduce(
      (sum, chunk) => sum + chunk.maxCharacterDeviation,
      0,
    )).toBe(2);
  });

  it("uses the complete UTF-8 encoded request body for the soft limit", () => {
    const items = addSelectionMetadata([
      {
        id: "sentence-0001-with-a-long-id",
        text: `日本語と絵文字😀${'"\\'.repeat(40)}`,
        section_heading: `見出し${'"'.repeat(20)}`,
      },
      {
        id: "sentence-0002-with-a-long-id",
        text: `次の日本語😀${'"\\'.repeat(40)}`,
        section_heading: "別の見出し",
      },
    ]);
    const oneItemBytes = estimateResponsesRequestBytes([items[0]], context);
    const bothItemsBytes = estimateResponsesRequestBytes(items, context);
    expect(bothItemsBytes).toBeGreaterThan(oneItemBytes);

    const chunks = splitIntoChunks(
      items,
      context,
      limits({
        maxRequestBytes: bothItemsBytes - 1,
        maxSingleRequestBytes: bothItemsBytes * 2,
      }),
    );

    expect(chunks).toEqual([[items[0]], [items[1]]]);
    expect(
      chunks.every(
        (chunk) =>
          estimateResponsesRequestBytes(chunk, context) < bothItemsBytes,
      ),
    ).toBe(true);
  });

  it("keeps one oversized sentence whole when it is below the hard limit", () => {
    const [item] = addSelectionMetadata([{
      id: "sentence-0001",
      text: "非常に長い文章です。".repeat(200),
      section_heading: "",
    }]);
    const requestBytes = estimateResponsesRequestBytes([item], context);

    const chunks = splitIntoChunks(
      [item],
      context,
      limits({
        maxRequestBytes: requestBytes - 1,
        maxSingleRequestBytes: requestBytes,
      }),
    );

    expect(chunks).toEqual([[item]]);
    expect(chunks[0][0].text).toBe(item.text);
  });

  it("fails closed before fetch for a single request above the hard limit", () => {
    const [item] = addSelectionMetadata([{
      id: "sentence-0001",
      text: "長すぎる文章です。".repeat(100),
      section_heading: "",
    }]);
    const requestBytes = estimateResponsesRequestBytes([item], context);

    expect(() =>
      splitIntoChunks(
        [item],
        context,
        limits({
          maxRequestBytes: requestBytes - 2,
          maxSingleRequestBytes: requestBytes - 1,
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "INPUT_TOO_LARGE" }));
  });
});
