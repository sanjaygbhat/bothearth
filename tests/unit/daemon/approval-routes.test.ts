/**
 * `POST /api/v1/approvals/:id` records the decision the operator actually made,
 * and remembers a site only for the ask that was about a site.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CSRF_HEADER } from "../../../src/daemon/auth.ts";
import { startDaemon, type DaemonHandle } from "../../../src/daemon/server.ts";
import { createApproval } from "../../../src/policy/approvals.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";

const BOOT = "test-boot-token-approvals";

describe("approval decisions over HTTP", () => {
  let daemon: DaemonHandle;
  let origin: string;
  let session: { cookie: string; csrf: string };

  before(async () => {
    daemon = await startDaemon({
      host: "127.0.0.1",
      port: 0,
      mcpToken: "test-mcp-token-approvals",
      bootstrapToken: BOOT,
      workspaceRoot: mkdtempSync(join(tmpdir(), "mb-approvals-")),
    });
    origin = `http://127.0.0.1:${daemon.port}`;
    session = await bootstrapSession(daemon, BOOT);
  });
  after(async () => { await daemon.close(); });

  const headers = (extra: Record<string, string> = {}) => ({
    Origin: origin, Host: `127.0.0.1:${daemon.port}`, cookie: session.cookie, ...extra,
  });

  /**
   * The dispatcher only ever computes remembered origins for a `new_domain`
   * ask (dispatcher.ts). The HTTP route did not, so `allow_task` on a
   * `sensitive_action` or `upload` approval — answered about one action, not
   * one site — silently bought a task-lifetime origin grant nobody was shown.
   */
  for (const gate of ["sensitive_action", "upload", "download"] as const) {
    it(`allow_task on a ${gate} approval grants no origin`, async () => {
      const task = daemon.store.insertTask({ computer_id: "approvals", goal: `${gate} ask`, max_steps: 5 });
      const args = { url: "https://grant.example/page" };
      const request = createApproval({
        tool: "browser_navigate", args, gate, task_id: task.id,
        control_epoch: 0, origin: "https://grant.example",
      });
      daemon.store.insertApproval({
        id: request.approval_id, task_id: task.id, tool: "browser_navigate",
        args, gate, bind: request.bind as unknown as Record<string, unknown>,
      });

      const res = await fetch(`${daemon.baseUrl}/api/v1/approvals/${request.approval_id}`, {
        method: "POST",
        headers: headers({ [CSRF_HEADER]: session.csrf, "content-type": "application/json" }),
        body: JSON.stringify({ decision: "allow_task", bind: request.bind }),
      });
      assert.equal(res.status, 200, JSON.stringify(await res.json()));
      assert.deepEqual(daemon.store.taskGrantedOrigins(task.id), [],
        `${gate} is not a site decision and must grant nothing`);
      // The durable record still says what the human actually answered.
      assert.equal(daemon.store.getApproval(request.approval_id)!.decision, "allow_task");
    });
  }

  it("allow_task on a new_domain approval still grants the site", async () => {
    const task = daemon.store.insertTask({ computer_id: "approvals", goal: "new_domain ask", max_steps: 5 });
    const args = { url: "https://remember.example/page" };
    const request = createApproval({
      tool: "browser_navigate", args, gate: "new_domain", task_id: task.id,
      control_epoch: 0, origin: "https://remember.example",
    });
    daemon.store.insertApproval({
      id: request.approval_id, task_id: task.id, tool: "browser_navigate",
      args, gate: "new_domain", bind: request.bind as unknown as Record<string, unknown>,
    });
    const res = await fetch(`${daemon.baseUrl}/api/v1/approvals/${request.approval_id}`, {
      method: "POST",
      headers: headers({ [CSRF_HEADER]: session.csrf, "content-type": "application/json" }),
      body: JSON.stringify({ decision: "allow_task", bind: request.bind }),
    });
    assert.equal(res.status, 200, JSON.stringify(await res.json()));
    assert.ok(daemon.store.taskGrantedOrigins(task.id).includes("https://remember.example"));
  });
});
