# Chainflow Facilitator — Developer Docs

An x402 facilitator for Solana payments, powered by Chainflow's own staked
validator infrastructure.

Resource servers send a 402 challenge to the client; the client signs a
transaction; the facilitator simulates it (`/verify`) and submits it
(`/settle`).

> **SWQoS advantage** — Transactions are submitted through Chainflow's own
> staked Solana validator, providing stake-weighted QoS priority for faster
> landing during network congestion. This is a protocol-level advantage that
> third-party RPC providers cannot replicate.

## Base URL

```
https://facilitator.chainflow.io
```

> Replace with your deployment's URL. For local development run
> `npm run dev` and use `http://localhost:4022`.

No authentication is required. Rate-limited to **100 requests / minute / IP**
by default.

---

## Endpoints

### `GET /supported`

List the scheme + network pairs this facilitator accepts.

```bash
curl https://facilitator.chainflow.io/supported
```

**Response `200`**

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "extra": { "feePayer": "G1pPBq…Z5CMng" }
    }
  ],
  "extensions": [],
  "signers": { "solana:*": ["G1pPBq…Z5CMng"] }
}
```

Use `extra.feePayer` when building the transaction — it must be the
transaction's fee payer.

---

### `POST /verify`

Simulate the payment without broadcasting. Returns `isValid: true` if the
transaction would succeed on-chain.

**Request**

```http
POST /verify
Content-Type: application/json

