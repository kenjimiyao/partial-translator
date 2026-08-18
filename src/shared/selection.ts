import type {
  TranslationInputItem,
  TranslationPromptItem,
} from "./types";

const WHITESPACE_PATTERN = /\s/u;
const MAX_EXACT_PLAN_BITS = 64_000_000;

function shouldUseApproximatePlan(
  items: readonly Pick<TranslationPromptItem, "character_count">[],
  targetCharacters: number,
): boolean {
  const totalCharacters = totalSourceCharacters(items);
  const longestSentence = items.reduce(
    (longest, item) => Math.max(longest, item.character_count),
    0,
  );
  const upperBound = Math.min(
    totalCharacters,
    targetCharacters + longestSentence,
  );
  return items.length * (upperBound + 1) > MAX_EXACT_PLAN_BITS;
}

/** Count Unicode code points in the source sentence, excluding whitespace. */
export function countSourceCharacters(text: string): number {
  let count = 0;
  for (const character of text) {
    if (!WHITESPACE_PATTERN.test(character)) {
      count += 1;
    }
  }
  return count;
}

export function addSelectionMetadata(
  items: readonly TranslationInputItem[],
): TranslationPromptItem[] {
  return items.map((item, position) => ({
    ...item,
    position,
    character_count: countSourceCharacters(item.text),
  }));
}

export function calculateTargetCharacters(
  items: readonly Pick<TranslationInputItem, "text">[],
  percentage: number,
): number {
  const totalCharacters = items.reduce(
    (sum, item) => sum + countSourceCharacters(item.text),
    0,
  );
  if (totalCharacters === 0) {
    return 0;
  }

  const normalizedPercentage = Math.min(100, Math.max(0, percentage));
  if (normalizedPercentage === 0) {
    return 0;
  }

  return Math.min(
    totalCharacters,
    Math.max(1, Math.round((totalCharacters * normalizedPercentage) / 100)),
  );
}

export function totalSourceCharacters(
  items: readonly Pick<TranslationPromptItem, "character_count">[],
): number {
  return items.reduce((sum, item) => sum + item.character_count, 0);
}

export function canAvoidAdjacentSelection(
  items: readonly Pick<TranslationPromptItem, "position" | "character_count">[],
  targetCharacters: number,
): boolean {
  // Prefer spacing when it costs no more than the same two-percentage-point
  // arithmetic margin accepted from the model response.
  const arithmeticMargin = Math.ceil(totalSourceCharacters(items) * 0.02);
  return (
    minimumSelectionDifference(items, targetCharacters, true) <=
    minimumSelectionDifference(items, targetCharacters, false) + arithmeticMargin
  );
}

export function minimumSelectionDifference(
  items: readonly Pick<TranslationPromptItem, "position" | "character_count">[],
  targetCharacters: number,
  avoidAdjacent: boolean,
): number {
  const totalCharacters = totalSourceCharacters(items);
  if (targetCharacters <= 0 || items.length === 0) {
    return 0;
  }
  if (shouldUseApproximatePlan(items, targetCharacters)) {
    const plan = selectApproximateCharacterPlan(
      items,
      targetCharacters,
      avoidAdjacent,
    );
    return Math.abs(
      totalSourceCharacters(plan) - targetCharacters,
    );
  }

  // One source sentence is the unavoidable granularity of the percentage.
  const longestSentence = items.reduce(
    (longest, item) => Math.max(longest, item.character_count),
    0,
  );
  const upperBound = Math.min(
    totalCharacters,
    targetCharacters + longestSentence,
  );
  const mask = (1n << BigInt(upperBound + 1)) - 1n;
  let included = 0n;
  let excluded = 1n;
  let previousPosition: number | undefined;

  for (const item of items) {
    const shift = BigInt(item.character_count);
    if (
      avoidAdjacent &&
      previousPosition !== undefined &&
      item.position === previousPosition + 1
    ) {
      const nextIncluded = (excluded << shift) & mask;
      excluded = (included | excluded) & mask;
      included = nextIncluded;
    } else {
      const reachable = included | excluded;
      included = (reachable << shift) & mask;
      excluded = reachable & mask;
    }
    previousPosition = item.position;
  }

  const reachable = included | excluded;
  let minimumDifference = Math.max(targetCharacters, totalCharacters);
  for (
    let difference = 0;
    difference <= Math.max(targetCharacters, totalCharacters);
    difference += 1
  ) {
    const lower = targetCharacters - difference;
    if (lower > 0 && ((reachable >> BigInt(lower)) & 1n) === 1n) {
      minimumDifference = difference;
      break;
    }
    const upper = targetCharacters + difference;
    if (
      upper <= upperBound &&
      upper > 0 &&
      ((reachable >> BigInt(upper)) & 1n) === 1n
    ) {
      minimumDifference = difference;
      break;
    }
  }

  return minimumDifference;
}

