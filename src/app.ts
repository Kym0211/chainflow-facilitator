import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { activeRequests, verifyDuration, settleDuration } from "./metrics.js";
import type { RateLimiter } from "./rate-limiter.js";
import { logger } from "./logger.js";
import { randomUUID } from "node:crypto";
import type { AuditRecord, AuditSink } from "./audit.js";
import { NullAuditSink } from "./audit.js";

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
    // Builds up as we learn details; committed in finally only if a settle was actually attempted.
    const audit: Partial<AuditRecord> & { attempted: boolean } = {
      timestamp: new Date().toISOString(),
      requestId,
      operation: "settle",
      attempted: false,
    };
    try {
      const { paymentPayload, paymentRequirements } = await c.req.json<{
        paymentPayload: PaymentPayload;
        paymentRequirements: PaymentRequirements;
      }>();

      if (!paymentPayload || !paymentRequirements) {
        return c.json({ error: "Missing paymentPayload or paymentRequirements", requestId }, 400);
      }

      Object.assign(audit, {
        attempted: true,
        network: paymentRequirements.network,
        scheme: paymentRequirements.scheme,
        asset: paymentRequirements.asset,
        amount: paymentRequirements.amount,
        payTo: paymentRequirements.payTo,
      });

      const response = await facilitator.settle(paymentPayload, paymentRequirements);
      settleDuration.record(Date.now() - start, { result: response.success ? "success" : "failure" });

      audit.result = response.success ? "success" : "failure";
      audit.payer = typeof response.payer === "string" ? response.payer : undefined;
      audit.transaction = typeof response.transaction === "string" ? response.transaction : undefined;
      if (!response.success && typeof response.invalidReason === "string") {
        audit.error = response.invalidReason;
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
      if (audit.attempted) {
        audit.result = "error";
        audit.error = error instanceof Error ? error.message.slice(0, 500) : "Unknown error";
      }
      return c.json({ error: "Internal error", requestId }, 500);
    } finally {
      activeRequests.add(-1, { operation: "settle" });
      if (audit.attempted) {
        audit.durationMs = Date.now() - start;
        const { attempted: _attempted, ...finalRecord } = audit;
        try {
          await auditSink.record(finalRecord as AuditRecord);
        } catch (err) {
          logger.error("Audit sink write failed", {
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
