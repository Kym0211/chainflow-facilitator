import { serve } from "@hono/node-server";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes, createSolanaRpc, mainnet } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/facilitator";
import { createApp, type ReadinessProbe } from "./app.js";
import { verifyCounter, settleCounter, shutdownMetrics } from "./metrics.js";
import { RateLimiter } from "./rate-limiter.js";
import { logger } from "./logger.js";
import dotenv from "dotenv";

dotenv.config();

const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const PORT = parseInt(process.env.PORT || "4022");
const RPC_URL = process.env.RPC_URL;
const SVM_PRIVATE_KEY = process.env.SVM_PRIVATE_KEY;
const TRUST_PROXY = process.env.TRUST_PROXY === "true";

if (!SVM_PRIVATE_KEY) {
  console.error("SVM_PRIVATE_KEY is required in .env");
  process.exit(1);
}

const privateKeyBytes = SVM_PRIVATE_KEY.startsWith("[")
  ? new Uint8Array(JSON.parse(SVM_PRIVATE_KEY))
  : base58.decode(SVM_PRIVATE_KEY);

const keypair = await createKeyPairSignerFromBytes(privateKeyBytes);
logger.info("Wallet loaded", { address: keypair.address.toString() });

const svmSigner = toFacilitatorSvmSigner(keypair, {
  defaultRpcUrl: RPC_URL,
});

const facilitator = new x402Facilitator()
  .onAfterVerify(async () => verifyCounter.add(1, { result: "success" }))
  .onVerifyFailure(async () => verifyCounter.add(1, { result: "failure" }))
  .onAfterSettle(async () => settleCounter.add(1, { result: "success" }))
  .onSettleFailure(async () => settleCounter.add(1, { result: "failure" }));

facilitator.register(NETWORK, new ExactSvmScheme(svmSigner));

const rateLimiter = new RateLimiter(100, 60_000);

const readinessProbe: ReadinessProbe = async () => {
  try {
    const rpc = createSolanaRpc(mainnet(RPC_URL!));
    const { value } = await rpc.getLatestBlockhash().send();
    return { ok: true, blockhash: value.blockhash };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Unknown error" };
  }
};

const app = createApp({
  facilitator,
  rateLimiter,
  readinessProbe,
  walletAddress: keypair.address.toString(),
  trustProxy: TRUST_PROXY,
  network: NETWORK,
});

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  logger.info("Facilitator started", {
    port: info.port,
    network: NETWORK,
    rpc: RPC_URL || "default",
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

    await shutdownMetrics();
    logger.info("Metrics exporter closed");

    rateLimiter.dispose();

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
