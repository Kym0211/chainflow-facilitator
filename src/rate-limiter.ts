/**
 * Sliding-window in-memory rate limiter keyed by arbitrary string (e.g. IP).
 * Periodically sweeps idle keys so the internal Map doesn't grow unbounded.
 */
export class RateLimiter {
  private readonly requests = new Map<string, number[]>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(maxRequests: number, windowMs: number, sweepIntervalMs = 60_000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweepTimer.unref();
  }

  isAllowed(key: string): boolean {
    const now = Date.now();
    const valid = (this.requests.get(key) || []).filter((t) => now - t < this.windowMs);

    if (valid.length >= this.maxRequests) {
      this.requests.set(key, valid);
      return false;
    }

    valid.push(now);
    this.requests.set(key, valid);
    return true;
  }

  remaining(key: string): number {
    const now = Date.now();
    const valid = (this.requests.get(key) || []).filter((t) => now - t < this.windowMs);
    return Math.max(0, this.maxRequests - valid.length);
  }

  /** Remove keys whose entire window has expired. O(n) but runs rarely. */
  sweep(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, timestamps] of this.requests) {
      const valid = timestamps.filter((t) => now - t < this.windowMs);
      if (valid.length === 0) {
        this.requests.delete(key);
        removed++;
      } else if (valid.length !== timestamps.length) {
        this.requests.set(key, valid);
      }
    }
    return removed;
  }

  /** Visible size (post-sweep). Useful for tests / debug. */
  size(): number {
    return this.requests.size;
  }

  /** Stop the sweep timer — call from shutdown. */
  dispose(): void {
    clearInterval(this.sweepTimer);
  }
}
