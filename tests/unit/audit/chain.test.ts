import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { AuditLog, readAuditRecords } from "../../../src/audit/log.ts";
import { staticAuditKey } from "../../../src/audit/key.ts";
import { verifyAuditFile, verifyAuditRecords } from "../../../src/audit/verify.ts";
import { sealAuditRecord } from "../../../src/audit/chain.ts";
import type { AuditRecord } from "../../../src/types/contracts.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../../../src/cli/index.ts");

/**
 * Rewrite a middle record body and reseal every later hash with attackKey.
 * With the wrong key verification fails; with the real key it forges a valid
 * chain, which is the tamper-evident (not tamper-proof) threat model.
 */
function tamperMiddleAndReseal(
  records: AuditRecord[],
  index: number,
  attackKey: Buffer | string,
  bodyPatch: Record<string, unknown>,
): AuditRecord[] {
  const out = records.map((r) => structuredClone(r));
  let prev = index === 0 ? "genesis" : out[index - 1]!.hash;
  for (let i = index; i < out.length; i++) {
    const cur = out[i]!;
    const body = i === index ? { ...cur.body, ...bodyPatch } : { ...cur.body };
    const sealed = sealAuditRecord(attackKey, {
      v: 1,
      seq: cur.seq,
      ts: cur.ts,
      type: cur.type,
      ...(cur.task_id !== undefined ? { task_id: cur.task_id } : {}),
      ...(cur.computer_id !== undefined ? { computer_id: cur.computer_id } : {}),
      body,
      prev_hash: prev,
    });
    out[i] = sealed;
    prev = sealed.hash;
  }
  return out;
}

describe("audit HMAC chain", () => {
  it("append-only log verifies; gap marker has frames_suppressed:true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-audit-"));
    const path = join(dir, "audit.jsonl");
    const key = Buffer.from("unit-test-audit-key-0123456789ab");
    const log = new AuditLog({
      path,
      keyProvider: staticAuditKey(key),
      anchorEvery: 10,
    });
    await log.append({ type: "task.started", task_id: "t1", body: {} });
    await log.append({
      type: "tool.call",
      task_id: "t1",
      body: { tool: "browser_click" },
    });
    const gap = await log.appendTakeoverGap({
      t0: "2026-09-02T12:00:00.000Z",
      t1: "2026-09-02T12:01:00.000Z",
      task_id: "t1",
    });
    assert.equal(gap.type, "takeover.gap");
    assert.equal(gap.body.frames_suppressed, true);

    const v = verifyAuditFile(key, path);
    assert.deepEqual(v, { ok: true, records: 3 });
  });

  it("periodic anchor records appear", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-audit-"));
    const path = join(dir, "audit.jsonl");
    const key = Buffer.from("anchor-key");
    const log = new AuditLog({
      path,
      keyProvider: staticAuditKey(key),
      anchorEvery: 2,
    });
    await log.append({ type: "task.started", body: {} });
    await log.append({ type: "tool.call", body: { tool: "done" } });
    // second append should trigger anchor
    const records = readAuditRecords(path);
    assert.ok(records.some((r) => (r.type as string) === "audit.anchor"));
    assert.equal(verifyAuditFile(key, path).ok, true);
  });

  it("rewrite middle + recompute subsequent hashes with wrong key → verify fail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-audit-"));
    const path = join(dir, "audit.jsonl");
    const key = Buffer.from("real-hmac-key");
    const log = new AuditLog({
      path,
      keyProvider: staticAuditKey(key),
      anchorEvery: 100,
    });
    await log.append({ type: "task.started", task_id: "t1", body: {} });
    await log.append({
      type: "tool.call",
      task_id: "t1",
      body: { tool: "browser_navigate" },
    });
    await log.append({
      type: "task.completed",
      task_id: "t1",
      body: { status: "success" },
    });

    const records = readAuditRecords(path);
    const attacked = tamperMiddleAndReseal(
      records,
      1,
      Buffer.from("wrong-key"),
      { tool: "browser_navigate", evil: true },
    );
    const v = verifyAuditRecords(key, attacked);
    assert.equal(v.ok, false);
  });

  it("rewrite middle + recompute with real key forges chain (tamper-evident claim)", async () => {
    // Documented: host with HMAC key can forge; verify passes after reseal with real key.
    const key = Buffer.from("real-hmac-key");
    const r1 = sealAuditRecord(key, {
      v: 1,
      seq: 1,
      ts: "2026-09-02T12:00:00.000Z",
      type: "task.started",
      body: {},
      prev_hash: "genesis",
    });
    const r2 = sealAuditRecord(key, {
      v: 1,
      seq: 2,
      ts: "2026-09-02T12:00:01.000Z",
      type: "tool.call",
      body: { tool: "browser_click" },
      prev_hash: r1.hash,
    });
    const r3 = sealAuditRecord(key, {
      v: 1,
      seq: 3,
      ts: "2026-09-02T12:00:02.000Z",
      type: "task.completed",
      body: {},
      prev_hash: r2.hash,
    });
    const forged = tamperMiddleAndReseal([r1, r2, r3], 1, key, {
      tool: "browser_click",
      laundered: true,
    });
    // With the real key, an attacker who reseals can make verify pass —
    // this documents the threat model (keyed ≠ root-proof).
    assert.equal(verifyAuditRecords(key, forged).ok, true);
  });

  it("truncation / reorder detected", async () => {
    const key = Buffer.from("reorder-key");
    const r1 = sealAuditRecord(key, {
      v: 1,
      seq: 1,
      ts: "2026-09-02T12:00:00.000Z",
      type: "task.started",
      body: {},
      prev_hash: "genesis",
    });
    const r2 = sealAuditRecord(key, {
      v: 1,
      seq: 2,
      ts: "2026-09-02T12:00:01.000Z",
      type: "tool.call",
      body: {},
      prev_hash: r1.hash,
    });
    const r3 = sealAuditRecord(key, {
      v: 1,
      seq: 3,
      ts: "2026-09-02T12:00:02.000Z",
      type: "task.completed",
      body: {},
      prev_hash: r2.hash,
    });
    assert.equal(verifyAuditRecords(key, [r1, r3]).ok, false); // truncation/gap
    assert.equal(verifyAuditRecords(key, [r1, r3, r2]).ok, false); // reorder
  });

  it("modelbot audit verify CLI detects edit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-audit-cli-"));
    const path = join(dir, "audit.jsonl");
    const keyPath = join(dir, "audit.key");
    const key = Buffer.from("cli-key");
    writeFileSync(keyPath, key, { mode: 0o600 });
    const log = new AuditLog({
      path,
      keyProvider: staticAuditKey(key),
      anchorEvery: 100,
    });
    await log.append({ type: "task.started", body: {} });
    await log.append({ type: "tool.call", body: { tool: "done" } });

    const ok = spawnSync(
      process.execPath,
      ["--experimental-strip-types", cli, "audit", "verify", "--path", path, "--key-file", keyPath],
      {
        env: {
          ...process.env,
        },
        encoding: "utf8",
      },
    );
    assert.equal(ok.status, 0, ok.stderr);

    // Edit middle line without resealing
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const mid = JSON.parse(lines[1]!);
    mid.body = { tool: "done", evil: true };
    lines[1] = JSON.stringify(mid);
    writeFileSync(path, lines.join("\n") + "\n");

    const bad = spawnSync(
      process.execPath,
      ["--experimental-strip-types", cli, "audit", "verify", "--path", path, "--key-file", keyPath],
      {
        env: {
          ...process.env,
        },
        encoding: "utf8",
      },
    );
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /FAIL/);
  });
});
