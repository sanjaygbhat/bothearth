import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { dirname } from "node:path";
import type { AuditRecord, EventType } from "../types/contracts.ts";
import { sealAuditRecord } from "./chain.ts";
import { canonicalJson } from "./chain.ts";
import type { AuditKeyProvider } from "./key.ts";
import { redactLogFields, redactStringValue } from "../daemon/log.ts";

/** Runtime audit types widen EventType with the anchor record. */
export type AuditLogType = EventType | "audit.anchor";

/** Forensic keys: the HMAC must keep tool I/O (DECISIONS R2). */
const FORENSIC_BODY_KEYS = new Set([
  "result",
  "content",
  "arguments",
  "prompt",
  "tool_result",
  "tool_arguments",
]);

// Probing the redactor allocates; audit append runs it once per key per record.
const secretShapedKeys = new Map<string, boolean>();

function isSecretShapedKey(key: string): boolean {
  let hit = secretShapedKeys.get(key);
  if (hit === undefined) {
    const probe = redactLogFields({ [key]: "x" }) as Record<string, unknown>;
    hit = probe[key] === "[redacted]";
    secretShapedKeys.set(key, hit);
  }
  return hit;
}

function redactAuditValue(value: unknown, key?: string): unknown {
  // Forensic keys stay in the record; children still redact.
  const forensic = key !== undefined && FORENSIC_BODY_KEYS.has(key);
  if (key && !forensic && isSecretShapedKey(key)) return "[REDACTED]";
  if (typeof value === "string") return redactStringValue(value);
  if (Array.isArray(value)) return value.map((v) => redactAuditValue(v));
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      out[k] = redactAuditValue(v, k);
    }
    return out;
  }
  return value;
}

/** Redact secret-shaped body keys before seal. Skip `audit.anchor`. */
export function redactAuditBody(
  type: AuditLogType,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (type === "audit.anchor") return body;
  return redactAuditValue(body) as Record<string, unknown>;
}

export interface AuditAppendInput {
  type: AuditLogType;
  ts?: string;
  task_id?: string;
  computer_id?: string;
  body: Record<string, unknown>;
}

export interface AuditLogOptions {
  path: string;
  keyProvider: AuditKeyProvider;
  /** Emit an audit.anchor every N records (default 100). */
  anchorEvery?: number;
}

export class AuditLog {
  readonly path: string;
  private readonly keyProvider: AuditKeyProvider;
  private readonly anchorEvery: number;
  private seq = 0;
  private prevHash = "genesis";
  private sinceAnchor = 0;

  constructor(opts: AuditLogOptions) {
    this.path = opts.path;
    this.keyProvider = opts.keyProvider;
    this.anchorEvery = opts.anchorEvery ?? 100;
    mkdirSync(dirname(this.path), { recursive: true });
    if (existsSync(this.path)) {
      this.replayHead();
    } else {
      writeFileSync(this.path, "", { mode: 0o600 });
    }
  }

  private replayHead(): void {
    const text = readFileSync(this.path, "utf8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      const rec = JSON.parse(line) as AuditRecord;
      this.seq = rec.seq;
      this.prevHash = rec.hash;
      this.sinceAnchor =
        (rec.type as string) === "audit.anchor" ? 0 : this.sinceAnchor + 1;
    }
  }

  async append(input: AuditAppendInput): Promise<AuditRecord> {
    const key = await this.keyProvider.getAuditHmacKey();
    const seq = this.seq + 1;
    const payload = {
      v: 1 as const,
      seq,
      ts: input.ts ?? new Date().toISOString(),
      type: input.type as EventType,
      ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
      ...(input.computer_id !== undefined
        ? { computer_id: input.computer_id }
        : {}),
      body: redactAuditBody(input.type, input.body),
      prev_hash: this.prevHash,
    };
    const sealed = sealAuditRecord(key, payload);
    appendFileSync(this.path, `${JSON.stringify(sealed)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    this.seq = seq;
    this.prevHash = sealed.hash;
    const headPayload = { v: 1, seq: this.seq, hash: this.prevHash };
    const head = {
      ...headPayload,
      mac: `hmac-sha256:${createHmac("sha256", key).update(canonicalJson(headPayload)).digest("hex")}`,
    };
    writeFileSync(`${this.path}.head`, `${JSON.stringify(head)}\n`, { mode: 0o600 });
    chmodSync(`${this.path}.head`, 0o600);
    this.sinceAnchor += 1;
    if (
      (input.type as string) !== "audit.anchor" &&
      this.sinceAnchor >= this.anchorEvery
    ) {
      await this.appendAnchor();
    }
    return sealed;
  }

  async appendAnchor(): Promise<AuditRecord> {
    this.sinceAnchor = 0;
    return this.append({
      type: "audit.anchor",
      body: { head: this.prevHash, seq: this.seq },
    });
  }

  /**
   * Takeover gap marker — ARCH: takeover.gap + {t0,t1,frames_suppressed:true}.
   */
  async appendTakeoverGap(opts: {
    t0: string;
    t1: string;
    task_id?: string;
    computer_id?: string;
  }): Promise<AuditRecord> {
    return this.append({
      type: "takeover.gap",
      task_id: opts.task_id,
      computer_id: opts.computer_id,
      body: {
        t0: opts.t0,
        t1: opts.t1,
        frames_suppressed: true,
      },
    });
  }

  head(): { seq: number; prev_hash: string } {
    return { seq: this.seq, prev_hash: this.prevHash };
  }
}

export function readAuditRecords(path: string): AuditRecord[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AuditRecord);
}
