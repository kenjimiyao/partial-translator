import { describe, expect, it } from "vitest";

import { ExtensionError } from "../src/background/errors";
import { validateTranslations } from "../src/background/openai";
import { addSelectionMetadata } from "../src/shared/selection";

const items = addSelectionMetadata([
  { id: "sentence-0001", text: "最初の文章です。", section_heading: "見出し" },
  { id: "sentence-0002", text: "次の文章です。", section_heading: "見出し" },
  { id: "sentence-0003", text: "最後の文章です。", section_heading: "見出し" },
]);

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
        items[0].character_count + items[1].character_count,
        false,
      ),
    ).toHaveLength(2);
  });

  it.each([
    [{ translations: [{ id: "unknown", english: "Unknown." }] }],
    [
      {
        translations: [
          { id: "sentence-0001", english: "One." },
          { id: "sentence-0001", english: "Again." },
        ],
      },
    ],
    [{ translations: [{ id: "sentence-0001", english: "" }] }],
    [{ translations: [] }],
  ])("rejects invalid IDs, duplicates, empty English, and empty selection", (value) => {
    expect(() =>
      validateTranslations(value, items, items[0].character_count, true),
    ).toThrow(ExtensionError);
  });

  it("rejects adjacent selections when spacing is feasible", () => {
    expect(() =>
      validateTranslations(
        {
          translations: [
            { id: "sentence-0001", english: "One." },
            { id: "sentence-0002", english: "Two." },
          ],
        },
        items,
        items[0].character_count + items[1].character_count,
        true,
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_RESPONSE" }));
  });

  it("rejects a selection outside the source-character target tolerance", () => {
    expect(() =>
      validateTranslations(
        {
          translations: [
            { id: "sentence-0001", english: "One." },
            { id: "sentence-0003", english: "Three." },
          ],
        },
        items,
        items[0].character_count,
        true,
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_RESPONSE" }));
  });

  it("requires every input item at 100 percent", () => {
    const totalCharacters = items.reduce(
      (sum, item) => sum + item.character_count,
      0,
    );
    expect(() =>
      validateTranslations(
        {
          translations: [
            { id: "sentence-0001", english: "One." },
            { id: "sentence-0002", english: "Two." },
          ],
        },
        items,
        totalCharacters,
        false,
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_RESPONSE" }));
  });

  it("honors a chunk-specific character deviation budget", () => {
    const variedItems = addSelectionMetadata([
      { id: "sentence-0001", text: "文".repeat(10), section_heading: "" },
      { id: "sentence-0002", text: "文".repeat(11), section_heading: "" },
    ]);
    expect(() =>
      validateTranslations(
        {
          translations: [
            { id: "sentence-0002", english: "Eleven characters." },
          ],
        },
        variedItems,
        10,
        false,
        0,
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_RESPONSE" }));
  });
});
