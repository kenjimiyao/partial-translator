import { describe, expect, it, vi } from "vitest";

document.body.innerHTML = `
  <form id="settings-form">
    <input id="api-key" type="password" />
    <span id="api-key-state"></span>
    <button id="toggle-api-key" type="button"></button>
    <input id="translation-rate-slider" type="range" value="20" />
    <input id="translation-rate-number" type="number" value="20" />
    <textarea id="domains"></textarea>
    <div id="domains-errors" hidden></div>
    <button id="save-settings" type="submit"></button>
    <button id="clear-cache" type="button"></button>
    <div id="status-message" hidden></div>
  </form>
`;

const sendMessage = vi.fn(async (message: { type?: string }) => {
  if (message.type === "GET_SETTINGS_OVERVIEW") {
    return {
      translationRate: 20,
      domains: [],
      apiKeyConfigured: false,
      missingPermissionDomains: [],
    };
  }
  if (message.type === "SAVE_SETTINGS") {
    return {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "設定保存に失敗しました。" },
    };
  }
  return { ok: true };
});

const getAll = vi.fn(async () => ({
  origins: [
    "https://api.openai.com/*",
    "https://*.example.com/*",
  ],
}));
const request = vi.fn(async () => true);
const remove = vi.fn(async () => true);

vi.stubGlobal("chrome", {
  runtime: { sendMessage },
  permissions: { getAll, request, remove },
});

await import("../src/options/main");

describe("Options save flow", () => {
  it("rolls back only the new scheme on a confirmed save failure", async () => {
    const form = document.getElementById("settings-form") as HTMLFormElement;
    const domains = document.getElementById("domains") as HTMLTextAreaElement;
    const apiKey = document.getElementById("api-key") as HTMLInputElement;
    const save = document.getElementById("save-settings") as HTMLButtonElement;
    const status = document.getElementById("status-message") as HTMLDivElement;

    await vi.waitFor(() => expect(save.disabled).toBe(false));
    domains.value = "example.com";
    apiKey.value = "sk-test-value";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(getAll).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({
      origins: [
        "http://*.example.com/*",
        "https://*.example.com/*",
      ],
    });
    expect(getAll.mock.invocationCallOrder[0]).toBeLessThan(
      request.mock.invocationCallOrder[0],
    );

    await vi.waitFor(() =>
      expect(remove).toHaveBeenCalledWith({
        origins: ["http://*.example.com/*"],
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith({
      type: "SAVE_SETTINGS",
      translationRate: 20,
      domains: ["example.com"],
      apiKey: "sk-test-value",
    });
    expect(status.textContent).toContain("設定保存に失敗しました。");
    expect(save.disabled).toBe(false);
  });
});
