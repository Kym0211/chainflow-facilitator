import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimiter } from "../src/rate-limiter.js";

describe("RateLimiter", () => {
  let rl: RateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    rl = new RateLimiter(3, 1000, 10_000);
  });

  afterEach(() => {
    rl.dispose();
    vi.useRealTimers();
  });

  it("allows requests up to the limit, then denies", () => {
    expect(rl.isAllowed("a")).toBe(true);
    expect(rl.isAllowed("a")).toBe(true);
    expect(rl.isAllowed("a")).toBe(true);
    expect(rl.isAllowed("a")).toBe(false);
  });

  it("tracks counters per key independently", () => {
    for (let i = 0; i < 3; i++) rl.isAllowed("a");
    expect(rl.isAllowed("a")).toBe(false);
    expect(rl.isAllowed("b")).toBe(true);
  });

  it("frees capacity once timestamps fall outside the window", () => {
    for (let i = 0; i < 3; i++) rl.isAllowed("a");
    expect(rl.isAllowed("a")).toBe(false);

    vi.advanceTimersByTime(1001);
    expect(rl.isAllowed("a")).toBe(true);
  });

  it("reports remaining capacity", () => {
    expect(rl.remaining("a")).toBe(3);
    rl.isAllowed("a");
    expect(rl.remaining("a")).toBe(2);
  });

  it("sweep() removes keys with no timestamps in the window", () => {
    rl.isAllowed("a");
    rl.isAllowed("b");
    expect(rl.size()).toBe(2);

    vi.advanceTimersByTime(1001);
    expect(rl.sweep()).toBe(2);
    expect(rl.size()).toBe(0);
  });

  it("sweep() keeps keys whose timestamps are still valid", () => {
    rl.isAllowed("a");
    vi.advanceTimersByTime(500);
    rl.isAllowed("b");

    vi.advanceTimersByTime(600);
    // "a" is now stale; "b" still valid
    expect(rl.sweep()).toBe(1);
    expect(rl.size()).toBe(1);
  });

  it("dispose() stops the background sweep", () => {
    const sweepSpy = vi.spyOn(rl, "sweep");
    rl.dispose();
    vi.advanceTimersByTime(100_000);
    expect(sweepSpy).not.toHaveBeenCalled();
  });
});
