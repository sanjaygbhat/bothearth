import assert from "node:assert/strict";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AuditLog } from "../../../src/audit/log.ts";
import { staticAuditKey } from "../../../src/audit/key.ts";
import { verifyAuditFile } from "../../../src/audit/verify.ts";

it("a failed append does not leave a sequence gap", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "mb-audit-failure-")), "audit.jsonl");
  const key = Buffer.from("append-failure-unit-test-key-1234");
  const log = new AuditLog({ path, keyProvider: staticAuditKey(key) });
  await log.append({ type: "task.started", body: {} });

  chmodSync(path, 0o400);
  await assert.rejects(log.append({ type: "tool.call", body: {} }));
  chmodSync(path, 0o600);
  await log.append({ type: "task.completed", body: {} });

  assert.equal(log.head().seq, 2);
  assert.deepEqual(verifyAuditFile(key, path), { ok: true, records: 2 });
});
