import { afterEach, describe, expect, it, vi } from "vitest";

import { PageToast } from "../src/content/toast";

describe("PageToast", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("keeps error messages visible until manually dismissed", () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const toast = new PageToast(document);

    toast.show("詳細を確認できるエラーです。", "error");

    expect(timeout).not.toHaveBeenCalled();
  });

  it("continues to dismiss non-error messages automatically", () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const toast = new PageToast(document);

    toast.show("処理が完了しました。", "success");

    expect(timeout).toHaveBeenCalledTimes(1);
  });
});
