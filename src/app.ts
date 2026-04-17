import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { activeRequests, verifyDuration, settleDuration } from "./metrics.js";
import type { RateLimiter } from "./rate-limiter.js";
import { logger } from "./logger.js";
import { randomUUID } from "node:crypto";
import type { AuditAttemptRecord, AuditCompleteRecord, AuditSink } from "./audit.js";
import { NullAuditSink } from "./audit.js";
import type { IdempotencyCache } from "./idempotency.js";
import { idempotencyKey } from "./idempotency.js";

export type Variables = { requestId: string };

export interface FacilitatorLike {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<{ isValid: boolean } & Record<string, unknown>>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<{ success: boolean } & Record<string, unknown>>;
  getSupported(): unknown;
}

export interface ReadinessProbe {
  (): Promise<{ ok: true; blockhash: string } | { ok: false; reason: string }>;
}

export interface AppDeps {
  facilitator: FacilitatorLike;
  rateLimiter: RateLimiter;
  readinessProbe: ReadinessProbe;
  walletAddress: string;
  trustProxy: boolean;
  network: string;
  readyCacheTtlMs?: number;
  maxBodyBytes?: number;
  /**
   * Origins allowed for browser CORS. Empty / omitted = no CORS headers
   * (same-origin only). Use "*" to allow any origin (not recommended for
   * production since /verify and /settle move funds).
   */
  allowedOrigins?: string[];
  /**
   * Durable audit sink. Every /settle attempt that reaches the facilitator
   * produces one record; body-limit and missing-field rejects are skipped
   * (no settle was attempted). Defaults to NullAuditSink.
   */
  auditSink?: AuditSink;
  /**
   * Idempotency cache for /settle. When provided, duplicate settles keyed
   * by (signed-tx, requirements) short-circuit to the cached response.
   * Omit to disable dedup (useful if you've moved dedup to an upstream layer).
   */
  idempotencyCache?: IdempotencyCache;
}

