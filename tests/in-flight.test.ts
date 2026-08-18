import { describe, expect, it, vi } from "vitest";

import { InFlightWorkRegistry } from "../src/background/in-flight";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("InFlightWorkRegistry", () => {
  it("shares work for the same key within an epoch", async () => {
    const registry = new InFlightWorkRegistry<number>();
    const pending = deferred<number>();
    const create = vi.fn(() => pending.promise);

    const first = registry.getOrCreate("same", create);
    const second = registry.getOrCreate("same", create);

    expect(second).toEqual(first);
    expect(create).toHaveBeenCalledTimes(1);
    pending.resolve(1);
    await expect(first.promise).resolves.toBe(1);
  });

  it("invalidates old work and does not let its completion remove new work", async () => {
    const registry = new InFlightWorkRegistry<number>();
    const oldPending = deferred<number>();
    const newPending = deferred<number>();

    const oldWork = registry.getOrCreate("same", () => oldPending.promise);
    registry.invalidate();
    const newWork = registry.getOrCreate("same", () => newPending.promise);

    expect(newWork.promise).not.toBe(oldWork.promise);
    expect(registry.isCurrent(oldWork.epoch)).toBe(false);
    expect(registry.isCurrent(newWork.epoch)).toBe(true);

    oldPending.resolve(1);
    await oldWork.promise;

    const sharedNewWork = registry.getOrCreate("same", () => Promise.resolve(3));
    expect(sharedNewWork.promise).toBe(newWork.promise);

    newPending.resolve(2);
    await expect(newWork.promise).resolves.toBe(2);
  });
});
