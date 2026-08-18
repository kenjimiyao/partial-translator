import { describe, expect, it } from "vitest";

import { ExtensionError } from "../src/background/errors";
import { validateTranslations } from "../src/background/openai";

const items = [
  { id: "sentence-0001", text: "最初の文章です。", section_heading: "見出し" },
  { id: "sentence-0002", text: "次の文章です。", section_heading: "見出し" },
];

describe("validateTranslations", () => {
  it("accepts exact, non-empty translations for input IDs", () => {
    expect(
      validateTranslations(
        {
          translations: [
            { id: "sentence-0001", english: "The first sentence." },
            { id: "sentence-0002", english: "The next sentence." },
          ],
        },
        items,
        2,
      ),
    ).toHaveLength(2);
  });

  it.each([
    [{ translations: [{ id: "unknown", english: "Unknown." }] }, 1],
    [
      {
        translations: [
          { id: "sentence-0001", english: "One." },
          { id: "sentence-0001", english: "Again." },
        ],
      },
      2,
    ],
    [{ translations: [{ id: "sentence-0001", english: "" }] }, 1],
    [{ translations: [{ id: "sentence-0001", english: "One." }] }, 2],
  ])("rejects invalid IDs, duplicates, empty English, and wrong counts", (value, count) => {
    expect(() => validateTranslations(value, items, count)).toThrow(ExtensionError);
  });
});
