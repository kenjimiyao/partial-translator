import type { ExtractedSentence, TranslationItem } from "./types";

export class TranslationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranslationValidationError";
  }
}

export function validateTranslations(
  candidates: readonly ExtractedSentence[],
  translations: unknown,
): TranslationItem[] {
  if (!Array.isArray(translations)) {
    throw new TranslationValidationError("翻訳レスポンスの形式が不正です。");
  }

  const candidateIds = new Set(candidates.map(({ id }) => id));
  const seen = new Set<string>();

  return translations.map((value) => {
    if (!value || typeof value !== "object") {
      throw new TranslationValidationError("翻訳レスポンスの項目が不正です。");
    }

    const record = value as Record<string, unknown>;
    if (typeof record.id !== "string" || !candidateIds.has(record.id)) {
      throw new TranslationValidationError("翻訳レスポンスに未知のIDがあります。");
    }
    if (seen.has(record.id)) {
      throw new TranslationValidationError("翻訳レスポンスに重複したIDがあります。");
    }
    if (typeof record.english !== "string" || !record.english.trim()) {
      throw new TranslationValidationError("空の翻訳が返されました。");
    }

    seen.add(record.id);
    return { id: record.id, english: record.english.trim() };
  });
}

export class TranslationSession {
  private restored = false;

  constructor(
    private readonly snapshots: Map<
      Text,
      { original: string; translated: string }
    >,
  ) {}

  restore(): boolean {
    if (this.restored) {
      return true;
    }

    for (const [node, snapshot] of this.snapshots) {
      // Do not overwrite text that the page changed after translation (common in SPAs).
      if (node.data === snapshot.translated) {
        node.data = snapshot.original;
        this.snapshots.delete(node);
      }
    }
    this.restored = this.snapshots.size === 0;
    return this.restored;
  }
}

/**
 * Applies all replacements atomically from the caller's perspective. Ranges within
 * each Text node are processed in descending order, so earlier offsets stay valid.
 */
export function applyTranslations(
  candidates: readonly ExtractedSentence[],
  translations: readonly TranslationItem[],
): TranslationSession {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const replacements = translations.map((translation) => {
    const candidate = byId.get(translation.id);
    if (!candidate) {
      throw new TranslationValidationError("翻訳対象のIDが見つかりません。");
    }
    return { candidate, english: translation.english };
  });

  const originals = new Map<Text, string>();
  for (const { candidate } of replacements) {
    if (!originals.has(candidate.node)) {
      originals.set(candidate.node, candidate.node.data);
    }
    if (
      !candidate.node.isConnected ||
      candidate.node.data.slice(candidate.start, candidate.end) !== candidate.text
    ) {
      throw new TranslationValidationError(
        "処理中にページ内容が変更されたため、翻訳を適用できませんでした。",
      );
    }
  }

  try {
    const byNode = new Map<
      Text,
      Array<(typeof replacements)[number]>
    >();
    for (const replacement of replacements) {
      const group = byNode.get(replacement.candidate.node) ?? [];
      group.push(replacement);
      byNode.set(replacement.candidate.node, group);
    }

    for (const group of byNode.values()) {
      group.sort((left, right) => right.candidate.start - left.candidate.start);
      for (const { candidate, english } of group) {
        candidate.node.replaceData(
          candidate.start,
          candidate.end - candidate.start,
          english,
        );
      }
    }
  } catch (error) {
    for (const [node, original] of originals) {
      node.data = original;
    }
    throw error;
  }

  const snapshots = new Map<
    Text,
    { original: string; translated: string }
  >();
  for (const [node, original] of originals) {
    snapshots.set(node, { original, translated: node.data });
  }
  return new TranslationSession(snapshots);
}
