import { describe, expect, it, vi } from "vitest";

import { restrictStorageToTrustedContexts } from "../src/background/storage-isolation";

describe("storage isolation", () => {
  it("waits for TRUSTED_CONTEXTS access to be established", async () => {
    const setAccessLevel = vi.fn(async () => undefined);

    await restrictStorageToTrustedContexts({ setAccessLevel });

    expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
  });

  it("fails closed without exposing the underlying failure", async () => {
    const setAccessLevel = vi.fn(async () => {
      throw new Error("sensitive implementation detail");
    });

    await expect(
      restrictStorageToTrustedContexts({ setAccessLevel }),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: expect.not.stringContaining("sensitive implementation detail"),
    });
  });

  it("fails closed when the Chrome API is unavailable", async () => {
    await expect(restrictStorageToTrustedContexts({})).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
  });
});
