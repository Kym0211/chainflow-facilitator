import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type FacilitatorLike, type ReadinessProbe } from "../src/app.js";
import { RateLimiter } from "../src/rate-limiter.js";

function buildDeps(overrides: Partial<Parameters<typeof createApp>[0]> = {}) {
  const facilitator: FacilitatorLike = {
    verify: vi.fn(async () => ({ isValid: true, payer: "payer-addr" })),
    settle: vi.fn(async () => ({ success: true, transaction: "sig-123" })),
    getSupported: vi.fn(() => ({ kinds: [] })),
  };
  const rateLimiter = new RateLimiter(5, 60_000, 3_600_000);
  const readinessProbe: ReadinessProbe = vi.fn(async () => ({ ok: true, blockhash: "bh-1" } as const));
  return {
    facilitator,
    rateLimiter,
    readinessProbe,
    walletAddress: "wallet-addr",
    trustProxy: false,
    network: "solana:test",
    ...overrides,
  };
}

const validBody = {
  paymentPayload: { x402Version: 2 },
  paymentRequirements: { scheme: "exact" },
};

describe("createApp", () => {
  let deps: ReturnType<typeof buildDeps>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    deps = buildDeps();
    app = createApp(deps);
  });

  afterEach(() => {
    deps.rateLimiter.dispose();
  });

  describe("GET /livez", () => {
    it("returns 200 without hitting any dependency", async () => {
      const res = await app.request("/livez");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
      expect(deps.readinessProbe).not.toHaveBeenCalled();
    });
  });

  describe("GET /readyz", () => {
    it("returns 200 on first call and invokes the probe", async () => {
      const res = await app.request("/readyz");
      expect(res.status).toBe(200);
      expect(deps.readinessProbe).toHaveBeenCalledTimes(1);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.blockhash).toBe("bh-1");
    });

    it("caches and does not hit the probe twice in quick succession", async () => {
      await app.request("/readyz");
      await app.request("/readyz");
      expect(deps.readinessProbe).toHaveBeenCalledTimes(1);
    });

    it("returns 503 when the probe reports failure", async () => {
      const deps2 = buildDeps({
        readinessProbe: vi.fn(async () => ({ ok: false, reason: "rpc down" } as const)),
      });
      const app2 = createApp(deps2);
      const res = await app2.request("/readyz");
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.status).toBe("degraded");
      deps2.rateLimiter.dispose();
    });
  });

  describe("POST /verify", () => {
    it("returns the facilitator response on valid input", async () => {
      const res = await app.request("/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ isValid: true, payer: "payer-addr" });
      expect(deps.facilitator.verify).toHaveBeenCalledWith(
        validBody.paymentPayload,
        validBody.paymentRequirements,
      );
    });

    it("returns 400 with requestId when fields are missing", async () => {
      const res = await app.request("/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Missing/);
      expect(body.requestId).toBeDefined();
    });

    it("returns 500 with generic error message when the facilitator throws", async () => {
      deps.facilitator.verify = vi.fn(async () => {
        throw new Error("secret internal info");
      });
      const res = await app.request("/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Internal error");
      expect(body).not.toHaveProperty("stack");
      expect(JSON.stringify(body)).not.toContain("secret internal info");
    });

    it("rejects oversized bodies with 413", async () => {
      const big = "x".repeat(80 * 1024);
      const res = await app.request("/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validBody, blob: big }),
      });
      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error).toMatch(/too large/i);
    });
  });

  describe("POST /settle", () => {
    it("returns the facilitator response on valid input", async () => {
      const res = await app.request("/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, transaction: "sig-123" });
    });
  });

  describe("X-Request-Id", () => {
    it("mints a request id when none is provided", async () => {
      const res = await app.request("/livez");
      expect(res.headers.get("x-request-id")).toMatch(/^[\w-]{8,}/);
    });

    it("echoes a valid inbound X-Request-Id", async () => {
      const res = await app.request("/livez", { headers: { "X-Request-Id": "my-trace-abc" } });
      expect(res.headers.get("x-request-id")).toBe("my-trace-abc");
    });

    it("ignores malformed inbound X-Request-Id", async () => {
      const res = await app.request("/livez", { headers: { "X-Request-Id": "bad id with spaces" } });
      const returned = res.headers.get("x-request-id")!;
      expect(returned).not.toBe("bad id with spaces");
      expect(returned).toMatch(/^[\w-]{8,}/);
    });
  });

  describe("rate limiting", () => {
    it("returns 429 after the per-IP cap is hit", async () => {
      const limited = buildDeps({ rateLimiter: new RateLimiter(2, 60_000, 3_600_000) });
      const app2 = createApp(limited);

      const first = await app2.request("/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });
      const second = await app2.request("/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });
      const third = await app2.request("/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(third.status).toBe(429);
      limited.rateLimiter.dispose();
    });

    it("does not rate limit /livez or /readyz", async () => {
      const limited = buildDeps({ rateLimiter: new RateLimiter(1, 60_000, 3_600_000) });
      const app2 = createApp(limited);

      for (let i = 0; i < 5; i++) {
        const res = await app2.request("/livez");
        expect(res.status).toBe(200);
      }
      limited.rateLimiter.dispose();
    });
  });
});
