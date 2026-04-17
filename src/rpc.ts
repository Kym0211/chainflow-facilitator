import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  mainnet,
  type RpcMainnet,
  type RpcTransport,
  type RpcTransportFromClusterUrl,
  type SolanaRpcApiMainnet,
} from "@solana/kit";
import { logger } from "./logger.js";

type MainnetTransport = RpcTransportFromClusterUrl<ReturnType<typeof mainnet>>;

/**
 * Parse RPC endpoints from env. `RPC_URLS` (comma-separated) takes precedence;
 * `RPC_URL` is kept for back-compat. Trailing/leading whitespace is trimmed.
 */
export function parseRpcUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  const multi = env.RPC_URLS?.split(",").map((u) => u.trim()).filter(Boolean);
  if (multi && multi.length > 0) return multi;
  const single = env.RPC_URL?.trim();
  return single ? [single] : [];
}

export interface FailoverOptions {
  /** How many times to cycle through the full list before giving up. Default 1. */
  rounds?: number;
  /** Ms between rounds after every endpoint has failed. Default 100. */
  backoffMs?: number;
  /** Per-call timeout. Default 4000. */
  timeoutMs?: number;
}

/**
 * Build a RpcTransport that tries each URL in order and fails over on error.
 * Every rejection is logged with the endpoint host so failures are traceable.
 */
export function createFailoverTransport(
  urls: string[],
  opts: FailoverOptions = {},
): RpcTransport {
  if (urls.length === 0) {
    throw new Error("createFailoverTransport requires at least one URL");
  }
  const { rounds = 1, backoffMs = 100, timeoutMs = 4_000 } = opts;

  const transports = urls.map((u) => ({
    url: u,
    transport: createDefaultRpcTransport({ url: mainnet(u) }),
  }));

  const call = async <TResponse>(
    t: { url: string; transport: RpcTransport },
    config: Parameters<RpcTransport>[0],
  ) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Merge the caller's signal with the timeout signal.
    config.signal?.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      return await t.transport<TResponse>({ ...config, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  return async <TResponse>(config: Parameters<RpcTransport>[0]) => {
    let lastError: unknown;
    for (let round = 0; round < rounds; round++) {
      for (const t of transports) {
        try {
          return await call<TResponse>(t, config);
        } catch (err) {
          lastError = err;
          logger.warn("RPC endpoint failed", {
            url: redact(t.url),
            error: err instanceof Error ? err.message : "Unknown error",
            round,
          });
        }
      }
      if (round < rounds - 1) {
        await new Promise((r) => setTimeout(r, backoffMs * 2 ** round));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("All RPC endpoints failed");
  };
}

/** Convenience: build a ready-to-use mainnet Solana RPC with failover. */
export function createFailoverRpc(urls: string[], opts?: FailoverOptions): RpcMainnet<SolanaRpcApiMainnet> {
  // All URLs are tagged mainnet() inside createFailoverTransport, but the
  // composite transport erases the brand. Re-apply it here so downstream
  // consumers (e.g. toFacilitatorSvmSigner) accept it.
  const transport = createFailoverTransport(urls, opts) as MainnetTransport;
  return createSolanaRpcFromTransport(transport);
}

/** Strip query/auth from a URL for logging. Best effort; keep host+path only. */
function redact(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return raw;
  }
}
