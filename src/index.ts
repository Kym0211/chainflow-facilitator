import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import dotenv from "dotenv";

dotenv.config();

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

const facilitator = new x402Facilitator();

// facilitator.register(
//   "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
//   new ExactSvmScheme(svmSigner)
// );   // for mainnet 

facilitator.register(
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  new ExactSvmScheme(svmSigner)
);   // for devnet

const app = new Hono();

app.post("/verify", async (c) => {
  try {
    const { paymentPayload, paymentRequirements } = await c.req.json<{
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    }>();

    if (!paymentPayload || !paymentRequirements) {
      return c.json({ error: "Missing paymentPayload or paymentRequirements" }, 400);
    }

    const response = await facilitator.verify(paymentPayload, paymentRequirements);
    return c.json(response);
  } catch (error) {
    console.error("Verify error:", error);
    return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

app.post("/settle", async (c) => {
  try {
    const { paymentPayload, paymentRequirements } = await c.req.json<{
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    }>();

    if (!paymentPayload || !paymentRequirements) {
      return c.json({ error: "Missing paymentPayload or paymentRequirements" }, 400);
    }

    const response = await facilitator.settle(paymentPayload, paymentRequirements);
    return c.json(response);
  } catch (error) {
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

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Chainflow facilitator running on http://localhost:${info.port}`);
  console.log(`Network: Solana devnet (EtWTRABZaYq6iMfeYKouRu166VU2xqa1)`);
  console.log(`RPC: ${RPC_URL || "default (public)"}`);
});