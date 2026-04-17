import { createHash } from "node:crypto";

/**
 * One cached /settle result — status code + response body, so a replay
 * returns byte-for-byte what the original caller saw.
 */
export interface CachedSettle {
  statusCode: number;
  response: unknown;
  cachedAt: number;
}

export interface IdempotencyCache {
  /** Returns cached result if present and not expired, else null. */
  get(key: string): CachedSettle | null;
  /** Store or overwrite a cached result. */
  put(key: string, value: Omit<CachedSettle, "cachedAt">): void;
  /** Reserve a key as "in flight" so concurrent duplicates see the same pending promise. */
  reserve(key: string, promise: Promise<CachedSettle>): void;
  /** Get the in-flight promise for a key, if any. */
  inflight(key: string): Promise<CachedSettle> | null;
  /** Count of entries — for tests. */
  size(): number;
  dispose(): void;
}

/**
 * In-memory idempotency cache. Keys expire after ttlMs; expired keys are
 * swept on a timer. Suitable for single-instance deployments only —
 * across replicas, duplicate settles from different clients would not
 * deduplicate. For multi-instance, back with Redis using the same interface.
 */
export class InMemoryIdempotencyCache implements IdempotencyCache {
  private readonly cache = new Map<string, CachedSettle>();
  private readonly pending = new Map<string, Promise<CachedSettle>>();
  private readonly ttlMs: number;
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(ttlMs = 10 * 60_000, sweepIntervalMs = 60_000) {
    this.ttlMs = ttlMs;
    this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweepTimer.unref();
  }

  get(key: string): CachedSettle | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    return entry;
  }

  put(key: string, value: Omit<CachedSettle, "cachedAt">): void {
    this.cache.set(key, { ...value, cachedAt: Date.now() });
  }

  reserve(key: string, promise: Promise<CachedSettle>): void {
    this.pending.set(key, promise);
    promise.finally(() => {
      // Clear only if this is still the same promise (don't clobber a newer one).
      if (this.pending.get(key) === promise) this.pending.delete(key);
    });
  }

  inflight(key: string): Promise<CachedSettle> | null {
    return this.pending.get(key) ?? null;
  }

  size(): number {
    return this.cache.size;
  }

  sweep(): number {
    const now = Date.now();
    let removed = 0;
    for (const [k, v] of this.cache) {
      if (now - v.cachedAt > this.ttlMs) {
        this.cache.delete(k);
        removed++;
      }
    }
    return removed;
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
  }
}

/**
 * Derive a deterministic key from the settle inputs. Keyed on the signed
 * transaction (the unique artifact that moves money) plus the payment
 * requirements — two different requirements for the same tx are distinct
 * requests and shouldn't dedupe.
 */
export function idempotencyKey(payload: unknown, requirements: unknown): string {
  const h = createHash("sha256");
  // stable-stringify via JSON.stringify is fine here — both are POJOs from
  // JSON body parsing, key order is preserved by the caller's serialization
  // on the way in. When it matters (e.g. Solana signed-tx base64), we include
  // the transaction field directly so order of surrounding keys can't affect it.
  const payloadObj = payload as { payload?: { transaction?: unknown } } | null;
  const signedTx = payloadObj?.payload?.transaction;
  if (signedTx !== undefined) h.update(String(signedTx));
  h.update("\0");
  h.update(JSON.stringify(requirements ?? null));
  return h.digest("hex");
}
