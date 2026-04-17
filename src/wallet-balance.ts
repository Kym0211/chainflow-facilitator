import type { Address } from "@solana/kit";
import { logger } from "./logger.js";
import { setWalletBalanceLamports } from "./metrics.js";

/**
 * Minimal shape we need from the RPC — keeps the poller testable without
 * depending on the concrete @solana/kit RPC type.
 */
export interface BalanceRpc {
  getBalance(address: Address): { send(): Promise<{ value: bigint }> };
}

export interface BalancePollerOptions {
  rpc: BalanceRpc;
  address: Address;
  intervalMs?: number;
}

export interface BalancePoller {
  /** Run one poll immediately; used at startup so the gauge has a value fast. */
  pollOnce(): Promise<void>;
  stop(): void;
}

/**
 * Periodically read the facilitator wallet balance and publish to the
 * OTEL gauge. Errors are logged but never throw — a transient RPC blip
 * must not crash the service.
 */
export function startBalancePoller(opts: BalancePollerOptions): BalancePoller {
  const { rpc, address, intervalMs = 60_000 } = opts;

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  async function pollOnce() {
    try {
      const { value } = await rpc.getBalance(address).send();
      // Gauge values are JS numbers; bigint → Number is safe for lamport counts.
      setWalletBalanceLamports(Number(value));
    } catch (error) {
      logger.warn("Wallet balance poll failed", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  async function loop() {
    if (stopped) return;
    await pollOnce();
    if (stopped) return;
    timer = setTimeout(loop, intervalMs);
    timer.unref();
  }

  // Kick off the first poll asynchronously so the caller isn't blocked.
  void loop();

  return {
    pollOnce,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