export function selectClosestCharacterPlan<T extends Pick<
  TranslationPromptItem,
  "position" | "character_count"
>>(
  items: readonly T[],
  targetCharacters: number,
  avoidAdjacent: boolean,
): T[] {
  if (targetCharacters <= 0 || items.length === 0) {
    return [];
  }

  const totalCharacters = totalSourceCharacters(items);
  const longestSentence = items.reduce(
    (longest, item) => Math.max(longest, item.character_count),
    0,
  );
  const upperBound = Math.min(
    totalCharacters,
    targetCharacters + longestSentence,
  );
  if (shouldUseApproximatePlan(items, targetCharacters)) {
    return selectApproximateCharacterPlan(
      items,
      targetCharacters,
      avoidAdjacent,
    );
  }
  const mask = (1n << BigInt(upperBound + 1)) - 1n;
  const snapshots: Array<{ included: bigint; excluded: bigint }> = [
    { included: 0n, excluded: 1n },
  ];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const previous = snapshots[index];
    const consecutive =
      avoidAdjacent &&
      index > 0 &&
      item.position === items[index - 1].position + 1;
    const selectableBase = consecutive
      ? previous.excluded
      : previous.included | previous.excluded;
    snapshots.push({
      included: (selectableBase << BigInt(item.character_count)) & mask,
      excluded: (previous.included | previous.excluded) & mask,
    });
  }

  const final = snapshots.at(-1)!;
  const reachable = final.included | final.excluded;
  let selectedTotal = 0;
  for (
    let difference = 0;
    difference <= Math.max(targetCharacters, totalCharacters);
    difference += 1
  ) {
    const lower = targetCharacters - difference;
    if (lower > 0 && ((reachable >> BigInt(lower)) & 1n) === 1n) {
      selectedTotal = lower;
      break;
    }
    const upper = targetCharacters + difference;
    if (
      upper <= upperBound &&
      upper > 0 &&
      ((reachable >> BigInt(upper)) & 1n) === 1n
    ) {
      selectedTotal = upper;
      break;
    }
  }

  const averageCharacters = totalCharacters / items.length;
  const estimatedSelectionCount = Math.min(
    items.length,
    Math.max(1, Math.round(selectedTotal / averageCharacters)),
  );
  const preferredIndexes = new Set<number>();
  for (let index = 0; index < estimatedSelectionCount; index += 1) {
    preferredIndexes.add(
      Math.min(
        items.length - 1,
        Math.floor(((index + 0.5) * items.length) / estimatedSelectionCount),
      ),
    );
  }

  type RequiredState = "either" | "excluded";
  let requiredState: RequiredState = "either";
  let remaining = selectedTotal;
  const selected: T[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const current = snapshots[index + 1];
    const canSelect =
      requiredState !== "excluded" &&
      remaining >= item.character_count &&
      ((current.included >> BigInt(remaining)) & 1n) === 1n;
    const canSkip =
      ((current.excluded >> BigInt(remaining)) & 1n) === 1n;
    const select =
      canSelect && (!canSkip || preferredIndexes.has(index));

    if (select) {
      selected.push(item);
      remaining -= item.character_count;
      const consecutive =
        avoidAdjacent &&
        index > 0 &&
        item.position === items[index - 1].position + 1;
      requiredState = consecutive ? "excluded" : "either";
    } else if (canSkip) {
      requiredState = "either";
    } else if (canSelect) {
      selected.push(item);
      remaining -= item.character_count;
      const consecutive =
        avoidAdjacent &&
        index > 0 &&
        item.position === items[index - 1].position + 1;
      requiredState = consecutive ? "excluded" : "either";
    } else {
      throw new Error("Unable to reconstruct the translation selection");
    }
  }

  if (remaining !== 0) {
    throw new Error("Unable to reconstruct the translation selection");
  }
  return selected.reverse();
}

