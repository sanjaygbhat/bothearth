import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../../../src/daemon/store.ts";
import { FakeComputer } from "../../../src/computer-client/fake.ts";
import { createToolDispatcher } from "../../../src/daemon/dispatcher.ts";

test("restarted computer reports its durable busy lease without opening model access", async () => {
  const root = mkdtempSync(join(tmpdir(), "modelbot-status-restart-"));
  const path = join(root, "state.sqlite");
  let store = new Store(path);
  store.insertComputer({ id: "restart", name: "restart", capabilities: ["browser"], persistent: true, status: "running" });
  const task = store.insertTask({ computer_id: "restart", goal: "login", max_steps: 5 });
  const lease = store.insertTakeover({ id: "persisted-lease", computer_id: "restart", task_id: task.id,
    state: "paused", expires_at: new Date(Date.now() - 1000).toISOString(), epoch: 8 });
  store.close();
  store = new Store(path);
  const dispatcher = createToolDispatcher({ store, getClient: () => {
    assert.fail("durable busy status and capture denial must not consult a fresh AGENT client");
  }, emit: () => {} });
  const context = { computerId: "restart", taskId: task.id };
  try {
    for (const state of ["paused", "human", "takeover_requested", "resume_validating"] as const) {
      store.updateTakeoverState(lease.id, state);
      const status = await dispatcher.dispatch("takeover_status", { takeover_id: lease.id }, context);
      assert.deepEqual(status, { ok: true, data: { takeover_id: lease.id,
        state: state === "takeover_requested" ? "requested" : state === "resume_validating" ? "validating" : state,
        expires_at: lease.expires_at, epoch: 8 } });
      for (const args of [{}, { takeover_id: "" }, { takeover_id: null }]) {
        assert.deepEqual(await dispatcher.dispatch("takeover_status", args, context), status, "empty or omitted ID queries the current durable lease");
      }
      for (const tool of ["browser_snapshot", "browser_screenshot"] as const) {
        const result = await dispatcher.dispatch(tool, {}, context);
        assert.equal(!result.ok && result.error.code, "E_TAKEOVER_BUSY");
      }
    }
    const wrong = await dispatcher.dispatch("takeover_status", { takeover_id: "other-computer-lease" }, context);
    assert.equal(!wrong.ok && wrong.error.code, "E_IO");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});


test("a sensitive action returns the newly created lease metadata without executing the action", async () => {
  const store = new Store(), computer = new FakeComputer("guard-contract");
  store.insertComputer({ id: computer.computerId, name: "Synthetic", capabilities: ["browser"], persistent: false, status: "running" });
  const task = store.insertTask({ computer_id: computer.computerId, goal: "synthetic guard", max_steps: 5 });
  const dispatcher = createToolDispatcher({ store, getClient: () => computer, emit: () => {},
    execute: async () => assert.fail("a sensitive action must never execute") });
  const context = { computerId: computer.computerId, taskId: task.id, origin: "https://fixture.example",
    signals: { password_field: true }, originSets: { readable: ["fixture.example"], writable: ["fixture.example"] } };
  try {
    const result = await dispatcher.dispatch("browser_click", { ref: "synthetic-control" }, context);
    const lease = store.activeTakeoverForComputer(computer.computerId)!;
    assert.ok(lease);
    assert.deepEqual(result, { ok: false, error: { code: "E_TAKEOVER_BUSY", message: "password_field",
      details: { takeover_id: lease.id, state: "requested" } } });
    const status = await dispatcher.dispatch("takeover_status", { takeover_id: "" }, context);
    assert.equal(status.ok && (status.data as { takeover_id: string }).takeover_id, lease.id);
    assert.equal((await dispatcher.dispatch("browser_snapshot", {}, context)).ok, false);
  } finally { await computer.close(); store.close(); }
});
