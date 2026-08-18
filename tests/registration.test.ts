import { beforeEach, describe, expect, it, vi } from "vitest";

import { reconcileAutomaticContentScript } from "../src/background/registration";

const allowedPatterns = [
  "http://*.allowed.example/*",
  "https://*.allowed.example/*",
];

function installChromeMock(existing = false) {
  const registerContentScripts = vi.fn(async () => undefined);
  const updateContentScripts = vi.fn(async () => undefined);
  const unregisterContentScripts = vi.fn(async () => undefined);
  const contains = vi.fn(async ({ origins }: chrome.permissions.Permissions) =>
    origins?.every((origin) => allowedPatterns.includes(origin)) ?? true,
  );

  vi.stubGlobal("chrome", {
    permissions: { contains },
    scripting: {
      getRegisteredContentScripts: vi.fn(async () =>
        existing ? [{ id: "n-percent-english-auto" }] : [],
      ),
      registerContentScripts,
      updateContentScripts,
      unregisterContentScripts,
    },
  });

  return { registerContentScripts, updateContentScripts, unregisterContentScripts };
}

describe("dynamic content script registration", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps permitted domains active when another configured permission is revoked", async () => {
    const chromeMock = installChromeMock(true);

    await reconcileAutomaticContentScript(["allowed.example", "blocked.example"]);

    expect(chromeMock.updateContentScripts).toHaveBeenCalledWith([
      expect.objectContaining({ matches: allowedPatterns }),
    ]);
    expect(chromeMock.unregisterContentScripts).not.toHaveBeenCalled();
  });

  it("reports missing permissions during an Options save while retaining allowed matches", async () => {
    const chromeMock = installChromeMock(false);

    await expect(
      reconcileAutomaticContentScript(
        ["allowed.example", "blocked.example"],
        true,
      ),
    ).rejects.toMatchObject({ code: "SITE_PERMISSION_MISSING" });

    expect(chromeMock.registerContentScripts).toHaveBeenCalledWith([
      expect.objectContaining({ matches: allowedPatterns }),
    ]);
  });

  it("unregisters the extension-owned script when no configured permission remains", async () => {
    const chromeMock = installChromeMock(true);

    await reconcileAutomaticContentScript(["blocked.example"]);

    expect(chromeMock.unregisterContentScripts).toHaveBeenCalledWith({
      ids: ["n-percent-english-auto"],
    });
  });
});