function selectApproximateCharacterPlan<T extends Pick<
  TranslationPromptItem,
  "position" | "character_count"
>>(
  items: readonly T[],
  targetCharacters: number,
  avoidAdjacent: boolean,
): T[] {
  const totalCharacters = totalSourceCharacters(items);
  const averageCharacters = totalCharacters / items.length;
  const desiredCount = Math.min(
    avoidAdjacent ? Math.ceil(items.length / 2) : items.length,
    Math.max(1, Math.round(targetCharacters / averageCharacters)),
  );
  const selectedIndexes = new Set<number>();
  const selectedPositions = new Set<number>();

  const canSelect = (index: number): boolean => {
    if (selectedIndexes.has(index)) {
      return false;
    }
    const position = items[index].position;
    return (
      !avoidAdjacent ||
      (!selectedPositions.has(position - 1) &&
        !selectedPositions.has(position + 1))
    );
  };

  for (let selection = 0; selection < desiredCount; selection += 1) {
    const anchor = Math.min(
      items.length - 1,
      Math.floor(((selection + 0.5) * items.length) / desiredCount),
    );
    for (let distance = 0; distance < items.length; distance += 1) {
      const candidates = distance === 0
        ? [anchor]
        : [anchor - distance, anchor + distance];
      const index = candidates.find(
        (candidate) =>
          candidate >= 0 && candidate < items.length && canSelect(candidate),
      );
      if (index !== undefined) {
        selectedIndexes.add(index);
        selectedPositions.add(items[index].position);
        break;
      }
    }
  }

  let selectedCharacters = [...selectedIndexes].reduce(
    (sum, index) => sum + items[index].character_count,
    0,
  );
  for (
    let iteration = 0;
    iteration < Math.min(items.length, 100);
    iteration += 1
  ) {
    const currentDifference = Math.abs(selectedCharacters - targetCharacters);
    let best:
      | { type: "add" | "remove"; index: number; characters: number }
      | undefined;
    let bestDifference = currentDifference;

    for (let index = 0; index < items.length; index += 1) {
      if (selectedIndexes.has(index)) {
        if (selectedIndexes.size === 1) {
          continue;
        }
        const nextCharacters = selectedCharacters - items[index].character_count;
        const difference = Math.abs(nextCharacters - targetCharacters);
        if (difference < bestDifference) {
          best = { type: "remove", index, characters: nextCharacters };
          bestDifference = difference;
        }
      } else if (canSelect(index)) {
        const nextCharacters = selectedCharacters + items[index].character_count;
        const difference = Math.abs(nextCharacters - targetCharacters);
        if (difference < bestDifference) {
          best = { type: "add", index, characters: nextCharacters };
          bestDifference = difference;
        }
      }
    }

    if (!best) {
      break;
    }
    if (best.type === "add") {
      selectedIndexes.add(best.index);
      selectedPositions.add(items[best.index].position);
    } else {
      selectedIndexes.delete(best.index);
      selectedPositions.delete(items[best.index].position);
    }
    selectedCharacters = best.characters;
  }

  return [...selectedIndexes]
    .sort((left, right) => left - right)
    .map((index) => items[index]);
}

export function characterTargetTolerance(
  items: readonly Pick<TranslationPromptItem, "position" | "character_count">[],
  targetCharacters: number,
  avoidAdjacent: boolean,
): number {
  const totalCharacters = totalSourceCharacters(items);
  if (targetCharacters >= totalCharacters) {
    return 0;
  }

  const arithmeticMargin = Math.ceil(totalCharacters * 0.02);
  if (shouldUseApproximatePlan(items, targetCharacters)) {
    return (
      minimumSelectionDifference(items, targetCharacters, avoidAdjacent) +
      arithmeticMargin
    );
  }

  // Allow two percentage points for model arithmetic while never being
  // stricter than the closest combination that sentence granularity permits.
  return Math.max(
    minimumSelectionDifference(items, targetCharacters, avoidAdjacent),
    arithmeticMargin,
  );
}
