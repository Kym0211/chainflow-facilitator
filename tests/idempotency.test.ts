import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryIdempotencyCache, idempotencyKey } from "../src/idempotency.js";

describe("idempotencyKey", () => {
  it("produces the same key for identical (payload, requirements)", () => {
    const payload = { payload: { transaction: "base64sig==" } };
    const req = { scheme: "exact", amount: "100" };
    expect(idempotencyKey(payload, req)).toBe(idempotencyKey(payload, req));
  });

  it("produces a different key when the signed transaction differs", () => {
    const req = { scheme: "exact", amount: "100" };
    const a = idempotencyKey({ payload: { transaction: "tx-a" } }, req);
    const b = idempotencyKey({ payload: { transaction: "tx-b" } }, req);
    expect(a).not.toBe(b);
  });

  it("produces a different key when requirements differ for the same tx", () => {
    const payload = { payload: { transaction: "same-tx" } };
    const a = idempotencyKey(payload, { amount: "100" });
    const b = idempotencyKey(payload, { amount: "200" });
    expect(a).not.toBe(b);
  });
});

describe("InMemoryIdempotencyCache", () => {
  let cache: InMemoryIdempotencyCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new InMemoryIdempotencyCache(5_000, 60_000);
  });

  afterEach(() => {
    cache.dispose();
    vi.useRealTimers();
  });

  it("returns null for missing keys", () => {
    expect(cache.get("absent")).toBeNull();
  });

  it("round-trips a stored value", () => {
    cache.put("k", { statusCode: 200, response: { ok: true } });
    const v = cache.get("k");
    expect(v?.statusCode).toBe(200);
    expect(v?.response).toEqual({ ok: true });
  });

  it("drops entries past ttlMs", () => {
    cache.put("k", { statusCode: 200, response: "r" });
    expect(cache.get("k")).not.toBeNull();
    vi.advanceTimersByTime(5_001);
    expect(cache.get("k")).toBeNull();
  });

  it("reserve() lets concurrent callers await the same in-flight promise", async () => {
    let resolve: (v: { statusCode: number; response: unknown; cachedAt: number }) => void = () => {};
    const promise = new Promise<{ statusCode: number; response: unknown; cachedAt: number }>((r) => {
      resolve = r;
    });
    cache.reserve("k", promise);

    const observer = cache.inflight("k");
    expect(observer).toBe(promise);

    resolve({ statusCode: 200, response: "done", cachedAt: Date.now() });
    await expect(observer).resolves.toMatchObject({ response: "done" });
    // Pending slot is cleared once the promise settles (microtask + finally).
    await Promise.resolve();
    expect(cache.inflight("k")).toBeNull();
  });

  it("sweep() removes expired entries", () => {
    cache.put("a", { statusCode: 200, response: 1 });
    cache.put("b", { statusCode: 200, response: 2 });
    vi.advanceTimersByTime(5_001);
    expect(cache.sweep()).toBe(2);
    expect(cache.size()).toBe(0);
  });
});
