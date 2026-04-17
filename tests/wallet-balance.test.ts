import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "@solana/kit";
import { startBalancePoller, type BalanceRpc } from "../src/wallet-balance.js";

const ADDR = "DfStJHxreUdAB2zVZEzCDyYmFoj7YuT4bsqyfg55JJXd" as Address;

function makeRpc(balances: (bigint | Error)[]): BalanceRpc {
  const queue = [...balances];
  return {
    getBalance: () => ({
      async send() {
        const next = queue.shift();
        if (next === undefined) return { value: 0n };
        if (next instanceof Error) throw next;
        return { value: next };
      },
    }),
  };
}

describe("startBalancePoller", () => {
  let poller: ReturnType<typeof startBalancePoller> | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    poller?.stop();
    poller = null;
    vi.useRealTimers();
  });

  it("reads the balance once on start", async () => {
    const rpc = makeRpc([1_234_567n]);
    const spy = vi.spyOn(rpc, "getBalance");
    poller = startBalancePoller({ rpc, address: ADDR, intervalMs: 10_000 });
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });

  it("polls again after intervalMs elapses", async () => {
    const rpc = makeRpc([1n, 2n, 3n]);
    const spy = vi.spyOn(rpc, "getBalance");
    poller = startBalancePoller({ rpc, address: ADDR, intervalMs: 5_000 });

    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(5_001);
    expect(spy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("does not crash when the RPC call throws", async () => {
    const rpc = makeRpc([new Error("rpc down"), 42n]);
    const spy = vi.spyOn(rpc, "getBalance");
    poller = startBalancePoller({ rpc, address: ADDR, intervalMs: 1_000 });

    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    // Second tick should still happen despite the first throwing.
    await vi.advanceTimersByTimeAsync(1_001);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("stop() prevents further polls", async () => {
    const rpc = makeRpc([1n, 2n, 3n]);
    const spy = vi.spyOn(rpc, "getBalance");
    poller = startBalancePoller({ rpc, address: ADDR, intervalMs: 1_000 });

    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    poller.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
