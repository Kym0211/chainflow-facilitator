import { closeSync, fdatasyncSync, openSync, writeSync } from "node:fs";

/**
 * One line in the audit log. Emitted exactly once per /settle attempt
 * that reached the facilitator (not for body-limit or missing-field rejects).
 */
export interface AuditRecord {
  timestamp: string;
  requestId: string;
  operation: "settle";
  result: "success" | "failure" | "error";
  durationMs: number;
  network?: string;
  scheme?: string;
  asset?: string;
  amount?: string;
  payTo?: string;
  payer?: string;
  transaction?: string;
  /** Truncated error message if result=error. Never contains the private key. */
  error?: string;
}

export interface AuditSink {
  record(entry: AuditRecord): Promise<void>;
  close(): Promise<void>;
}

/**
 * Append-only JSONL sink. Each record is fdatasync'd before record() resolves,
 * so a process crash immediately after resolve cannot lose the entry.
 * Writes are serialized through an internal promise chain to prevent
 * interleaved lines under concurrent settle calls.
 */
export class JsonlFileSink implements AuditSink {
  private fd: number | null;
  private chain: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.fd = openSync(path, "a");
  }

  async record(entry: AuditRecord): Promise<void> {
    const next = this.chain.then(() => this.writeOne(entry));
    // Keep the chain alive even if this write fails, so the next call still serializes.
    this.chain = next.catch(() => undefined);
    await next;
  }

  private async writeOne(entry: AuditRecord): Promise<void> {
    if (this.fd === null) throw new Error("AuditSink closed");
    const line = JSON.stringify(entry) + "\n";
    writeSync(this.fd, line);
    fdatasyncSync(this.fd);
  }

  async close(): Promise<void> {
    await this.chain.catch(() => undefined);
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}

/** In-memory sink — use from tests. */
export class InMemoryAuditSink implements AuditSink {
  readonly records: AuditRecord[] = [];
  async record(entry: AuditRecord): Promise<void> {
    this.records.push(entry);
  }
  async close(): Promise<void> {}
}

/** No-op sink — default when AUDIT_LOG_PATH is unset. */
export class NullAuditSink implements AuditSink {
  async record(): Promise<void> {}
  async close(): Promise<void> {}
}
