/**
 * Simple in-memory rate limiter using a sliding window.
 * Tracks requests per IP address.
 */
export class RateLimiter {
  private readonly requests = new Map<string, number[]>();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  /**
   * @param maxRequests - Maximum requests allowed per window
   * @param windowMs - Window duration in milliseconds
   */
  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /**
   * Check if a request from this key should be allowed.
   * Returns true if allowed, false if rate limited.
   */
  isAllowed(key: string): boolean {
    const now = Date.now();
    const timestamps = this.requests.get(key) || [];

    // Remove timestamps outside the window
    const valid = timestamps.filter((t) => now - t < this.windowMs);

    if (valid.length >= this.maxRequests) {
      this.requests.set(key, valid);
      return false;
    }

    valid.push(now);
    this.requests.set(key, valid);
    return true;
  }

  /**
   * Get remaining requests for a key in the current window.
   */
  remaining(key: string): number {
    const now = Date.now();
    const timestamps = this.requests.get(key) || [];
    const valid = timestamps.filter((t) => now - t < this.windowMs);
    return Math.max(0, this.maxRequests - valid.length);
  }
}