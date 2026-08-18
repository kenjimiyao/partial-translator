import { describe, expect, it } from "vitest";

import {
  allocateTargetCounts,
  createTranslationChunks,
  estimateResponsesRequestBytes,
  splitIntoChunks,
  type ChunkLimits,
} from "../src/background/chunking";

const context = {
  pageTitle: "記事タイトル",
  pageUrl: "https://example.com/article",
  targetCount: 3,
};

function makeItems(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `sentence-${index}`,
    text: `文章${index}です。`,
    section_heading: "",
  }));
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
  it("keeps sentences whole and preserves page order", () => {
    const chunks = createTranslationChunks(
      makeItems(7),
      3,
      context,
      limits({ maxItems: 3 }),
    );
    expect(chunks.flatMap((chunk) => chunk.items.map((item) => item.id))).toEqual(
      makeItems(7).map((item) => item.id),
    );
  });

  it("allocates the exact total and spreads equal remainder quotas", () => {
    const itemChunks = makeItems(4).map((item) => [item]);
    const chunks = allocateTargetCounts(itemChunks, 2);

    expect(chunks.map((chunk) => chunk.targetCount)).toEqual([1, 0, 1, 0]);
    expect(chunks.reduce((sum, chunk) => sum + chunk.targetCount, 0)).toBe(2);
    expect(chunks.every((chunk) => chunk.targetCount <= chunk.items.length)).toBe(true);
  });

  it("uses the complete UTF-8 encoded request body for the soft limit", () => {
    const items = [
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
    ];
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
    const item = {
      id: "sentence-0001",
      text: "非常に長い文章です。".repeat(200),
      section_heading: "",
    };
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
    const item = {
      id: "sentence-0001",
      text: "長すぎる文章です。".repeat(100),
      section_heading: "",
    };
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