const DEFAULT_READY_TTL_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export function createApp(deps: AppDeps) {
  const {
    facilitator,
    rateLimiter,
    readinessProbe,
    walletAddress,
    trustProxy,
    network,
    readyCacheTtlMs = DEFAULT_READY_TTL_MS,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    allowedOrigins,
    auditSink = new NullAuditSink(),
    idempotencyCache,
  } = deps;

  const app = new Hono<{ Variables: Variables }>();

  if (allowedOrigins && allowedOrigins.length > 0) {
    const allowAny = allowedOrigins.includes("*");
    app.use(
      "*",
      cors({
        origin: (origin) => {
          if (!origin) return undefined;
          if (allowAny) return origin;
          return allowedOrigins.includes(origin) ? origin : null;
        },
        allowMethods: ["GET", "POST", "OPTIONS"],
        allowHeaders: ["Content-Type", "X-Request-Id"],
        exposeHeaders: ["X-Request-Id", "X-RateLimit-Remaining"],
        maxAge: 600,
      }),
    );
  }

  app.use("*", async (c, next) => {
    const inbound = c.req.header("x-request-id");
    const requestId = inbound && /^[\w-]{1,128}$/.test(inbound) ? inbound : randomUUID();
    c.set("requestId", requestId);
    c.header("X-Request-Id", requestId);
    return next();
  });

  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (path === "/livez" || path === "/readyz" || path === "/supported") {
      return next();
    }

    const ip = clientIp(c, trustProxy);

    if (!rateLimiter.isAllowed(ip)) {
      return c.json({ error: "Rate limit exceeded. Try again later.", requestId: c.get("requestId") }, 429);
    }

    c.header("X-RateLimit-Remaining", rateLimiter.remaining(ip).toString());
    return next();
  });

  const oversizeResponse = (c: Context) =>
    c.json({ error: "Request body too large", maxBytes: maxBodyBytes, requestId: c.get("requestId") }, 413);

  const bodyLimitMiddleware = bodyLimit({
    maxSize: maxBodyBytes,
    onError: oversizeResponse,
  });

  // Detect the body-limit streaming error by name — it's thrown inside c.req.json()
  // so our handler catch sees it before the middleware's post-check.
  const isBodyLimitError = (e: unknown): boolean =>
    e instanceof Error && e.name === "BodyLimitError";

  app.post("/verify", bodyLimitMiddleware, async (c) => {
    const requestId = c.get("requestId");
    const start = Date.now();
    activeRequests.add(1, { operation: "verify" });
    try {
      const { paymentPayload, paymentRequirements } = await c.req.json<{
        paymentPayload: PaymentPayload;
        paymentRequirements: PaymentRequirements;
      }>();

      if (!paymentPayload || !paymentRequirements) {
        return c.json({ error: "Missing paymentPayload or paymentRequirements", requestId }, 400);
      }

      const response = await facilitator.verify(paymentPayload, paymentRequirements);
      verifyDuration.record(Date.now() - start, { result: response.isValid ? "success" : "failure" });
      return c.json(response);
    } catch (error) {
      if (isBodyLimitError(error)) return oversizeResponse(c);
      verifyDuration.record(Date.now() - start, { result: "error" });
      logger.error("Verify error", {
        requestId,
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
      return c.json({ error: "Internal error", requestId }, 500);
    } finally {
      activeRequests.add(-1, { operation: "verify" });
    }
  });

  app.post("/settle", bodyLimitMiddleware, async (c) => {
    const requestId = c.get("requestId");
    const start = Date.now();
    activeRequests.add(1, { operation: "settle" });

    let attempted = false;
    let shared: {
      network?: string;
      scheme?: string;
      asset?: string;
      amount?: string;
      payTo?: string;
    } = {};
    const complete: Partial<AuditCompleteRecord> = {};

    try {
      const { paymentPayload, paymentRequirements } = await c.req.json<{
        paymentPayload: PaymentPayload;
        paymentRequirements: PaymentRequirements;
      }>();

      if (!paymentPayload || !paymentRequirements) {
        return c.json({ error: "Missing paymentPayload or paymentRequirements", requestId }, 400);
      }

      // Idempotency: same signed tx + requirements → return prior response.
      // Protects against client retries after timeouts and prevents logging
      // the same settle twice in the audit trail.
      const idemKey = idempotencyCache ? idempotencyKey(paymentPayload, paymentRequirements) : null;
      if (idemKey && idempotencyCache) {
        const cached = idempotencyCache.get(idemKey);
        if (cached) {
          c.header("X-Idempotent-Replay", "cached");
          return c.json(cached.response as object, cached.statusCode as 200 | 400 | 500);
        }
        const inflight = idempotencyCache.inflight(idemKey);
        if (inflight) {
          c.header("X-Idempotent-Replay", "coalesced");
          const result = await inflight;
          return c.json(result.response as object, result.statusCode as 200 | 400 | 500);
        }
      }

      shared = {
        network: paymentRequirements.network,
        scheme: paymentRequirements.scheme,
        asset: paymentRequirements.asset,
        amount: paymentRequirements.amount,
        payTo: paymentRequirements.payTo,
      };

      const attempt: AuditAttemptRecord = {
        timestamp: new Date().toISOString(),
        requestId,
        operation: "settle",
        phase: "attempt",
        ...shared,
      };

      // Reserve the in-flight promise SYNCHRONOUSLY — before any await — so a
      // concurrent duplicate arriving during our audit pre-write or settle call
      // coalesces on this single upstream call instead of starting its own.
      // The inner async IIFE enforces invariant ordering: audit attempt is
      // durable before facilitator.settle is invoked.
      const settlePromise = (async () => {
        try {
          await auditSink.record(attempt);
        } catch (err) {
          logger.error("Audit attempt write failed", {
            requestId,
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
        const response = await facilitator.settle(paymentPayload, paymentRequirements);
        return { statusCode: 200, response, cachedAt: 0 };
      })();
      if (idemKey && idempotencyCache) idempotencyCache.reserve(idemKey, settlePromise);
      attempted = true;

      const { response } = await settlePromise;
      settleDuration.record(Date.now() - start, { result: response.success ? "success" : "failure" });

      complete.result = response.success ? "success" : "failure";
      complete.payer = typeof response.payer === "string" ? response.payer : undefined;
      complete.transaction = typeof response.transaction === "string" ? response.transaction : undefined;
      if (!response.success && typeof response.invalidReason === "string") {
        complete.error = response.invalidReason;
      }

      if (idemKey && idempotencyCache) {
        idempotencyCache.put(idemKey, { statusCode: 200, response });
      }
      return c.json(response);
    } catch (error) {
      if (isBodyLimitError(error)) return oversizeResponse(c);
      settleDuration.record(Date.now() - start, { result: "error" });
      logger.error("Settle error", {
        requestId,
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
      if (attempted) {
        complete.result = "error";
        complete.error = error instanceof Error ? error.message.slice(0, 500) : "Unknown error";
      }
      return c.json({ error: "Internal error", requestId }, 500);
    } finally {
      activeRequests.add(-1, { operation: "settle" });
      if (attempted) {
        const completeRecord: AuditCompleteRecord = {
          timestamp: new Date().toISOString(),
          requestId,
          operation: "settle",
          phase: "complete",
          result: complete.result ?? "error",
          durationMs: Date.now() - start,
          ...shared,
          payer: complete.payer,
          transaction: complete.transaction,
          error: complete.error,
        };
        try {
          await auditSink.record(completeRecord);
        } catch (err) {
          logger.error("Audit complete write failed", {
            requestId,
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      }
    }
  });

  app.get("/supported", (c) => {
    const requestId = c.get("requestId");
    try {
      return c.json(facilitator.getSupported());
    } catch (error) {
      logger.error("Supported error", {
        requestId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return c.json({ error: "Internal error", requestId }, 500);
    }
  });

  app.get("/livez", (c) => c.json({ status: "ok" }));

  let readyCache: { ok: boolean; blockhash?: string; checkedAt: number } | null = null;
  let readyInflight: Promise<void> | null = null;

  async function refreshReady() {
    const result = await readinessProbe();
    if (result.ok) {
      readyCache = { ok: true, blockhash: result.blockhash, checkedAt: Date.now() };
    } else {
      readyCache = { ok: false, checkedAt: Date.now() };
      logger.error("Readiness check failed", { reason: result.reason });
    }
  }

  app.get("/readyz", async (c) => {
    const requestId = c.get("requestId");
    const fresh = readyCache && Date.now() - readyCache.checkedAt < readyCacheTtlMs;

    if (!fresh) {
      readyInflight ??= refreshReady().finally(() => { readyInflight = null; });
      await readyInflight;
    }

    if (readyCache?.ok) {
      return c.json({
        status: "ok",
        network,
        rpc: "connected",
        blockhash: readyCache.blockhash,
        wallet: walletAddress,
        cachedAgeMs: Date.now() - readyCache.checkedAt,
      });
    }

    return c.json({ status: "degraded", rpc: "unreachable", requestId }, 503);
  });

  return app;
}

function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      return xff.split(",")[0].trim();
    }
    const real = c.req.header("x-real-ip");
    if (real) return real;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    // getConnInfo requires the @hono/node-server runtime; in Hono's test harness
    // (app.request()) the env is absent — treat all traffic as one bucket.
    return "unknown";
  }
}
