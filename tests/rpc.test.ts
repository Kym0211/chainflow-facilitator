import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseRpcUrls } from "../src/rpc.js";

describe("parseRpcUrls", () => {
  it("returns RPC_URLS split by comma", () => {
    expect(parseRpcUrls({ RPC_URLS: "https://a.example,https://b.example" } as NodeJS.ProcessEnv))
      .toEqual(["https://a.example", "https://b.example"]);
  });

  it("trims whitespace and drops empties", () => {
    expect(parseRpcUrls({ RPC_URLS: " https://a.example , , https://b.example " } as NodeJS.ProcessEnv))
      .toEqual(["https://a.example", "https://b.example"]);
  });

  it("falls back to RPC_URL when RPC_URLS is missing", () => {
    expect(parseRpcUrls({ RPC_URL: "https://legacy.example" } as NodeJS.ProcessEnv))
      .toEqual(["https://legacy.example"]);
  });

  it("prefers RPC_URLS over RPC_URL when both are set", () => {
    expect(parseRpcUrls({
      RPC_URLS: "https://new.example",
      RPC_URL: "https://legacy.example",
    } as NodeJS.ProcessEnv)).toEqual(["https://new.example"]);
  });

  it("returns empty array when neither is set", () => {
    expect(parseRpcUrls({} as NodeJS.ProcessEnv)).toEqual([]);
  });
});

// Failover transport tests: we can't easily stub @solana/kit's default
// transport since it's constructed internally. Instead we test the
// failover logic by mocking global fetch — each URL has its own fetch
// behaviour, and the transport calls fetch under the hood.
describe("createFailoverTransport", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  it("uses the first URL when it succeeds", async () => {
    const { createFailoverTransport } = await import("../src/rpc.js");
    fetchSpy.mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1, result: "ok" }));

    const transport = createFailoverTransport(["https://primary.example", "https://secondary.example"]);
    const out = await transport({ payload: { jsonrpc: "2.0", id: 1, method: "getHealth" } });

    expect(out).toMatchObject({ result: "ok" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("https://primary.example");
  });

  it("falls over to the second URL when the first throws", async () => {
    const { createFailoverTransport } = await import("../src/rpc.js");
    fetchSpy
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1, result: "from-secondary" }));

    const transport = createFailoverTransport(["https://primary.example", "https://secondary.example"]);
    const out = await transport({ payload: { jsonrpc: "2.0", id: 1, method: "getHealth" } });

    expect(out).toMatchObject({ result: "from-secondary" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1][0]).toBe("https://secondary.example");
  });

  it("throws the last error when every URL fails", async () => {
    const { createFailoverTransport } = await import("../src/rpc.js");
    fetchSpy
      .mockRejectedValueOnce(new Error("primary down"))
      .mockRejectedValueOnce(new Error("secondary down"));

    const transport = createFailoverTransport(
      ["https://primary.example", "https://secondary.example"],
      { rounds: 1 },
    );

    await expect(
      transport({ payload: { jsonrpc: "2.0", id: 1, method: "getHealth" } }),
    ).rejects.toThrow(/secondary down/);
  });

  it("throws immediately when given zero URLs", async () => {
    const { createFailoverTransport } = await import("../src/rpc.js");
    expect(() => createFailoverTransport([])).toThrow(/at least one URL/);
  });

  it("retries across rounds when rounds > 1", async () => {
    const { createFailoverTransport } = await import("../src/rpc.js");
    // 1st round: both fail. 2nd round: primary succeeds.
    fetchSpy
      .mockRejectedValueOnce(new Error("first primary fail"))
      .mockRejectedValueOnce(new Error("first secondary fail"))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1, result: "recovered" }));

    const transport = createFailoverTransport(
      ["https://primary.example", "https://secondary.example"],
      { rounds: 2, backoffMs: 1 },
    );
    const out = await transport({ payload: { jsonrpc: "2.0", id: 1, method: "getHealth" } });

    expect(out).toMatchObject({ result: "recovered" });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
