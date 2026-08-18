/** Maps values with a fixed worker pool and preserves input order. */
export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapValue: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Concurrency must be a positive integer");
  }

  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let stopped = false;
  let failure: unknown;

  const runWorker = async (): Promise<void> => {
    while (!stopped) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) {
        return;
      }

      try {
        results[index] = await mapValue(values[index], index);
      } catch (error) {
        if (!stopped) {
          stopped = true;
          failure = error;
        }
      }
    }
  };

  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(
    Array.from({ length: workerCount }, () => runWorker()),
  );

  if (stopped) {
    throw failure;
  }
  return results;
}
