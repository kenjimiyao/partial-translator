import { TranslationController } from "./controller";
import { PageToast } from "./toast";
import type { ContentRuntime } from "./types";

const SENTINEL = "__nPercentEnglishContentController__";

interface ContentGlobal {
  chrome?: { runtime?: ContentRuntime };
  [SENTINEL]?: TranslationController;
}

function bootstrap(): void {
  const contentGlobal = globalThis as unknown as ContentGlobal;
  const runtime = contentGlobal.chrome?.runtime;
  if (!runtime || contentGlobal[SENTINEL]) {
    return;
  }

  const controller = new TranslationController(runtime, new PageToast(document));
  contentGlobal[SENTINEL] = controller;

  runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (
      !message ||
      typeof message !== "object" ||
      (message as { type?: unknown }).type !== "TOGGLE_TRANSLATION"
    ) {
      return;
    }

    void controller.toggle().then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false }),
    );
    return true;
  });

  // Dynamically registered domains and first-time activeTab injection both start here.
  void controller.translate();
}

bootstrap();
