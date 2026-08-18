// @vitest-environment node

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface ManifestShape {
  manifest_version?: number;
  minimum_chrome_version?: string;
  permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  background?: { service_worker?: string; type?: string };
  action?: { default_popup?: string };
  content_scripts?: unknown;
  options_page?: string;
}

describe("extension manifest", () => {
  it("uses MV3 with a module service worker and no popup or static content script", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../public/manifest.json", import.meta.url), "utf8"),
    ) as ManifestShape;

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.minimum_chrome_version).toBe("140");
    expect(manifest.background).toEqual({
      service_worker: "background.js",
      type: "module",
    });
    expect(manifest.action?.default_popup).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.options_page).toBe("options.html");
  });

  it("keeps OpenAI mandatory while site access remains optional", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../public/manifest.json", import.meta.url), "utf8"),
    ) as ManifestShape;

    expect(manifest.permissions).toEqual(
      expect.arrayContaining(["activeTab", "scripting", "storage"]),
    );
    expect(manifest.host_permissions).toEqual(["https://api.openai.com/*"]);
    expect(manifest.optional_host_permissions).toEqual([
      "http://*/*",
      "https://*/*",
    ]);
  });
});
