import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sealAuditRecord, verifyAuditChain } from "../../src/audit/chain.ts";
import type { AuditRecord } from "../../src/types/contracts.ts";

describe("audit hash chain", () => {
  it("verifies 3-record golden chain and fails on type/body edit", () => {
    const key = Buffer.from("test-audit-key");
    const r1 = sealAuditRecord(key, {
      v: 1,
      seq: 1,
      ts: "2026-09-02T12:00:00.000Z",
      type: "task.started",
      task_id: "t_1",
      computer_id: "c_1",
      body: {},
      prev_hash: "genesis",
    });
    const r2 = sealAuditRecord(key, {
      v: 1,
      seq: 2,
      ts: "2026-09-02T12:00:01.000Z",
      type: "tool.call",
      task_id: "t_1",
      computer_id: "c_1",
      body: { tool: "browser_navigate" },
      prev_hash: r1.hash,
    });
    const r3 = sealAuditRecord(key, {
      v: 1,
      seq: 3,
      ts: "2026-09-02T12:00:02.000Z",
      type: "task.completed",
      task_id: "t_1",
      computer_id: "c_1",
      body: { status: "success" },
      prev_hash: r2.hash,
    });

    const chain: AuditRecord[] = [r1, r2, r3];
    assert.deepEqual(verifyAuditChain(key, chain), { ok: true });

    const typeEdit = structuredClone(chain);
    typeEdit[1] = { ...typeEdit[1], type: "tool.result" };
    assert.equal(verifyAuditChain(key, typeEdit).ok, false);

    const bodyEdit = structuredClone(chain);
    bodyEdit[1] = {
      ...bodyEdit[1],
      body: { tool: "browser_navigate", evil: true },
    };
    assert.equal(verifyAuditChain(key, bodyEdit).ok, false);
  });
});
