import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes, createSolanaRpc, mainnet } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { verifyCounter, settleCounter, verifyDuration, settleDuration, activeRequests } from "./metrics.js";
import { RateLimiter } from "./rate-limiter.js";
import dotenv from "dotenv";

dotenv.config();

// 100 requests per minute per IP — generous for early stage
const rateLimiter = new RateLimiter(100, 60_000);

const PORT = parseInt(process.env.PORT || "4022");
const RPC_URL = process.env.RPC_URL;
const SVM_PRIVATE_KEY = process.env.SVM_PRIVATE_KEY;

if (!SVM_PRIVATE_KEY) {
  console.error("SVM_PRIVATE_KEY is required in .env");
  process.exit(1);
}

const privateKeyBytes = SVM_PRIVATE_KEY.startsWith("[")
  ? new Uint8Array(JSON.parse(SVM_PRIVATE_KEY))
  : base58.decode(SVM_PRIVATE_KEY);

const keypair = await createKeyPairSignerFromBytes(privateKeyBytes);
console.log(`Facilitator wallet: ${keypair.address}`);

const svmSigner = toFacilitatorSvmSigner(keypair, {
  defaultRpcUrl: RPC_URL,
});

const facilitator = new x402Facilitator()
  .onBeforeVerify(async () => {
    activeRequests.add(1, { operation: "verify" });
  })
  .onAfterVerify(async () => {
    activeRequests.add(-1, { operation: "verify" });
    verifyCounter.add(1, { result: "success" });
  })
  .onVerifyFailure(async () => {
    activeRequests.add(-1, { operation: "verify" });
    verifyCounter.add(1, { result: "failure" });
  })
  .onBeforeSettle(async () => {
    activeRequests.add(1, { operation: "settle" });
  })
  .onAfterSettle(async () => {
    activeRequests.add(-1, { operation: "settle" });
    settleCounter.add(1, { result: "success" });
  })
  .onSettleFailure(async () => {
    activeRequests.add(-1, { operation: "settle" });
    settleCounter.add(1, { result: "failure" });
  });

facilitator.register(
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  new ExactSvmScheme(svmSigner)
);   // for mainnet 

// facilitator.register(
//   "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
//   new ExactSvmScheme(svmSigner)
// );   // for devnet

const app = new Hono();

// Rate limiting middleware
app.use("*", async (c, next) => {
  const path = c.req.path;
  if (path === "/health" || path === "/supported") {
    return next();
  }

  const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";

  if (!rateLimiter.isAllowed(ip)) {
    return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
  }

  c.header("X-RateLimit-Remaining", rateLimiter.remaining(ip).toString());
  return next();
});

app.post("/verify", async (c) => {
  const start = Date.now();
  try {
    const { paymentPayload, paymentRequirements } = await c.req.json<{
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    }>();

    if (!paymentPayload || !paymentRequirements) {
      return c.json({ error: "Missing paymentPayload or paymentRequirements" }, 400);
    }

    const response = await facilitator.verify(paymentPayload, paymentRequirements);
    verifyDuration.record(Date.now() - start, { result: response.isValid ? "success" : "failure" });
    return c.json(response);
  } catch (error) {
    verifyDuration.record(Date.now() - start, { result: "error" });
    console.error("Verify error:", error);
    return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

app.post("/settle", async (c) => {
  const start = Date.now();
  try {
    const { paymentPayload, paymentRequirements } = await c.req.json<{
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    }>();

    if (!paymentPayload || !paymentRequirements) {
      return c.json({ error: "Missing paymentPayload or paymentRequirements" }, 400);
    }

    const response = await facilitator.settle(paymentPayload, paymentRequirements);
    settleDuration.record(Date.now() - start, { result: response.success ? "success" : "failure" });
    return c.json(response);
  } catch (error) {
    settleDuration.record(Date.now() - start, { result: "error" });
    console.error("Settle error:", error);
    return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

app.get("/supported", (c) => {
  try {
    const response = facilitator.getSupported();
    return c.json(response);
  } catch (error) {
    console.error("Supported error:", error);
    return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  } 
});

app.get("/health", async (c) => {
  try {
    // Check if we can reach the Solana RPC
    const rpc = createSolanaRpc(mainnet(RPC_URL!));
    const { value } = await rpc.getLatestBlockhash().send();

    return c.json({
      status: "ok",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      rpc: "connected",
      blockhash: value.blockhash,
      wallet: keypair.address.toString(),
    });
  } catch (error) {
    return c.json({
      status: "degraded",
      rpc: "unreachable",
      error: error instanceof Error ? error.message : "Unknown error",
    }, 503);
  }
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Chainflow facilitator running on http://localhost:${info.port}`);
  console.log(`Network: Solana mainnet (5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp)`);
  console.log(`RPC: ${RPC_URL || "default (public)"}`);
});