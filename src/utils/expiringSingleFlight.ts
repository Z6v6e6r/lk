export interface ExpiringSingleFlightOptions<T> {
  ttlMs: number;
  maxEntries: number;
  shouldCache?: (value: T) => boolean;
  now?: () => number;
}

export interface ExpiringSingleFlightRunOptions {
  forceFresh?: boolean;
}

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

interface InflightEntry<T> {
  epoch: number;
  keyVersion: number;
  forceFresh: boolean;
  promise: Promise<T>;
}

export class ExpiringSingleFlight<T> {
  private readonly cache = new Map<string, CacheEntry<T>>();
  private readonly inflight = new Map<string, InflightEntry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly shouldCache: (value: T) => boolean;
  private readonly now: () => number;
  private readonly keyVersions = new Map<string, number>();
  private epoch = 0;

  constructor(options: ExpiringSingleFlightOptions<T>) {
    this.ttlMs = Math.max(0, options.ttlMs);
    this.maxEntries = Math.max(1, Math.trunc(options.maxEntries));
    this.shouldCache = options.shouldCache ?? (() => true);
    this.now = options.now ?? Date.now;
  }

  clear() {
    this.epoch += 1;
    this.cache.clear();
    this.inflight.clear();
    this.keyVersions.clear();
  }

  private invalidateKey(key: string) {
    this.cache.delete(key);
    this.inflight.delete(key);
    this.keyVersions.set(key, (this.keyVersions.get(key) ?? 0) + 1);
  }

  private readCached(key: string): CacheEntry<T> | null {
    const cached = this.cache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= this.now()) {
      this.cache.delete(key);
      return null;
    }

    this.cache.delete(key);
    this.cache.set(key, cached);
    return cached;
  }

  private writeCached(key: string, value: T) {
    if (this.ttlMs <= 0 || !this.shouldCache(value)) return;
    this.cache.delete(key);
    while (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, {
      expiresAt: this.now() + this.ttlMs,
      value,
    });
  }

  run(
    key: string,
    loader: () => Promise<T>,
    options: ExpiringSingleFlightRunOptions = {},
  ): Promise<T> {
    const forceFresh = options.forceFresh === true;
    const currentInflight = this.inflight.get(key);
    if (
      forceFresh
      && currentInflight?.forceFresh
      && currentInflight.epoch === this.epoch
      && currentInflight.keyVersion === (this.keyVersions.get(key) ?? 0)
    ) {
      return currentInflight.promise;
    }

    if (forceFresh) {
      this.invalidateKey(key);
    } else {
      const cached = this.readCached(key);
      if (cached !== null) return Promise.resolve(cached.value);
      if (
        currentInflight
        && currentInflight.epoch === this.epoch
        && currentInflight.keyVersion === (this.keyVersions.get(key) ?? 0)
      ) {
        return currentInflight.promise;
      }
    }

    const epoch = this.epoch;
    const keyVersion = this.keyVersions.get(key) ?? 0;
    const promise = Promise.resolve().then(loader).then(
      (value) => {
        if (
          this.epoch === epoch
          && (this.keyVersions.get(key) ?? 0) === keyVersion
          && this.inflight.get(key)?.promise === promise
        ) {
          this.writeCached(key, value);
        }
        return value;
      },
      (error) => {
        throw error;
      },
    ).finally(() => {
      if (this.inflight.get(key)?.promise === promise) {
        this.inflight.delete(key);
      }
    });
    const entry: InflightEntry<T> = { epoch, keyVersion, forceFresh, promise };
    this.inflight.set(key, entry);

    return promise;
  }
}
