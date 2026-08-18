import { afterEach, describe, expect, it, vi } from "vitest";

import { runWithDeadline } from "../src/background/deadline";

describe("translation job deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts one shared signal at the deadline", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const operation = runWithDeadline(1_000, async (signal) => {
      observedSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("deadline", "AbortError")),
          { once: true },
        );
      });
    });

    expect(observedSignal?.aborted).toBe(false);
    const rejection = expect(operation).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(observedSignal?.aborted).toBe(true);
  });

  it("clears the deadline after an early success", async () => {
    vi.useFakeTimers();
    const result = await runWithDeadline(1_000, async () => "done");

    expect(result).toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });
});
