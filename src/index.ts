import { serve } from "@hono/node-server";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/facilitator";
import { createApp, type ReadinessProbe } from "./app.js";
import { JsonlFileSink, NullAuditSink, type AuditSink } from "./audit.js";
import { verifyCounter, settleCounter, shutdownMetrics } from "./metrics.js";
import { RateLimiter } from "./rate-limiter.js";
import { logger } from "./logger.js";
import { createFailoverRpc, parseRpcUrls } from "./rpc.js";
import { InMemoryIdempotencyCache } from "./idempotency.js";
import { startBalancePoller } from "./wallet-balance.js";
import dotenv from "dotenv";

dotenv.config();

const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const PORT = parseInt(process.env.PORT || "4022");
const SVM_PRIVATE_KEY = process.env.SVM_PRIVATE_KEY;
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH?.trim();
const BALANCE_POLL_INTERVAL_MS = parseInt(process.env.BALANCE_POLL_INTERVAL_MS || "60000");
const IDEMPOTENCY_TTL_MS = parseInt(process.env.IDEMPOTENCY_TTL_MS || "600000"); // 10 min default

const RPC_URLS = parseRpcUrls();
if (RPC_URLS.length === 0) {
  console.error("RPC_URLS (or legacy RPC_URL) is required in .env");
  process.exit(1);
}

if (!SVM_PRIVATE_KEY) {
  console.error("SVM_PRIVATE_KEY is required in .env");
  process.exit(1);
}

const privateKeyBytes = SVM_PRIVATE_KEY.startsWith("[")
  ? new Uint8Array(JSON.parse(SVM_PRIVATE_KEY))
  : base58.decode(SVM_PRIVATE_KEY);

const keypair = await createKeyPairSignerFromBytes(privateKeyBytes);
logger.info("Wallet loaded", { address: keypair.address.toString() });

// Single failover RPC shared by the signer and the readiness probe:
// if the first URL is down, both writes and the readyz check fail over.
const failoverRpc = createFailoverRpc(RPC_URLS, { rounds: 2 });
// Pass as a per-network map — toFacilitatorSvmSigner's "single RPC" detection
// relies on `"getBalance" in rpc` which fails on @solana/kit's Proxy-based RPCs.
const svmSigner = toFacilitatorSvmSigner(keypair, { [NETWORK]: failoverRpc });

const facilitator = new x402Facilitator()
  .onAfterVerify(async () => verifyCounter.add(1, { result: "success" }))
  .onVerifyFailure(async () => verifyCounter.add(1, { result: "failure" }))
  .onAfterSettle(async () => settleCounter.add(1, { result: "success" }))
  .onSettleFailure(async () => settleCounter.add(1, { result: "failure" }));

facilitator.register(NETWORK, new ExactSvmScheme(svmSigner));

const rateLimiter = new RateLimiter(100, 60_000);

const auditSink: AuditSink = AUDIT_LOG_PATH
  ? new JsonlFileSink(AUDIT_LOG_PATH)
  : new NullAuditSink();
if (AUDIT_LOG_PATH) {
  logger.info("Audit log enabled", { path: AUDIT_LOG_PATH });
} else {
  logger.warn("Audit log disabled — set AUDIT_LOG_PATH to enable durable settle records");
}

const readinessProbe: ReadinessProbe = async () => {
  try {
    const { value } = await failoverRpc.getLatestBlockhash().send();
    return { ok: true, blockhash: value.blockhash };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Unknown error" };
  }
};

const balancePoller = startBalancePoller({
  rpc: failoverRpc,
  address: keypair.address,
  intervalMs: BALANCE_POLL_INTERVAL_MS,
});

const idempotencyCache = new InMemoryIdempotencyCache(IDEMPOTENCY_TTL_MS);

const app = createApp({
  facilitator,
  rateLimiter,
  readinessProbe,
  walletAddress: keypair.address.toString(),
  trustProxy: TRUST_PROXY,
  network: NETWORK,
  allowedOrigins: ALLOWED_ORIGINS,
  auditSink,
  idempotencyCache,
});

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  logger.info("Facilitator started", {
    port: info.port,
    network: NETWORK,
    rpcEndpoints: RPC_URLS.length,
    wallet: keypair.address.toString(),
  });
});

// Graceful shutdown: stop accepting connections, drain in-flight, flush metrics, exit.
const SHUTDOWN_TIMEOUT_MS = 10_000;
let shuttingDown = false;

const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Shutdown initiated", { signal });

  const forceExit = setTimeout(() => {
    logger.warn("Forcing shutdown after timeout", { timeoutMs: SHUTDOWN_TIMEOUT_MS });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    logger.info("HTTP server closed");

    balancePoller.stop();

    await shutdownMetrics();
    logger.info("Metrics exporter closed");

    await auditSink.close();
    logger.info("Audit sink closed");

    rateLimiter.dispose();
    idempotencyCache.dispose();

    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    logger.error("Shutdown error", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    process.exit(1);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
