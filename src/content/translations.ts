import type { ExtractedSentence, TranslationItem } from "./types";

export class TranslationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranslationValidationError";
  }
}

interface ActiveReplacement {
  original: string;
  start: number;
  end: number;
}

interface NodeSnapshot {
  original: string;
  expected: string;
  replacements: ActiveReplacement[];
}

export type RestoreAtResult = "restored" | "conflict" | "none";

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
    private readonly snapshots: Map<Text, NodeSnapshot>,
  ) {}

  get hasActiveTranslations(): boolean {
    return this.snapshots.size > 0;
  }

  restoreAt(node: Text, offset: number): RestoreAtResult {
    if (this.restored) {
      return "none";
    }

    const snapshot = this.snapshots.get(node);
    if (!snapshot) {
      return "none";
    }
    const replacementIndex = snapshot.replacements.findIndex(
      (replacement) =>
        offset >= replacement.start && offset <= replacement.end,
    );
    if (replacementIndex < 0) {
      return "none";
    }
    if (!node.isConnected || node.data !== snapshot.expected) {
      return "conflict";
    }

    const replacement = snapshot.replacements[replacementIndex];
    const translatedLength = replacement.end - replacement.start;
    try {
      node.replaceData(
        replacement.start,
        translatedLength,
        replacement.original,
      );
    } catch {
      return "conflict";
    }

    const offsetDelta = replacement.original.length - translatedLength;
    snapshot.replacements.splice(replacementIndex, 1);
    for (const remaining of snapshot.replacements) {
      if (remaining.start > replacement.start) {
        remaining.start += offsetDelta;
        remaining.end += offsetDelta;
      }
    }
    snapshot.expected = node.data;

    if (snapshot.replacements.length === 0) {
      this.snapshots.delete(node);
    }
    this.restored = this.snapshots.size === 0;
    return "restored";
  }

  restore(): boolean {
    if (this.restored) {
      return true;
    }

    for (const [node, snapshot] of this.snapshots) {
      // Do not overwrite text that the page changed after translation (common in SPAs).
      if (node.isConnected && node.data === snapshot.expected) {
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

  const byNode = new Map<
    Text,
    Array<(typeof replacements)[number]>
  >();
  for (const replacement of replacements) {
    const group = byNode.get(replacement.candidate.node) ?? [];
    group.push(replacement);
    byNode.set(replacement.candidate.node, group);
  }

  try {
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

  const snapshots = new Map<Text, NodeSnapshot>();
  for (const [node, original] of originals) {
    const group = byNode.get(node) ?? [];
    let offsetDelta = 0;
    const activeReplacements = [...group]
      .sort((left, right) => left.candidate.start - right.candidate.start)
      .map(({ candidate, english }) => {
        const start = candidate.start + offsetDelta;
        const end = start + english.length;
        offsetDelta +=
          english.length - (candidate.end - candidate.start);
        return {
          original: candidate.text,
          start,
          end,
        };
      });
    snapshots.set(node, {
      original,
      expected: node.data,
      replacements: activeReplacements,
    });
  }
  return new TranslationSession(snapshots);
}
