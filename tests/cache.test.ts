import { describe, expect, it } from "vitest";

import {
  createCacheKey,
  TranslationCache,
  type StorageAreaLike,
} from "../src/background/cache";

class MemoryStorage implements StorageAreaLike {
  values: Record<string, unknown> = {};

  async get(): Promise<Record<string, unknown>> {
    return structuredClone(this.values);
  }

  async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, structuredClone(items));
  }

  async remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      delete this.values[key];
    }
  }
}

const baseKeyInput = {
  pageTitle: "記事タイトル",
  pageUrl: "https://example.com/article",
  items: [{ id: "sentence-0001", text: "文章です。", section_heading: "見出し" }],
  translationRate: 20,
  model: "gpt-5.6-luna",
  promptVersion: "v1",
};

describe("translation cache", () => {
  it("includes title, URL, sentence hash, rate, model, and prompt version in the key", async () => {
    const base = await createCacheKey(baseKeyInput);
    await expect(createCacheKey({ ...baseKeyInput, pageTitle: "別の記事" })).resolves.not.toBe(base);
    await expect(createCacheKey({ ...baseKeyInput, pageUrl: "https://example.com/other" })).resolves.not.toBe(base);
    await expect(
      createCacheKey({
        ...baseKeyInput,
        items: [{ ...baseKeyInput.items[0], text: "別の文章です。" }],
      }),
    ).resolves.not.toBe(base);
    await expect(createCacheKey({ ...baseKeyInput, translationRate: 40 })).resolves.not.toBe(base);
    await expect(createCacheKey({ ...baseKeyInput, model: "another-model" })).resolves.not.toBe(base);
    await expect(createCacheKey({ ...baseKeyInput, promptVersion: "v2" })).resolves.not.toBe(base);
  });

  it("evicts the least recently used entry and clears all entries", async () => {
    const storage = new MemoryStorage();
    let timestamp = 0;
    const cache = new TranslationCache(storage, 2, () => ++timestamp);
    await cache.set("a", [{ id: "a", english: "A" }]);
    await cache.set("b", [{ id: "b", english: "B" }]);
    await cache.get("a");
    await cache.set("c", [{ id: "c", english: "C" }]);

    await expect(cache.get("a")).resolves.toBeDefined();
    await expect(cache.get("b")).resolves.toBeUndefined();
    await expect(cache.get("c")).resolves.toBeDefined();

    await cache.clear();
    await expect(cache.get("a")).resolves.toBeUndefined();
  });
});
