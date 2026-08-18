import { CACHE_LIMIT } from "../shared/constants";
import type { Translation, TranslationInputItem } from "../shared/types";

const CACHE_STORAGE_KEY = "translationCacheV1";

export interface StorageAreaLike {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

interface CacheEntry {
  key: string;
  translations: Translation[];
  lastAccessed: number;
}

interface CacheState {
  entries: CacheEntry[];
}

function isTranslation(value: unknown): value is Translation {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Translation).id === "string" &&
    typeof (value as Translation).english === "string"
  );
}

function readState(value: unknown): CacheState {
  if (typeof value !== "object" || value === null || !Array.isArray((value as CacheState).entries)) {
    return { entries: [] };
  }

  const entries = (value as CacheState).entries.filter(
    (entry): entry is CacheEntry =>
      typeof entry === "object" &&
      entry !== null &&
      typeof entry.key === "string" &&
      typeof entry.lastAccessed === "number" &&
      Array.isArray(entry.translations) &&
      entry.translations.every(isTranslation),
  );
  return { entries };
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createCacheKey(input: {
  pageTitle: string;
  pageUrl: string;
  items: TranslationInputItem[];
  translationRate: number;
  model: string;
  promptVersion: string;
}): Promise<string> {
  const sentenceListHash = await sha256(
    JSON.stringify(
      input.items.map(({ id, text, section_heading }) => ({ id, text, section_heading })),
    ),
  );
  const compositeHash = await sha256(
    JSON.stringify({
      pageTitle: input.pageTitle,
      url: input.pageUrl,
      sentenceListHash,
      translationRate: input.translationRate,
      model: input.model,
      promptVersion: input.promptVersion,
    }),
  );
  return `n-percent-english:${compositeHash}`;
}

export class TranslationCache {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: StorageAreaLike,
    private readonly limit = CACHE_LIMIT,
    private readonly now: () => number = Date.now,
  ) {}

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  get(key: string): Promise<Translation[] | undefined> {
    return this.runExclusive(async () => {
      const stored = await this.storage.get(CACHE_STORAGE_KEY);
      const state = readState(stored[CACHE_STORAGE_KEY]);
      const entry = state.entries.find((candidate) => candidate.key === key);
      if (!entry) {
        return undefined;
      }
      const latestTimestamp = state.entries.reduce(
        (latest, candidate) => Math.max(latest, candidate.lastAccessed),
        0,
      );
      entry.lastAccessed = Math.max(this.now(), latestTimestamp + 1);
      await this.storage.set({ [CACHE_STORAGE_KEY]: state });
      return entry.translations.map((translation) => ({ ...translation }));
    });
  }

  set(key: string, translations: Translation[]): Promise<void> {
    return this.runExclusive(async () => {
      const stored = await this.storage.get(CACHE_STORAGE_KEY);
      const state = readState(stored[CACHE_STORAGE_KEY]);
      const withoutExisting = state.entries.filter((entry) => entry.key !== key);
      const latestTimestamp = withoutExisting.reduce(
        (latest, entry) => Math.max(latest, entry.lastAccessed),
        0,
      );
      withoutExisting.push({
        key,
        translations: translations.map((translation) => ({ ...translation })),
        lastAccessed: Math.max(this.now(), latestTimestamp + 1),
      });
      withoutExisting.sort((left, right) => right.lastAccessed - left.lastAccessed);
      state.entries = withoutExisting.slice(0, Math.max(1, this.limit));
      await this.storage.set({ [CACHE_STORAGE_KEY]: state });
    });
  }

  delete(key: string): Promise<void> {
    return this.runExclusive(async () => {
      const stored = await this.storage.get(CACHE_STORAGE_KEY);
      const state = readState(stored[CACHE_STORAGE_KEY]);
      state.entries = state.entries.filter((entry) => entry.key !== key);
      await this.storage.set({ [CACHE_STORAGE_KEY]: state });
    });
  }

  clear(): Promise<void> {
    return this.runExclusive(() => this.storage.remove(CACHE_STORAGE_KEY));
  }
}
