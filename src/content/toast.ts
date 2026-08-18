import type { ToastPort } from "./types";

const HOST_ID = "n-percent-english-toast-host";
const DISPLAY_DURATION_MS = 4_500;

export class PageToast implements ToastPort {
  private readonly host: HTMLDivElement;
  private readonly messageElement: HTMLDivElement;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly documentNode: Document = document) {
    this.host = documentNode.createElement("div");
    this.host.id = HOST_ID;
    const shadow = this.host.attachShadow({ mode: "closed" });

    const style = documentNode.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        position: fixed;
        inset: 16px 16px auto auto;
        z-index: 2147483647;
        pointer-events: none;
      }
      .toast {
        box-sizing: border-box;
        max-width: min(380px, calc(100vw - 32px));
        padding: 11px 14px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 9px;
        background: #202124;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.28);
        color: #fff;
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        overflow-wrap: anywhere;
        opacity: 0;
        transform: translateY(-6px);
        transition: opacity 120ms ease, transform 120ms ease;
      }
      .toast[data-visible="true"] {
        opacity: 1;
        transform: translateY(0);
      }
      .toast[data-kind="success"] { background: #176b3a; }
      .toast[data-kind="error"] { background: #9c2f25; }
    `;

    this.messageElement = documentNode.createElement("div");
    this.messageElement.className = "toast";
    this.messageElement.setAttribute("role", "status");
    shadow.append(style, this.messageElement);
    (documentNode.body ?? documentNode.documentElement).append(this.host);
  }

  show(
    message: string,
    kind: "info" | "success" | "error" = "info",
  ): void {
    if (this.hideTimer !== undefined) {
      clearTimeout(this.hideTimer);
    }

    this.messageElement.textContent = message;
    this.messageElement.dataset.kind = kind;
    this.messageElement.dataset.visible = "true";
    this.hideTimer = setTimeout(() => {
      this.messageElement.dataset.visible = "false";
      this.hideTimer = undefined;
    }, DISPLAY_DURATION_MS);
  }
}
