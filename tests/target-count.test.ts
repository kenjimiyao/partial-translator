import { describe, expect, it } from "vitest";

import { calculateTargetCount } from "../src/shared/target-count";

describe("calculateTargetCount", () => {
  it("returns zero for 0% without selecting anything", () => {
    expect(calculateTargetCount(100, 0)).toBe(0);
  });

  it("selects at least one sentence for a positive rate", () => {
    expect(calculateTargetCount(7, 20)).toBe(1);
    expect(calculateTargetCount(1, 1)).toBe(1);
  });

  it("selects every sentence at 100%", () => {
    expect(calculateTargetCount(7, 100)).toBe(7);
  });

  it("clamps out-of-range percentages", () => {
    expect(calculateTargetCount(10, -1)).toBe(0);
    expect(calculateTargetCount(10, 101)).toBe(10);
  });
});
