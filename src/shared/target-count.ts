export function calculateTargetCount(candidateCount: number, percentage: number): number {
  if (!Number.isFinite(candidateCount) || candidateCount <= 0) {
    return 0;
  }

  const normalizedCount = Math.floor(candidateCount);
  const normalizedPercentage = Math.min(100, Math.max(0, percentage));
  if (normalizedPercentage === 0) {
    return 0;
  }

  return Math.min(
    normalizedCount,
    Math.max(1, Math.round((normalizedCount * normalizedPercentage) / 100)),
  );
}
