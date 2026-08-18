import type { ExtractedSentence } from "./types";

const EXCLUDED_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "PRE",
  "CODE",
  "KBD",
  "SAMP",
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "BUTTON",
  "FORM",
  "NAV",
  "IFRAME",
  "CANVAS",
]);

const HEADING_TAG_PATTERN = /^H[1-6]$/;
const JAPANESE_CHARACTER_PATTERN =
  /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const JAPANESE_CHARACTERS_PATTERN =
  /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu;
const MEANINGFUL_CHARACTER_PATTERN = /[\p{L}\p{N}]/gu;
const SENTENCE_END_PATTERN = /[。．.!！？?…][」』）)\]】〉》”’"']*$/u;
const URL_ONLY_PATTERN = /^(?:(?:https?|ftp):\/\/|www\.)\S+$/iu;
const NUMBER_OR_SYMBOL_ONLY_PATTERN = /^[\p{N}\p{P}\p{S}\s]+$/u;

const MIN_MEANINGFUL_CHARACTERS = 5;
const MAX_SHORT_LABEL_CHARACTERS = 8;

function normalizeVisibleText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function isEditable(element: Element | null): boolean {
  if (element && "isContentEditable" in element && element.isContentEditable) {
    return true;
  }

  for (let current = element; current; current = current.parentElement) {
    if (!current.hasAttribute("contenteditable")) {
      continue;
    }

    const value = (current.getAttribute("contenteditable") ?? "")
      .trim()
      .toLowerCase();
    if (value === "false") {
      return false;
    }
    if (value === "" || value === "true" || value === "plaintext-only") {
      return true;
    }
  }

  return false;
}

function isHiddenByClosedDetails(element: Element): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.tagName !== "DETAILS" || current.hasAttribute("open")) {
      continue;
    }

    const summary = Array.from(current.children).find(
      (child) => child.tagName === "SUMMARY",
    );
    if (!summary || !summary.contains(element)) {
      return true;
    }
  }

  return false;
}

function isExcludedOrHidden(element: Element | null): boolean {
  if (!element || isEditable(element) || isHiddenByClosedDetails(element)) {
    return true;
  }

  const view = element.ownerDocument.defaultView;
  if (view) {
    const elementStyle = view.getComputedStyle(element);
    if (
      elementStyle.visibility === "hidden" ||
      elementStyle.visibility === "collapse"
    ) {
      return true;
    }
  }

  for (let current: Element | null = element; current; current = current.parentElement) {
    if (
      EXCLUDED_TAGS.has(current.tagName) ||
      current.hasAttribute("hidden") ||
      current.getAttribute("aria-hidden")?.trim().toLowerCase() === "true"
    ) {
      return true;
    }

    if (view) {
      const style = view.getComputedStyle(current);
      if (
        style.display === "none" ||
        style.contentVisibility === "hidden" ||
        Number.parseFloat(style.opacity) === 0
      ) {
        return true;
      }
    }
  }

  return false;
}

export function isTranslationCandidate(text: string): boolean {
  const normalized = normalizeVisibleText(text);
  if (
    !normalized ||
    !JAPANESE_CHARACTER_PATTERN.test(normalized) ||
    URL_ONLY_PATTERN.test(normalized) ||
    NUMBER_OR_SYMBOL_ONLY_PATTERN.test(normalized)
  ) {
    return false;
  }

  const meaningfulCount = normalized.match(MEANINGFUL_CHARACTER_PATTERN)?.length ?? 0;
  const japaneseCount = normalized.match(JAPANESE_CHARACTERS_PATTERN)?.length ?? 0;

  if (meaningfulCount < MIN_MEANINGFUL_CHARACTERS || japaneseCount < 3) {
    return false;
  }

  // Very short, punctuation-free strings are generally navigation or control labels.
  if (
    meaningfulCount <= MAX_SHORT_LABEL_CHARACTERS &&
    !SENTENCE_END_PATTERN.test(normalized)
  ) {
    return false;
  }

  return true;
}

function trimmedSegmentRange(
  source: string,
  index: number,
  segment: string,
): { start: number; end: number; text: string } | null {
  const firstNonWhitespace = segment.search(/\S/u);
  if (firstNonWhitespace < 0) {
    return null;
  }

  const lastNonWhitespace = segment.search(/\s*$/u);
  const start = index + firstNonWhitespace;
  const end = index + lastNonWhitespace;
  const text = source.slice(start, end);
  return text ? { start, end, text } : null;
}

function headingText(element: Element): string {
  const documentNode = element.ownerDocument;
  const nodeFilter = documentNode.defaultView?.NodeFilter ?? NodeFilter;
  const walker = documentNode.createTreeWalker(element, nodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const node = current as Text;
    if (!isExcludedOrHidden(node.parentElement) && node.data.trim()) {
      parts.push(node.data);
    }
  }
  return normalizeVisibleText(parts.join(" "));
}

/**
 * Extracts sentence-sized candidates while retaining their exact Text node ranges.
 * Shadow roots and iframe documents are intentionally outside the supplied root.
 */
export function extractJapaneseSentences(
  root: ParentNode = document.body ?? document.documentElement,
): ExtractedSentence[] {
  const rootIsDocument = root.nodeType === 9;
  const documentNode =
    rootIsDocument ? (root as Document) : root.ownerDocument ?? document;
  const traversalRoot = rootIsDocument ? (root as Document).documentElement : root;
  if (!traversalRoot) {
    return [];
  }

  const view = documentNode.defaultView;
  const nodeFilter = view?.NodeFilter ?? NodeFilter;
  const walker = documentNode.createTreeWalker(
    traversalRoot,
    nodeFilter.SHOW_ELEMENT | nodeFilter.SHOW_TEXT,
  );
  const segmenter = new Intl.Segmenter("ja", { granularity: "sentence" });
  const candidates: Omit<ExtractedSentence, "id">[] = [];
  let currentHeading = "";

  if (
    traversalRoot.nodeType === 1 &&
    HEADING_TAG_PATTERN.test((traversalRoot as Element).tagName) &&
    !isExcludedOrHidden(traversalRoot as Element)
  ) {
    currentHeading = headingText(traversalRoot as Element);
  }

  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (current.nodeType === 1) {
      const element = current as Element;
      if (
        HEADING_TAG_PATTERN.test(element.tagName) &&
        !isExcludedOrHidden(element)
      ) {
        currentHeading = headingText(element);
      }
      continue;
    }

    const node = current as Text;
    if (isExcludedOrHidden(node.parentElement) || !node.data.trim()) {
      continue;
    }

    for (const part of segmenter.segment(node.data)) {
      const range = trimmedSegmentRange(node.data, part.index, part.segment);
      if (!range || !isTranslationCandidate(range.text)) {
        continue;
      }

      candidates.push({
        text: range.text,
        sectionHeading: currentHeading,
        node,
        start: range.start,
        end: range.end,
      });
    }
  }

  return candidates.map((candidate, index) => ({
    ...candidate,
    id: `sentence-${String(index + 1).padStart(4, "0")}`,
  }));
}
