import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TranslationPayload } from "../src/shared/types";

const storageValues: Record<string, unknown> = {};

const storageLocal = {
  setAccessLevel: vi.fn(async () => undefined),
  get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => {
    if (typeof keys === "string") {
      return keys in storageValues ? { [keys]: structuredClone(storageValues[keys]) } : {};
    }
    if (Array.isArray(keys)) {
      return Object.fromEntries(
        keys
          .filter((key) => key in storageValues)
          .map((key) => [key, structuredClone(storageValues[key])]),
      );
    }
    return structuredClone(storageValues);
  }),
  set: vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(storageValues, structuredClone(items));
  }),
  remove: vi.fn(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      delete storageValues[key];
    }
  }),
};

const chromeMock = {
  storage: { local: storageLocal },
  runtime: {
    onMessage: { addListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
    openOptionsPage: vi.fn(async () => undefined),
  },
  action: {
    onClicked: { addListener: vi.fn() },
    setBadgeText: vi.fn(async () => undefined),
    setBadgeBackgroundColor: vi.fn(async () => undefined),
    setTitle: vi.fn(async () => undefined),
  },
  permissions: {
    contains: vi.fn(async () => true),
    onRemoved: { addListener: vi.fn() },
    onAdded: { addListener: vi.fn() },
  },
  scripting: {
    getRegisteredContentScripts: vi.fn(async () => []),
    registerContentScripts: vi.fn(async () => undefined),
    updateContentScripts: vi.fn(async () => undefined),
    unregisterContentScripts: vi.fn(async () => undefined),
    executeScript: vi.fn(async () => []),
  },
  tabs: {
    sendMessage: vi.fn(async () => undefined),
  },
};

vi.stubGlobal("chrome", chromeMock);

const { handleActionClick, handleMessage, translatePage } = await import(
  "../src/background/index"
);

function seedSettings(translationRate = 100): void {
  storageValues.settingsV1 = { translationRate, domains: [] };
  storageValues.openaiApiKey = "test-api-key";
}

function translateMessage(count = 2) {
  return {
    type: "TRANSLATE_PAGE",
    pageTitle: "記事",
    pageUrl: "https://example.com/article",
    items: Array.from({ length: count }, (_, index) => ({
      id: `sentence-${String(index + 1).padStart(4, "0")}`,
      text: `これは${index + 1}番目の日本語文章です。`,
      section_heading: "見出し",
    })),
  };
}

function successfulResponse(payload: TranslationPayload, prefix = "English"): Response {
  const selected = [] as TranslationPayload["items"];
  let selectedCharacters = 0;
  for (const item of payload.items) {
    if (
      payload.avoid_adjacent &&
      selected.at(-1)?.position === item.position - 1
    ) {
      continue;
    }
    const currentDifference = Math.abs(
      selectedCharacters - payload.target_characters,
    );
    const nextDifference = Math.abs(
      selectedCharacters + item.character_count - payload.target_characters,
    );
    if (selected.length === 0 || nextDifference <= currentDifference) {
      selected.push(item);
      selectedCharacters += item.character_count;
    }
  }
  const translations = selected.map((item) => ({
    id: item.id,
    english: `${prefix} ${item.id}`,
  }));
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({ translations }),
            },
          ],
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function payloadFromRequest(init?: RequestInit): TranslationPayload {
  const body = JSON.parse(String(init?.body)) as { input: string };
  return JSON.parse(body.input) as TranslationPayload;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("background translation flow", () => {
  beforeEach(() => {
    for (const key of Object.keys(storageValues)) {
      delete storageValues[key];
    }
    vi.clearAllMocks();
    seedSettings();
  });

  it("caches a successful result and avoids a second API request", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      return successfulResponse(payloadFromRequest(init));
    });
    vi.stubGlobal("fetch", fetchMock);
    const message = translateMessage();

    await expect(translatePage(message)).resolves.toMatchObject({
      ok: true,
      fromCache: false,
    });
    await expect(translatePage(message)).resolves.toMatchObject({
      ok: true,
      fromCache: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shares an in-flight request for the same page", async () => {
    const responseGate = deferred<Response>();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        responseGate.promise,
    );
    vi.stubGlobal("fetch", fetchMock);
    const message = translateMessage();

    const first = translatePage(message);
    const second = translatePage(message);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const payload = payloadFromRequest(fetchMock.mock.calls[0][1]);
    responseGate.resolve(successfulResponse(payload));

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not rejoin or cache work started before CLEAR_CACHE", async () => {
    const oldResponse = deferred<Response>();
    let requestNumber = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestNumber += 1;
      const payload = payloadFromRequest(init);
      if (requestNumber === 1) {
        return oldResponse.promise;
      }
      return successfulResponse(payload, "New");
    });
    vi.stubGlobal("fetch", fetchMock);
    const message = translateMessage();

    const oldTranslation = translatePage(message);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await expect(
      handleMessage({ type: "CLEAR_CACHE" }, {} as chrome.runtime.MessageSender),
    ).resolves.toEqual({ ok: true });

    const newTranslation = translatePage(message);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await expect(newTranslation).resolves.toMatchObject({
      ok: true,
      fromCache: false,
      translations: expect.arrayContaining([
        expect.objectContaining({ english: expect.stringMatching(/^New /u) }),
      ]),
    });

    const oldPayload = payloadFromRequest(fetchMock.mock.calls[0][1]);
    oldResponse.resolve(successfulResponse(oldPayload, "Old"));
    await oldTranslation;

    await expect(translatePage(message)).resolves.toMatchObject({
      ok: true,
      fromCache: true,
      translations: expect.arrayContaining([
        expect.objectContaining({ english: expect.stringMatching(/^New /u) }),
      ]),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not join work using an API key that was rotated while in flight", async () => {
    const oldResponse = deferred<Response>();
    const observedAuthorizations: string[] = [];
    let requestNumber = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestNumber += 1;
      observedAuthorizations.push(
        String((init?.headers as Record<string, string>).Authorization),
      );
      const payload = payloadFromRequest(init);
      if (requestNumber === 1) {
        return oldResponse.promise;
      }
      return successfulResponse(payload, "Rotated");
    });
    vi.stubGlobal("fetch", fetchMock);
    const message = translateMessage();

    const oldTranslation = translatePage(message);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await expect(
      handleMessage(
        {
          type: "SAVE_SETTINGS",
          translationRate: 100,
          domains: [],
          apiKey: "rotated-api-key",
        },
        {} as chrome.runtime.MessageSender,
      ),
    ).resolves.toMatchObject({ ok: true });

    const rotatedTranslation = translatePage(message);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await expect(rotatedTranslation).resolves.toMatchObject({
      ok: true,
      fromCache: false,
    });
    expect(observedAuthorizations).toEqual([
      "Bearer test-api-key",
      "Bearer rotated-api-key",
    ]);

    const oldPayload = payloadFromRequest(fetchMock.mock.calls[0][1]);
    oldResponse.resolve(successfulResponse(oldPayload, "Old"));
    await oldTranslation;
  });

  it("aggregates multiple chunks to the exact page-level count", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      return successfulResponse(payloadFromRequest(init));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await translatePage(translateMessage(101));

    expect(result).toMatchObject({ ok: true, translations: expect.any(Array) });
    if (result.ok) {
      expect(result.translations).toHaveLength(101);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requests a source-character percentage and avoids adjacent sentences", async () => {
    seedSettings(20);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      successfulResponse(payloadFromRequest(init)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await translatePage(translateMessage(5));

    expect(result).toMatchObject({ ok: true });
    const payload = payloadFromRequest(fetchMock.mock.calls[0][1]);
    const totalCharacters = payload.items.reduce(
      (sum, item) => sum + item.character_count,
      0,
    );
    expect(payload.target_characters).toBe(Math.round(totalCharacters * 0.2));
    expect(payload.avoid_adjacent).toBe(true);
    if (result.ok) {
      const positions = result.translations.map(
        (translation) => payload.items.find((item) => item.id === translation.id)!.position,
      );
      expect(positions.every((position, index) =>
        index === 0 || position - positions[index - 1] > 1,
      )).toBe(true);
    }
  });
});

describe("manual action flow", () => {
  beforeEach(() => {
    for (const key of Object.keys(storageValues)) {
      delete storageValues[key];
    }
    vi.clearAllMocks();
    seedSettings();
  });

  it("injects content.js with activeTab when no receiver exists", async () => {
    chromeMock.tabs.sendMessage.mockRejectedValueOnce(new Error("no receiver"));

    await handleActionClick({
      id: 42,
      url: "https://example.com/page",
    } as chrome.tabs.Tab);

    expect(chromeMock.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 42, allFrames: false },
      files: ["content.js"],
    });
  });

  it("toggles an existing content script without reinjecting", async () => {
    chromeMock.tabs.sendMessage.mockResolvedValueOnce(undefined);

    await handleActionClick({
      id: 42,
      url: "https://example.com/page",
    } as chrome.tabs.Tab);

    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(42, {
      type: "TOGGLE_TRANSLATION",
    });
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });
});