{
  "paymentPayload":      { ...x402 PaymentPayload... },
  "paymentRequirements": { ...x402 PaymentRequirements... }
}
```

**Response `200` (valid)**

```json
{ "isValid": true, "payer": "DfStJH…55JJXd" }
```

**Response `200` (invalid)**

```json
{
  "isValid": false,
  "invalidReason": "transaction_simulation_failed",
  "invalidMessage": "Simulation failed: ...",
  "payer": "DfStJH…55JJXd"
}
```

---

### `POST /settle`

Sign with the facilitator's fee-payer key, submit to Solana, wait for
confirmation. Response echoes the transaction signature.

**Request** — same body shape as `/verify`.

**Response `200` (success)**

```json
{
  "success": true,
  "transaction": "5USy6Q…Pkc1j",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "payer": "DfStJH…55JJXd"
}
```

**Response `200` (facilitator returns failure)**

```json
{
  "success": false,
  "errorReason": "transaction_failed",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "payer": "DfStJH…55JJXd"
}
```

> **Note:** When the facilitator itself throws an unhandled exception, the
> response is a generic 500 error (see Error Responses below). The response
> above is returned when settlement was attempted but failed (e.g. transaction
> rejected on-chain).

---

### `GET /livez`

Liveness probe. Returns `200` immediately with no dependency checks. Used by
Docker `HEALTHCHECK` and orchestrators.

```json
{ "status": "ok" }
```

---

### `GET /readyz`

Readiness probe. Verifies the Solana RPC is reachable by fetching a recent
blockhash. Result is cached for 30 seconds to avoid hammering the RPC on every
scrape.

**Response `200`**

```json
{
  "status": "ok",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "rpc": "connected",
  "blockhash": "DA4dma…WW5F",
  "wallet": "G1pPBq…Z5CMng",
  "cachedAgeMs": 1234
}
```

**Response `503`**

```json
{ "status": "degraded", "rpc": "unreachable", "requestId": "..." }
```

---

## Response Headers

| Header | Meaning |
|---|---|
| `X-Request-Id` | Returned on every response. Include the same ID in the request to correlate with server logs. |
| `X-RateLimit-Remaining` | Remaining requests in the current window for your IP. Present on `/verify` and `/settle` only. |
| `X-Idempotent-Replay: cached` | Set on `/settle` when the response came from the 10-minute idempotency cache instead of a fresh call. |
| `X-Idempotent-Replay: coalesced` | Set on `/settle` when the response was coalesced with an in-flight call for the same signed transaction. |

## Error Responses

All 4xx and 5xx responses share this shape:

```json
{ "error": "Internal error", "requestId": "8b2654c5-..." }
```

| Status | Reason |
|---|---|
| `400` | Missing `paymentPayload` or `paymentRequirements` in the body. |
| `413` | Request body exceeds 64 KB. |
| `429` | Rate limit hit. Retry after the window resets. |
| `500` | Internal error. Share the `requestId` when reporting. |
| `503` | `/readyz` only — upstream Solana RPC unreachable. |

---

## Idempotency

Settling is idempotent on `sha256(signed_transaction + requirements)`:
retrying the same settle within 10 minutes returns the cached response
(see `X-Idempotent-Replay`) without re-submitting to Solana. Concurrent
duplicates are coalesced into a single upstream call.

---

## Audit Trail

Every settlement attempt is durably logged with its `requestId`, payer
address, transaction signature, and timestamp. Two records are written per
settle: an "attempt" record before calling Solana, and a "complete" record
after. If the process crashes mid-settle, the orphan attempt record lets
operators reconcile against on-chain state.

---

## End-to-End Code Example

Installs:

```bash
npm i @solana/kit @solana-program/compute-budget @solana-program/token
```

Full, runnable TypeScript — builds a 0.001 USDC transfer, signs it as the
buyer, and routes it through the facilitator. Save as `pay.ts` and run with
`npx tsx pay.ts`.

```ts
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  mainnet,
  partiallySignTransactionMessageWithSigners,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import {
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { readFileSync } from "node:fs";

const FACILITATOR_URL = "https://facilitator.chainflow.io";
const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC_MINT = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const RPC_URL = "https://api.mainnet-beta.solana.com"; // or your own

// 1. Ask the facilitator which fee-payer to use.
const supported = await (await fetch(`${FACILITATOR_URL}/supported`)).json();
const kind = supported.kinds.find(
  (k: { network: string; scheme: string }) =>
    k.network === NETWORK && k.scheme === "exact",
);
const FEE_PAYER = address(kind.extra.feePayer);

// 2. Load the buyer keypair (64-byte JSON array from solana-keygen).
const buyerBytes = new Uint8Array(
  JSON.parse(readFileSync("buyer.json", "utf-8")),
);
const buyer = await createKeyPairSignerFromBytes(buyerBytes);

// 3. Merchant address + amount (0.001 USDC = 1000 at 6 decimals).
const MERCHANT = address("GTS6smH1adsF4egSpfEDbBKWZkGyxEe9e8abfA29LWfz");
const AMOUNT = 1000n;

// 4. Build the transaction: compute budget + USDC transfer,
//    fee payer = facilitator.
const rpc = createSolanaRpc(mainnet(RPC_URL));
const { value: blockhash } = await rpc.getLatestBlockhash().send();

const [buyerAta] = await findAssociatedTokenPda({
  mint: USDC_MINT,
  owner: buyer.address,
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
});
const [merchantAta] = await findAssociatedTokenPda({
  mint: USDC_MINT,
  owner: MERCHANT,
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
});

const message = appendTransactionMessageInstructions(
  [
    getSetComputeUnitLimitInstruction({ units: 20_000 }),
    getSetComputeUnitPriceInstruction({ microLamports: 100_000n }),
    getTransferCheckedInstruction({
      source: buyerAta,
      mint: USDC_MINT,
      destination: merchantAta,
      authority: buyer,
      amount: AMOUNT,
      decimals: 6,
    }),
  ],
  setTransactionMessageLifetimeUsingBlockhash(
    blockhash,
    setTransactionMessageFeePayer(
      FEE_PAYER,
      createTransactionMessage({ version: 0 }),
    ),
  ),
);

// 5. Buyer partially signs (fee-payer signature comes from facilitator).
const signed = await partiallySignTransactionMessageWithSigners(message);
const transaction = getBase64EncodedWireTransaction(signed);

// 6. Assemble the x402 payload.
const paymentRequirements = {
  scheme: "exact",
  network: NETWORK,
  asset: USDC_MINT.toString(),
  amount: AMOUNT.toString(),
  payTo: MERCHANT.toString(),
  maxTimeoutSeconds: 300,
  extra: { feePayer: FEE_PAYER.toString() },
};
const paymentPayload = {
  x402Version: 2,
  resource: {
    url: "https://example.com/widget",
    mimeType: "application/json",
  },
  accepted: paymentRequirements,
  payload: { transaction },
};

// 7. /verify — simulate before submitting.
const verifyRes = await fetch(`${FACILITATOR_URL}/verify`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ paymentPayload, paymentRequirements }),
});
const verify = await verifyRes.json();
if (!verify.isValid)
  throw new Error(`verify failed: ${verify.invalidMessage}`);

// 8. /settle — facilitator signs as fee payer, submits on-chain.
const settleRes = await fetch(`${FACILITATOR_URL}/settle`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ paymentPayload, paymentRequirements }),
});
const settle = await settleRes.json();
if (!settle.success)
  throw new Error(`settle failed: ${settle.errorReason}`);

console.log(
  `Paid. Tx: https://explorer.solana.com/tx/${settle.transaction}`,
);
```

---

## What the Facilitator Does Behind the Scenes

1. Decodes and simulates the partially-signed transaction on-chain (catches
   bad ATAs, insufficient balance, expired blockhash).
2. If valid, adds its fee-payer signature and submits via `sendTransaction`
   through Chainflow's staked validator node.
3. Polls for on-chain confirmation.
4. Writes a durable audit record with `requestId`, payer, transaction
   signature, and timestamp.
5. Emits Prometheus metrics (`facilitator_settle_total`,
   `facilitator_settle_duration_ms`, `facilitator_wallet_balance_lamports`).

> Settlement typically takes 2–5 seconds on mainnet depending on network
> conditions.
> **Multi-chain roadmap** — Solana is live today. Sui and additional networks
> are planned. The facilitator architecture supports multiple chains
> concurrently — each chain is registered independently and all endpoints
> serve every registered network automatically.