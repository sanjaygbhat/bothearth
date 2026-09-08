import { createHmac } from "node:crypto";
import type { AuditHashPayload, AuditRecord } from "../types/contracts.ts";

/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 * Key sort: UTF-16 code units. Numbers: ES6 shortest round-trip
 * (`JSON.stringify` after rejecting non-finite; `-0` → `0`).
 * Strings: §3.2.2.2 (must-escape `"`, `\`, U+0000–U+001F only).
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serializeNumber(value);
    case "string":
      return serializeString(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((el) => serialize(el === undefined ? null : el)).join(",")}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      const parts: string[] = [];
      for (const key of keys) {
        const item = obj[key];
        if (item === undefined) continue;
        parts.push(`${serializeString(key)}:${serialize(item)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new TypeError(`JCS: unsupported type ${typeof value}`);
  }
}

function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new TypeError("JCS: NaN and Infinity are not permitted");
  }
  if (Object.is(n, -0)) return "0";
  // ES6 NumberToJSON / 1e21 scientific boundary — V8 JSON.stringify.
  return JSON.stringify(n);
}

/** RFC 8785 §3.2.2.2 */
function serializeString(s: string): string {
  let out = "\"";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += "\\\"";
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x09) out += "\\t";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0d) out += "\\r";
    else if (c < 0x20) {
      const hex = c.toString(16).padStart(4, "0");
      out += `\\u${hex}`;
    } else {
      out += s[i];
    }
  }
  return `${out}"`;
}

function auditPayload(record: AuditHashPayload): string {
  return canonicalJson(record);
}

export function hmacAuditHash(key: Buffer | string, payload: AuditHashPayload): string {
  const mac = createHmac("sha256", key).update(auditPayload(payload)).digest("hex");
  return `hmac-sha256:${mac}`;
}

export function sealAuditRecord(
  key: Buffer | string,
  payload: AuditHashPayload,
): AuditRecord {
  return { ...payload, hash: hmacAuditHash(key, payload) };
}

export function verifyAuditChain(
  key: Buffer | string,
  records: AuditRecord[],
): { ok: true } | { ok: false; seq: number; reason: string } {
  let prev = "genesis";
  for (const rec of records) {
    if (rec.prev_hash !== prev) {
      return { ok: false, seq: rec.seq, reason: "prev_hash mismatch" };
    }
    const { hash: _h, ...rest } = rec;
    const expect = hmacAuditHash(key, rest);
    if (rec.hash !== expect) {
      return { ok: false, seq: rec.seq, reason: "hash mismatch" };
    }
    prev = rec.hash;
  }
  return { ok: true };
}
