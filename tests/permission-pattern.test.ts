import { describe, expect, it } from "vitest";

import {
  missingOriginPatternsForDomain,
  originsCoverDomain,
  permissionRollbackPlanForDomain,
} from "../src/shared/permission-pattern";

describe("origin permission coverage", () => {
  it("recognizes an exact wildcard-domain grant and a broader parent grant", () => {
    expect(
      originsCoverDomain(["*://*.example.com/*"], "example.com"),
    ).toBe(true);
    expect(
      originsCoverDomain(["*://*.example.com/*"], "news.example.com"),
    ).toBe(true);
  });

  it("requires both HTTP and HTTPS when grants have a fixed scheme", () => {
    expect(
      originsCoverDomain(["https://*.example.com/*"], "example.com"),
    ).toBe(false);
    expect(
      originsCoverDomain(
        ["http://*.example.com/*", "https://*.example.com/*"],
        "example.com",
      ),
    ).toBe(true);
    expect(
      missingOriginPatternsForDomain(
        ["https://*.example.com/*"],
        "example.com",
      ),
    ).toEqual(["http://*.example.com/*"]);
    expect(
      missingOriginPatternsForDomain(
        ["http://*.example.com/*"],
        "example.com",
      ),
    ).toEqual(["https://*.example.com/*"]);
  });

  it("preserves a scheme granted by a parent domain during child rollback", () => {
    expect(
      missingOriginPatternsForDomain(
        ["https://*.example.com/*"],
        "news.example.com",
      ),
    ).toEqual(["http://*.news.example.com/*"]);
  });

  it("does not remove a broad pattern when it would intersect an older narrow grant", () => {
    expect(
      permissionRollbackPlanForDomain(
        ["https://news.example.com/*"],
        "example.com",
      ),
    ).toEqual({
      origins: ["http://*.example.com/*"],
      hasUnsafeOverlap: true,
    });
    expect(
      permissionRollbackPlanForDomain(
        ["https://example.com/*"],
        "example.com",
      ),
    ).toEqual({
      origins: ["http://*.example.com/*"],
      hasUnsafeOverlap: true,
    });
    expect(
      permissionRollbackPlanForDomain(
        ["https://*.news.example.com/*"],
        "example.com",
      ),
    ).toEqual({
      origins: ["http://*.example.com/*"],
      hasUnsafeOverlap: true,
    });
    expect(
      permissionRollbackPlanForDomain([], "example.com"),
    ).toEqual({
      origins: [
        "http://*.example.com/*",
        "https://*.example.com/*",
      ],
      hasUnsafeOverlap: false,
    });
  });

  it("recognizes all-sites grants without confusing hostname suffixes", () => {
    expect(originsCoverDomain(["<all_urls>"], "example.com")).toBe(true);
    expect(originsCoverDomain(["*://*/*"], "example.com")).toBe(true);
    expect(
      originsCoverDomain(["*://*.notexample.com/*"], "example.com"),
    ).toBe(false);
  });
});
