import { describe, expect, it } from "vitest";

import {
  domainIncludes,
  domainToMatchPatterns,
  domainsToMatchPatterns,
  minimizeDomains,
  normalizeDomain,
  parseDomainLines,
} from "../src/shared/domain";

describe("normalizeDomain", () => {
  it("trims, lowercases, and removes a DNS terminal dot", () => {
    expect(normalizeDomain("  WWW.Example.COM. ")).toBe("www.example.com");
  });

  it("normalizes internationalized hostnames with IDNA", () => {
    expect(normalizeDomain("例え.テスト")).toBe("xn--r8jz45g.xn--zckzah");
  });

  it.each([
    "https://example.com",
    "example.com/path",
    "example.com?query=1",
    "example.com#top",
    "user@example.com",
    "example.com:443",
    "*.example.com",
    "exa_mple.com",
    "-example.com",
    "example..com",
    "127.0.0.1",
  ])("rejects non-hostname input: %s", (input) => {
    expect(() => normalizeDomain(input)).toThrow(/ホスト名/u);
  });
});

describe("parseDomainLines", () => {
  it("ignores blank lines, removes duplicates, and reports original line numbers", () => {
    const result = parseDomainLines(
      "Example.com\n\nexample.com.\nhttps://invalid.example/path\ndeveloper.mozilla.org",
    );

    expect(result.domains).toEqual(["example.com", "developer.mozilla.org"]);
    expect(result.errors).toEqual([
      expect.objectContaining({ line: 4, value: "https://invalid.example/path" }),
    ]);
  });

  it("accepts an empty list", () => {
    expect(parseDomainLines("\n  \n")).toEqual({ domains: [], errors: [] });
  });
});

describe("domain permission patterns", () => {
  it("uses the Chrome wildcard pattern that includes apex and subdomains", () => {
    expect(domainToMatchPatterns("example.com")).toEqual(["*://*.example.com/*"]);
  });

  it("checks domain boundaries rather than suffix text alone", () => {
    expect(domainIncludes("example.com", "news.example.com")).toBe(true);
    expect(domainIncludes("example.com", "example.com")).toBe(true);
    expect(domainIncludes("example.com", "notexample.com")).toBe(false);
  });

  it("collapses redundant child domains to the broadest configured parent", () => {
    expect(
      minimizeDomains(["news.example.com", "example.com", "other.example"]),
    ).toEqual(["example.com", "other.example"]);
    expect(
      domainsToMatchPatterns(["news.example.com", "example.com", "other.example"]),
    ).toEqual(["*://*.example.com/*", "*://*.other.example/*"]);
  });
});
