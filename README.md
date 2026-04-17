# Chainflow Facilitator

An [x402](https://x402.org) facilitator for Solana payments, submitted through
Chainflow's own staked validator for stake-weighted QoS.

## What it does

Resource servers return HTTP `402 Payment Required` with a challenge. The
client signs a Solana transaction. This facilitator simulates it (`/verify`),
signs as fee payer, submits on-chain (`/settle`), and returns the signature.

## Why Chainflow

- **SWQoS advantage.** Settlements are broadcast through Chainflow's own
  staked Solana validator. Stake-weighted Quality of Service gives those
  transactions priority access to the leader during congestion — a
  protocol-level advantage that RPC-only facilitators cannot replicate.
- **Built for production, not a demo.**
  - Idempotent `/settle` keyed on `sha256(signed_tx + requirements)` with
    inflight coalescing for concurrent duplicates.
  - Two-phase durable audit log (attempt + complete) for crash reconciliation.
  - Multi-RPC failover transport.
  - Per-IP rate limiting, body-size caps, CORS, request-id propagation.
  - Prometheus metrics + Alertmanager rules + OpenTelemetry.
  - Liveness / readiness probes with a cached blockhash check.
  - Graceful shutdown draining in-flight settles.

## Multi-chain roadmap

Solana is live today. Sui and additional networks are planned. The facilitator
architecture supports multiple chains concurrently — each chain is registered
independently and all endpoints serve every registered network automatically.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/supported` | Advertised scheme/network pairs + fee-payer address |
| `POST` | `/verify` | Simulate a signed transaction without broadcasting |
| `POST` | `/settle` | Sign as fee payer, submit, wait for confirmation |
| `GET` | `/livez` | Liveness probe |
| `GET` | `/readyz` | Readiness probe (RPC connectivity, cached 30 s) |

Full request/response shapes, headers, and a runnable end-to-end example are
in [`docs/api.md`](docs/api.md).

## Using Chainflow

Most users don't need to run this service themselves. Point your resource
server or client at the hosted endpoint:

```
https://facilitator.chainflow.io
```

No API key, no deployment, no Solana wallet on your side. The hosted instance
owns the fee-payer wallet and routes every settlement through Chainflow's
staked validator — this is where the SWQoS advantage comes from.

**30-second check that it's alive:**

```bash
curl https://facilitator.chainflow.io/supported
```

**Integrating into your app** — the client flow is: call `/supported` to learn
the fee-payer address, have the buyer partially sign a transaction with that
fee-payer, then `POST /verify` followed by `POST /settle`. A complete runnable
TypeScript example lives in [`docs/api.md`](docs/api.md#end-to-end-code-example).

If you're building an x402 resource server (the thing returning `402 Payment
Required`), any x402-compatible client library will work — just configure it
to use `https://facilitator.chainflow.io` as the facilitator URL.

## Self-hosting

You only need to self-host if you want a private deployment, a custom scheme,
or the ability to audit and run only code you've read. Otherwise use the
hosted endpoint above.

> **Note on SWQoS when self-hosting.** The stake-weighted QoS advantage comes
> from broadcasting through Chainflow's staked validator, not from this code.
> A default self-hosted instance pointing at `api.mainnet-beta.solana.com`
> gets no SWQoS uplift. Contact us if you want to configure `RPC_URLS`
> against the Chainflow validator endpoint.

### 1. Clone + install

```bash
git clone https://github.com/Kym0211/chainflow-facilitator.git
cd chainflow-facilitator
npm install
```

### 2. Configure

```bash
cp .env.example .env
# edit .env — at minimum set SVM_PRIVATE_KEY and RPC_URLS
```

The `SVM_PRIVATE_KEY` keypair pays Solana fees for every settlement. Keep it
funded with SOL; the balance is published as a Prometheus gauge
(`facilitator_wallet_balance_lamports`) and monitored by the included
`LowWalletBalance` / `CriticalWalletBalance` alerts.

### 3. Run

```bash
npm run dev          # tsx, hot reload
# or
npm run build && npm start
```

Facilitator listens on `:4022` by default. Prometheus metrics are exposed on
`:9464`.

### 4. Try it

```bash
curl http://localhost:4022/supported
curl http://localhost:4022/readyz
```

### Docker

```bash
docker compose up -d
```

Brings up the facilitator alongside Prometheus (`:9090`), Grafana (`:3001`),
and Alertmanager (`:9093`). See `docker-compose.yml` for volume mounts and
the `.secrets/` directory for SMTP credentials.

### Configuration

All settings come from environment variables. See [`.env.example`](.env.example)
for the full list — the most important are:

| Variable | Required | Purpose |
|---|---|---|
| `SVM_PRIVATE_KEY` | yes | Fee-payer keypair (base58 or JSON byte array) |
| `RPC_URLS` | yes | Comma-separated Solana RPCs, tried in order with failover |
| `PORT` | no | HTTP port (default 4022) |
| `AUDIT_LOG_PATH` | no | Enables durable JSONL audit log; disabled if unset |
| `CORS_ALLOWED_ORIGINS` | no | Comma-separated origins; empty = same-origin only |
| `TRUST_PROXY` | no | Set `true` behind a trusted ALB/Nginx/Cloudflare |
| `IDEMPOTENCY_TTL_MS` | no | Settle dedup window (default 600000) |
| `BALANCE_POLL_INTERVAL_MS` | no | Wallet-balance poll cadence (default 60000) |

## Development

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest
npm run test:watch   # vitest in watch mode
```

Tests cover the HTTP surface, idempotency semantics, rate limiter, audit
sink, RPC failover, and wallet-balance poller. The end-to-end payment flow
lives in `tests/e2e/test-payment.ts`.

## Observability

- Prometheus scrape endpoint on `:9464/metrics` (separate port from the API).
- Key metrics: `facilitator_verify_total`, `facilitator_settle_total`,
  `facilitator_settle_duration_ms`, `facilitator_wallet_balance_lamports`,
  `facilitator_active_requests`.
- Alert rules in [`prometheus-alerts.yml`](prometheus-alerts.yml) cover
  elevated error rates, latency regressions, and low wallet balance.
- Structured JSON logs carry a `requestId` matching the `X-Request-Id`
  response header — grep by it when a user reports an issue.

## Project layout

```
src/
  index.ts           entry point, wiring, graceful shutdown
  app.ts             Hono routes, middleware, idempotency + audit ordering
  rpc.ts             multi-RPC failover transport
  idempotency.ts     settle dedup cache (with inflight coalescing)
  audit.ts           JSONL append-only audit sink
  rate-limiter.ts    sliding-window per IP
  wallet-balance.ts  periodic balance poll → Prometheus gauge
  metrics.ts         OTEL metrics setup
  logger.ts          structured logger
tests/               vitest unit + e2e
docs/api.md          developer-facing API reference
```

## Contributing

Issues and PRs welcome. Please run `npm run typecheck && npm test` before
opening a PR.
