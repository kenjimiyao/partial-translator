import { describe, expect, it } from "vitest";

import { mapWithConcurrency } from "../src/background/concurrency";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("mapWithConcurrency", () => {
  it("bounds active work and preserves input order", async () => {
    const gates = Array.from({ length: 6 }, () => deferred<void>());
    let active = 0;
    let maximumActive = 0;
    const resultPromise = mapWithConcurrency(
      [0, 1, 2, 3, 4, 5],
      3,
      async (value) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await gates[value].promise;
        active -= 1;
        return `result-${value}`;
      },
    );

    expect(active).toBe(3);
    gates[2].resolve();
    await Promise.resolve();
    gates[0].resolve();
    await Promise.resolve();
    gates[1].resolve();
    await Promise.resolve();
    expect(active).toBeLessThanOrEqual(3);
    gates.slice(3).forEach((gate) => gate.resolve());

    await expect(resultPromise).resolves.toEqual([
      "result-0",
      "result-1",
      "result-2",
      "result-3",
      "result-4",
      "result-5",
    ]);
    expect(maximumActive).toBe(3);
  });

  it("waits for active siblings and stops scheduling after a failure", async () => {
    const sibling = deferred<void>();
    const started: number[] = [];
    const resultPromise = mapWithConcurrency([0, 1, 2, 3], 2, async (value) => {
      started.push(value);
      if (value === 0) {
        throw new Error("failed");
      }
      await sibling.promise;
      return value;
    });

    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    sibling.resolve();
    await expect(resultPromise).rejects.toThrow("failed");
    expect(started).toEqual([0, 1]);
  });
});
