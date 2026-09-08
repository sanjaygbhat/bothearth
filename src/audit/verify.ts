import type { AuditHashPayload, AuditRecord } from "../types/contracts.ts";
import { canonicalJson, hmacAuditHash, verifyAuditChain } from "./chain.ts";
import { readAuditRecords } from "./log.ts";
import { existsSync, readFileSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";

export type VerifyResult =
  | { ok: true; records: number }
  | {
      ok: false;
      reason: string;
      seq?: number;
      records?: number;
    };

/**
 * Verify JSONL audit file: chain links, HMAC over full canonical record,
 * detect edit / reorder / truncation (seq continuity).
 */
export function verifyAuditFile(
  key: Buffer | string,
  path: string,
): VerifyResult {
  const records = readAuditRecords(path);
  const verified = verifyAuditRecords(key, records);
  if (!verified.ok) return verified;
  const headPath = `${path}.head`;
  if (!existsSync(headPath)) {
    return records.length === 0
      ? { ok: false, reason: "audit log and expected head are missing", records: 0 }
      : { ok: false, reason: "expected audit head is missing", records: records.length };
  }
  try {
    const head = JSON.parse(readFileSync(headPath, "utf8")) as {
      v: number;
      seq: number;
      hash: string;
      mac: string;
    };
    const payload = { v: head.v, seq: head.seq, hash: head.hash };
    const expected = `hmac-sha256:${createHmac("sha256", key).update(canonicalJson(payload)).digest("hex")}`;
    const actualBytes = Buffer.from(head.mac);
    const expectedBytes = Buffer.from(expected);
    if (
      actualBytes.length !== expectedBytes.length ||
      !timingSafeEqual(actualBytes, expectedBytes)
    ) {
      return { ok: false, reason: "expected head MAC mismatch", records: records.length };
    }
    const tail = records.at(-1);
    if (!tail || head.seq !== tail.seq || head.hash !== tail.hash) {
      return { ok: false, reason: "valid audit suffix was truncated", records: records.length };
    }
  } catch {
    return { ok: false, reason: "expected audit head is malformed", records: records.length };
  }
  return verified;
}

export function verifyAuditRecords(
  key: Buffer | string,
  records: AuditRecord[],
): VerifyResult {
  if (records.length === 0) {
    return { ok: true, records: 0 };
  }

  for (let i = 0; i < records.length; i++) {
    const expectSeq = i + 1;
    if (records[i]!.seq !== expectSeq) {
      return {
        ok: false,
        reason: `seq discontinuity: want ${expectSeq} got ${records[i]!.seq}`,
        seq: records[i]!.seq,
        records: records.length,
      };
    }
  }

  const chain = verifyAuditChain(key, records);
  if (!chain.ok) {
    return {
      ok: false,
      reason: chain.reason,
      seq: chain.seq,
      records: records.length,
    };
  }

  for (const rec of records) {
    if (!rec.hash.startsWith("hmac-sha256:")) {
      return {
        ok: false,
        reason: "hash scheme not hmac-sha256",
        seq: rec.seq,
        records: records.length,
      };
    }
    const { hash: _h, ...rest } = rec;
    const expect = hmacAuditHash(key, rest as AuditHashPayload);
    if (expect !== rec.hash) {
      return {
        ok: false,
        reason: "hash mismatch",
        seq: rec.seq,
        records: records.length,
      };
    }
  }

  return { ok: true, records: records.length };
}
