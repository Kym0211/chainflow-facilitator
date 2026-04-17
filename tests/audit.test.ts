import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlFileSink, type AuditRecord } from "../src/audit.js";

function makeTmp() {
  return join(tmpdir(), `audit-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
}

const sample = (overrides: Partial<AuditRecord> = {}): AuditRecord => ({
  timestamp: "2026-04-17T16:00:00.000Z",
  requestId: "req-1",
  operation: "settle",
  result: "success",
  durationMs: 42,
  network: "solana:test",
  ...overrides,
});

describe("JsonlFileSink", () => {
  let path: string | undefined;

  afterEach(() => {
    if (path && existsSync(path)) unlinkSync(path);
    path = undefined;
  });

  it("writes one JSON line per record, newline-terminated", async () => {
    path = makeTmp();
    const sink = new JsonlFileSink(path);
    await sink.record(sample({ requestId: "a" }));
    await sink.record(sample({ requestId: "b", result: "failure" }));
    await sink.close();

    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).requestId).toBe("a");
    expect(JSON.parse(lines[1]).requestId).toBe("b");
    expect(JSON.parse(lines[1]).result).toBe("failure");
  });

  it("appends to an existing file without truncating prior records", async () => {
    path = makeTmp();
    const s1 = new JsonlFileSink(path);
    await s1.record(sample({ requestId: "first" }));
    await s1.close();

    const s2 = new JsonlFileSink(path);
    await s2.record(sample({ requestId: "second" }));
    await s2.close();

    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines.map((l) => JSON.parse(l).requestId)).toEqual(["first", "second"]);
  });

  it("serializes concurrent writes so no lines interleave", async () => {
    path = makeTmp();
    const sink = new JsonlFileSink(path);
    const writes = Array.from({ length: 50 }, (_, i) =>
      sink.record(sample({ requestId: `req-${i}` })),
    );
    await Promise.all(writes);
    await sink.close();

    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(50);
    // Every line must be valid JSON — proves no interleaving.
    const ids = lines.map((l) => JSON.parse(l).requestId);
    expect(new Set(ids).size).toBe(50);
  });

  it("rejects writes after close()", async () => {
    path = makeTmp();
    const sink = new JsonlFileSink(path);
    await sink.close();
    await expect(sink.record(sample())).rejects.toThrow(/closed/i);
  });
});
