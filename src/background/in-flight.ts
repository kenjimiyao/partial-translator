interface PendingWork<T> {
  epoch: number;
  promise: Promise<T>;
}

export interface InFlightWork<T> {
  epoch: number;
  promise: Promise<T>;
}

/**
 * Deduplicates equal work while allowing a cache clear to invalidate every
 * pending result without attempting to cancel the underlying network request.
 */
export class InFlightWorkRegistry<T> {
  private currentEpoch = 0;
  private readonly pending = new Map<string, PendingWork<T>>();

  getOrCreate(
    key: string,
    create: (epoch: number) => Promise<T>,
  ): InFlightWork<T> {
    const existing = this.pending.get(key);
    if (existing) {
      return existing;
    }

    const epoch = this.currentEpoch;
    const promise = create(epoch);
    const work = { epoch, promise };
    this.pending.set(key, work);

    const removeIfCurrent = () => {
      if (this.pending.get(key)?.promise === promise) {
        this.pending.delete(key);
      }
    };
    void promise.then(removeIfCurrent, removeIfCurrent);

    return work;
  }

  isCurrent(epoch: number): boolean {
    return epoch === this.currentEpoch;
  }

  invalidate(): void {
    this.currentEpoch += 1;
    this.pending.clear();
  }
}
