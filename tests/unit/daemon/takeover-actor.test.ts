import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startDaemon } from "../../../src/daemon/server.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";

// Handing a person the keyboard is the one action a security log must be able
// to attribute. Before this the audit row carried only the takeover id, so a
// second operator client could take control and the log could not say who.
test("the audit log names the task and the device that took control", async () => {
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const root = mkdtempSync(join(tmpdir(), "modelbot-takeover-actor-"));
  const daemon = await startDaemon({
    host: "127.0.0.1", port: 0, mcpToken: "actor-mcp", bootstrapToken: "actor-boot",
    workspaceRoot: root,
  });
  try {
    const { headers } = await bootstrapSession(daemon, "actor-boot");
    const post = async (path: string, body: unknown = {}) => {
      const res = await fetch(`${daemon.baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
      assert.ok(res.ok, `${path} -> ${res.status} ${await res.clone().text()}`);
      return (await res.json()) as Record<string, any>;
    };
    const devices = await (await fetch(`${daemon.baseUrl}/api/v1/session/devices`, { headers })).json() as
      { devices: Array<{ id: string; current: boolean }> };
    const me = devices.devices.find((device) => device.current)!.id;

    daemon.store.insertComputer({ id: "actor", name: "actor", capabilities: ["browser"], persistent: false, status: "running" });
    const task = daemon.store.insertTask({ computer_id: "actor", goal: "sign in", max_steps: 5 });

    const requested = await post("/api/v1/takeover/request", { computer_id: "actor", task_id: task.id });
    const id = requested.takeover.takeover_id as string;
    await post(`/api/v1/takeover/${id}/grant`);
    await post(`/api/v1/takeover/${id}/release`);

    const rows = daemon.store.listAuditRefs();
    for (const type of ["takeover.started", "takeover.released"]) {
      const row = rows.find((entry) => entry.type === type);
      assert.ok(row, `no ${type} audit row`);
      assert.equal(row.task_id, task.id, `${type} did not record the task`);
      const body = JSON.parse(row.body_json) as { actor?: string };
      assert.equal(body.actor, me, `${type} did not record who held control`);
      assert.ok(!JSON.stringify(body).includes(headers.cookie.split("=")[1]!),
        `${type} leaked the session cookie into the audit log`);
    }
  } finally {
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
  }
});
