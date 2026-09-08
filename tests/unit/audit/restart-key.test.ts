import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { startDaemon } from "../../../src/daemon/server.ts";
import { verifyAuditFile } from "../../../src/audit/verify.ts";

it("fallback audit key survives a simulated daemon restart", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "mb-audit-restart-"));
  const options = {
    host: "127.0.0.1",
    port: 0,
    listen: false,
    mcpToken: "restart-mcp-token",
    bootstrapToken: "restart-bootstrap-token",
    workspaceRoot,
  };
  const first = await startDaemon(options);
  await first.auditLog.append({ type: "task.started", body: { run: 1 } });
  await first.close();

  const second = await startDaemon(options);
  await second.auditLog.append({ type: "task.completed", body: { run: 2 } });
  await second.close();

  const keyPath = join(workspaceRoot, "audit.key");
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  assert.deepEqual(
    verifyAuditFile(readFileSync(keyPath), join(workspaceRoot, "audit.jsonl")),
    { ok: true, records: 2 },
  );
});
