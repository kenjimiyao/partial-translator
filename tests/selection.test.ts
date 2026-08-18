import { describe, expect, it } from "vitest";

import {
  addSelectionMetadata,
  calculateTargetCharacters,
  canAvoidAdjacentSelection,
  characterTargetTolerance,
  countSourceCharacters,
  selectClosestCharacterPlan,
} from "../src/shared/selection";

const items = (lengths: number[]) =>
  addSelectionMetadata(
    lengths.map((length, index) => ({
      id: `sentence-${index + 1}`,
      text: "文".repeat(length),
      section_heading: "",
    })),
  );

describe("character-based translation selection", () => {
  it("counts Unicode code points while excluding whitespace", () => {
    expect(countSourceCharacters("日本 語\n😀")).toBe(4);
  });

  it("calculates the percentage from source characters rather than item count", () => {
    const candidates = [
      { text: "長".repeat(80) },
      { text: "短".repeat(20) },
    ];
    expect(calculateTargetCharacters(candidates, 20)).toBe(20);
    expect(calculateTargetCharacters(candidates, 0)).toBe(0);
    expect(calculateTargetCharacters(candidates, 100)).toBe(100);
  });

  it("detects when the target can be reached without adjacent sentences", () => {
    const candidates = items([10, 10, 10, 10]);
    expect(canAvoidAdjacentSelection(candidates, 20)).toBe(true);
    expect(canAvoidAdjacentSelection(candidates, 30)).toBe(false);
    expect(canAvoidAdjacentSelection(candidates, 21)).toBe(true);
    expect(canAvoidAdjacentSelection(candidates, 24)).toBe(true);
  });

  it("uses the closest feasible sentence total plus a small arithmetic margin", () => {
    expect(characterTargetTolerance(items([10, 10, 10, 10]), 20, true)).toBe(1);
    expect(characterTargetTolerance(items([50, 50]), 20, true)).toBe(30);
    expect(characterTargetTolerance(items([500, ...Array(50).fill(10)]), 200, true)).toBe(20);
  });

  it("builds a distributed non-adjacent plan closest to the character target", () => {
    const candidates = items([10, 10, 10, 10, 10]);
    const plan = selectClosestCharacterPlan(candidates, 20, true);
    const positions = plan.map((item) => item.position);

    expect(plan.reduce((sum, item) => sum + item.character_count, 0)).toBe(20);
    expect(positions).toEqual([1, 3]);
    expect(positions.every((position, index) =>
      index === 0 || position - positions[index - 1] > 1,
    )).toBe(true);
  });

  it("keeps large-page planning bounded while staying near the target", () => {
    const candidates = items(Array(2_000).fill(100));
    const targetCharacters = 40_000;
    const plan = selectClosestCharacterPlan(candidates, targetCharacters, true);
    const selectedCharacters = plan.reduce(
      (sum, item) => sum + item.character_count,
      0,
    );

    expect(Math.abs(selectedCharacters - targetCharacters)).toBeLessThanOrEqual(4_000);
    expect(plan.every((item, index) =>
      index === 0 || item.position - plan[index - 1].position > 1,
    )).toBe(true);
  });
});
