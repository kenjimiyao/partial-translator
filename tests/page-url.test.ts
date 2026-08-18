import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("chrome", {
  storage: { local: {} },
  runtime: {
    onMessage: { addListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
  },
  action: { onClicked: { addListener: vi.fn() } },
  permissions: {
    onRemoved: { addListener: vi.fn() },
    onAdded: { addListener: vi.fn() },
  },
});

const { isSupportedPageUrl } = await import("../src/background/index");

describe("manual execution URL support", () => {
  it("allows ordinary HTTP and HTTPS pages", () => {
    expect(isSupportedPageUrl("https://example.com/article")).toBe(true);
    expect(isSupportedPageUrl("http://localhost:3000/")).toBe(true);
  });

  it("rejects privileged pages and the Chrome Web Store", () => {
    expect(isSupportedPageUrl("chrome://settings/")).toBe(false);
    expect(isSupportedPageUrl("chrome-extension://id/options.html")).toBe(false);
    expect(isSupportedPageUrl("https://chromewebstore.google.com/detail/example/id")).toBe(false);
    expect(isSupportedPageUrl("https://chrome.google.com/webstore/detail/example/id")).toBe(false);
  });
});
