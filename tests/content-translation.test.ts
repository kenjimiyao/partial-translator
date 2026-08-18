import { describe, expect, it, vi } from "vitest";

import { TranslationController } from "../src/content/controller";
import { extractJapaneseSentences } from "../src/content/extractor";
import {
  applyTranslations,
  validateTranslations,
} from "../src/content/translations";
import type { ContentRuntime, ToastPort } from "../src/content/types";

function runtimeRespondingWith(response: unknown): {
  runtime: ContentRuntime;
  messages: unknown[];
} {
  const messages: unknown[] = [];
  const runtime: ContentRuntime = {
    onMessage: { addListener: vi.fn() },
    sendMessage(message, callback) {
      messages.push(message);
      queueMicrotask(() => {
        callback?.(
          (message as { type?: string }).type === "TRANSLATE_PAGE"
            ? response
            : undefined,
        );
      });
    },
  };
  return { runtime, messages };
}

function recordingToast(): ToastPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    show(message) {
      calls.push(message);
    },
  };
}

describe("content translation", () => {
  it("applies multiple ranges in one Text node and restores the exact original", () => {
    document.body.innerHTML =
      '<p id="article">これは最初の文章です。 これは二番目の文章です！</p>';
    const paragraph = document.querySelector("#article") as HTMLParagraphElement;
    const original = paragraph.textContent;
    const candidates = extractJapaneseSentences(paragraph);
    const translations = validateTranslations(candidates, [
      { id: "sentence-0002", english: "This is the second sentence!" },
      { id: "sentence-0001", english: "This is the first sentence." },
    ]);

    const session = applyTranslations(candidates, translations);

    expect(paragraph.textContent).toBe(
      "This is the first sentence. This is the second sentence!",
    );
    expect(paragraph.childNodes).toHaveLength(1);

    session.restore();
    expect(paragraph.textContent).toBe(original);
    expect(paragraph.childNodes).toHaveLength(1);
  });

  it("restores clicked translations individually and keeps later offsets accurate", () => {
    document.body.innerHTML =
      '<p id="article">これは最初の文章です。 これは二番目の文章です！</p>';
    const paragraph = document.querySelector("#article") as HTMLParagraphElement;
    const node = paragraph.firstChild as Text;
    const candidates = extractJapaneseSentences(paragraph);
    const session = applyTranslations(candidates, [
      { id: "sentence-0001", english: "A much longer first sentence." },
      { id: "sentence-0002", english: "Second sentence." },
    ]);

    expect(session.restoreAt(node, 5)).toBe("restored");
    expect(paragraph.textContent).toBe(
      "これは最初の文章です。 Second sentence.",
    );
    expect(session.hasActiveTranslations).toBe(true);

    const secondOffset = node.data.indexOf("Second") + 3;
    expect(session.restoreAt(node, secondOffset)).toBe("restored");
    expect(paragraph.textContent).toBe(
      "これは最初の文章です。 これは二番目の文章です！",
    );
    expect(session.hasActiveTranslations).toBe(false);
    expect(paragraph.childNodes).toHaveLength(1);
  });

  it("does not modify page text when the background reports an API failure", async () => {
    document.title = "テストページ";
    document.body.innerHTML =
      '<article><p id="target">これは変更されてはいけない文章です。</p></article>';
    const target = document.querySelector("#target") as HTMLParagraphElement;
    const original = target.textContent;
    const { runtime, messages } = runtimeRespondingWith({
      ok: false,
      error: { code: "API_RATE_LIMITED", message: "rate limited" },
    });
    const toast = recordingToast();
    const controller = new TranslationController(
      runtime,
      toast,
      document,
      () => "https://example.com/article",
    );

    await controller.translate();

    expect(target.textContent).toBe(original);
    expect(controller.currentMode).toBe("idle");
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "TRANSLATE_PAGE",
        pageTitle: "テストページ",
        pageUrl: "https://example.com/article",
        items: [
          expect.objectContaining({
            id: "sentence-0001",
            section_heading: "",
          }),
        ],
      }),
    );
    expect(messages).toContainEqual({ type: "SET_TAB_STATUS", status: "error" });
    expect(toast.calls.at(-1)).toContain("利用上限");
  });

  it("applies successful translations and restores them on toggle", async () => {
    document.body.innerHTML =
      '<article><a id="link" href="/next">これはリンク内の十分に長い文章です。</a></article>';
    const link = document.querySelector("#link") as HTMLAnchorElement;
    const originalNode = link.firstChild;
    const listener = vi.fn();
    const runtime: ContentRuntime = {
      onMessage: { addListener: listener },
      sendMessage(message, callback) {
        queueMicrotask(() => {
          callback?.(
            (message as { type?: string }).type === "TRANSLATE_PAGE"
              ? {
                  ok: true,
                  translations: [
                    {
                      id: "sentence-0001",
                      english: "This is a sufficiently long sentence inside a link.",
                    },
                  ],
                }
              : undefined,
          );
        });
      },
    };
    const controller = new TranslationController(
      runtime,
      recordingToast(),
      document,
      () => "https://example.com/article",
    );

    await controller.translate();
    expect(link.textContent).toBe(
      "This is a sufficiently long sentence inside a link.",
    );
    expect(link.firstChild).toBe(originalNode);
    expect(link.getAttribute("href")).toBe("/next");

    await controller.toggle();
    expect(link.textContent).toBe("これはリンク内の十分に長い文章です。");
    expect(link.firstChild).toBe(originalNode);
  });

  it("restores a clicked translated link without navigating", async () => {
    document.body.innerHTML =
      '<article><a id="link" href="/next">これはクリックで戻す十分に長い文章です。</a></article>';
    const link = document.querySelector("#link") as HTMLAnchorElement;
    const originalNode = link.firstChild;
    const { runtime, messages } = runtimeRespondingWith({
      ok: true,
      translations: [
        {
          id: "sentence-0001",
          english: "Click this translated sentence to restore it.",
        },
      ],
    });
    const toast = recordingToast();
    const controller = new TranslationController(
      runtime,
      toast,
      document,
      () => "https://example.com/article",
    );

    await controller.translate();
    const translatedNode = link.firstChild as Text;
    Object.defineProperty(document, "caretPositionFromPoint", {
      configurable: true,
      value: vi.fn(() => ({ offsetNode: translatedNode, offset: 8 })),
    });
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 10,
    });

    expect(controller.handlePageClick(click)).toBe(true);
    expect(click.defaultPrevented).toBe(true);
    expect(link.textContent).toBe("これはクリックで戻す十分に長い文章です。");
    expect(link.firstChild).toBe(originalNode);
    expect(link.getAttribute("href")).toBe("/next");
    expect(controller.currentMode).toBe("idle");
    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        type: "SET_TAB_STATUS",
        status: "restored",
      }),
    );
    expect(toast.calls.at(-1)).toContain("すべての文章");

    Reflect.deleteProperty(document, "caretPositionFromPoint");
  });

  it("reports a zero-percent result without changing page text", async () => {
    document.body.innerHTML =
      '<p id="target">これは翻訳率ゼロのときに残る文章です。</p>';
    const target = document.querySelector("#target") as HTMLParagraphElement;
    const { runtime, messages } = runtimeRespondingWith({
      ok: false,
      error: { code: "ZERO_RATE", message: "翻訳率は0%です。" },
    });
    const controller = new TranslationController(
      runtime,
      recordingToast(),
      document,
      () => "https://example.com/",
    );

    await controller.translate();

    expect(target.textContent).toBe("これは翻訳率ゼロのときに残る文章です。");
    expect(messages).toContainEqual({ type: "SET_TAB_STATUS", status: "zero" });
    expect(messages.filter(
      (message) => (message as { type?: string }).type === "TRANSLATE_PAGE",
    )).toHaveLength(1);
  });

  it("does not overwrite text changed by the page after translation", () => {
    document.body.innerHTML =
      '<p id="target">これはページ側でも更新される文章です。</p>';
    const target = document.querySelector("#target") as HTMLParagraphElement;
    const candidates = extractJapaneseSentences(target);
    const session = applyTranslations(candidates, [
      { id: "sentence-0001", english: "This text was translated." },
    ]);

    target.firstChild!.textContent = "ページ側が後から更新した内容です。";
    const restored = session.restore();

    expect(restored).toBe(false);
    expect(target.textContent).toBe("ページ側が後から更新した内容です。");
  });

  it("rejects invalid translation IDs, duplicates, and empty output before mutation", () => {
    document.body.innerHTML =
      '<p id="target">これは検証対象となる十分に長い文章です。</p>';
    const target = document.querySelector("#target") as HTMLParagraphElement;
    const candidates = extractJapaneseSentences(target);
    const original = target.textContent;

    expect(() => validateTranslations(candidates, [
      { id: "unknown", english: "Unknown." },
    ])).toThrow();
    expect(() => validateTranslations(candidates, [
      { id: "sentence-0001", english: "First." },
      { id: "sentence-0001", english: "Duplicate." },
    ])).toThrow();
    expect(() => validateTranslations(candidates, [
      { id: "sentence-0001", english: "   " },
    ])).toThrow();
    expect(target.textContent).toBe(original);
  });

  it("does not send stale candidates after the page URL changes", async () => {
    document.body.innerHTML =
      '<p>これは移動前のページにだけ存在する文章です。</p>';
    let url = "https://example.com/before";
    let releaseProcessingStatus: ((response?: unknown) => void) | undefined;
    const messages: unknown[] = [];
    const runtime: ContentRuntime = {
      onMessage: { addListener: vi.fn() },
      sendMessage(message, callback) {
        messages.push(message);
        if (
          (message as { type?: string; status?: string }).type === "SET_TAB_STATUS" &&
          (message as { status?: string }).status === "processing"
        ) {
          releaseProcessingStatus = callback;
          return;
        }
        queueMicrotask(() => callback?.({ ok: true }));
      },
    };
    const controller = new TranslationController(
      runtime,
      recordingToast(),
      document,
      () => url,
    );

    const operation = controller.translate();
    await vi.waitFor(() => expect(releaseProcessingStatus).toBeTypeOf("function"));
    url = "https://example.com/after";
    releaseProcessingStatus?.({ ok: true });
    await operation;

    expect(messages.filter(
      (message) => (message as { type?: string }).type === "TRANSLATE_PAGE",
    )).toHaveLength(0);
    expect(messages).toContainEqual({ type: "SET_TAB_STATUS", status: "error" });
  });
});
