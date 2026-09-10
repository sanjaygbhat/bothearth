/**
 * A terminal task cannot still be the reason "your bot needs you" is lit:
 * `finishTask` must close out any takeover it opened that nobody answered,
 * and `isTakeoverPending` — the one predicate idle-pause, the harness wait
 * and the standalone loop all now share — must agree on when a takeover has
 * stopped asking.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FakeComputer } from "../../../src/computer-client/fake.ts";
import { createToolDispatcher } from "../../../src/daemon/dispatcher.ts";
import { startDaemon } from "../../../src/daemon/server.ts";
import { isTakeoverPending, Store } from "../../../src/daemon/store.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";
import { until } from "../../helpers/until.ts";

describe("finishTask closes takeovers", () => {
  it("terminates an unresolved takeover once its task fails", () => {
    const store = new Store();
    store.insertComputer({ id: "c1", name: "c1", capabilities: ["browser"], persistent: false, status: "running" });
    const task = store.insertTask({ computer_id: "c1", goal: "sign in", max_steps: 5 });
    store.insertTakeover({ id: "t1", computer_id: "c1", task_id: task.id, state: "takeover_requested", expires_at: null });
    assert.equal(store.finishTask(task.id, "failed"), true);
    assert.equal(store.getTakeover("t1")?.state, "terminated");
    assert.equal(store.activeTakeoverForComputer("c1"), undefined);
    store.close();
  });

  for (const state of ["human", "resume_validating", "paused", "takeover_requested"] as const) it(`preserves ${state} control and its owner after cancellation`, () => {
    const store = new Store();
    store.insertComputer({ id: "c2", name: "c2", capabilities: ["browser"], persistent: false, status: "running" });
    const task = store.insertTask({ computer_id: "c2", goal: "checkout", max_steps: 5 });
    store.insertTakeover({ id: "t2", computer_id: "c2", task_id: task.id, state: "takeover_requested",
      expires_at: new Date(Date.now() + 60_000).toISOString() });
    store.grantTakeoverTo("t2", "operator-device");
    store.updateTakeoverState("t2", state);
    assert.equal(store.finishTask(task.id, "cancelled"), true);
    assert.equal(store.getTakeover("t2")?.state, state);
    assert.equal(store.activeTakeoverForComputer("c2", "a-new-task")?.granted_to, "operator-device");
    assert.equal(store.closeStaleTakeovers().closed, 0, "boot must not erase human control either");
    store.close();
  });

  it("leaves an already-resolved (agent) takeover alone", () => {
    const store = new Store();
    store.insertComputer({ id: "c3", name: "c3", capabilities: ["browser"], persistent: false, status: "running" });
    const task = store.insertTask({ computer_id: "c3", goal: "browse", max_steps: 5 });
    store.insertTakeover({ id: "t3", computer_id: "c3", task_id: task.id, state: "agent", expires_at: null });
    store.finishTask(task.id, "completed");
    assert.equal(store.getTakeover("t3")?.state, "agent");
    store.close();
  });

  it("a second finishTask call on an already-terminal task is a no-op", () => {
    const store = new Store();
    store.insertComputer({ id: "c4", name: "c4", capabilities: ["browser"], persistent: false, status: "running" });
    const task = store.insertTask({ computer_id: "c4", goal: "retry", max_steps: 5 });
    store.insertTakeover({ id: "t4", computer_id: "c4", task_id: task.id, state: "human",
      expires_at: new Date(Date.now() + 60_000).toISOString() });
    assert.equal(store.finishTask(task.id, "failed"), true);
    assert.equal(store.finishTask(task.id, "failed"), false);
    assert.equal(store.getTakeover("t4")?.state, "human");
    store.close();
  });
});

describe("isTakeoverPending", () => {
  it("a pending ask with no expiry is pending forever", () => {
    assert.equal(isTakeoverPending({ id: "a", computer_id: "c", task_id: null,
      state: "takeover_requested", expires_at: null, created_at: "", epoch: 0, declined: 0, granted_to: null }), true);
  });

  it("a granted, unexpired lease is pending", () => {
    assert.equal(isTakeoverPending({ id: "a", computer_id: "c", task_id: null,
      state: "human", expires_at: new Date(Date.now() + 60_000).toISOString(), created_at: "", epoch: 0, declined: 0, granted_to: "operator" }), true);
  });

  it("a lapsed lease (state paused) is not pending", () => {
    assert.equal(isTakeoverPending({ id: "a", computer_id: "c", task_id: null,
      state: "paused", expires_at: new Date(Date.now() - 1000).toISOString(), created_at: "", epoch: 0, declined: 0, granted_to: "operator" }), false);
  });

  it("a granted lease whose clock already ran out is not pending, even before the sweep flips its state", () => {
    assert.equal(isTakeoverPending({ id: "a", computer_id: "c", task_id: null,
      state: "human", expires_at: new Date(Date.now() - 1000).toISOString(), created_at: "", epoch: 0, declined: 0, granted_to: "operator" }), false);
  });

  it("terminated, or no row at all, is not pending", () => {
    assert.equal(isTakeoverPending({ id: "a", computer_id: "c", task_id: null,
      state: "terminated", expires_at: null, created_at: "", epoch: 0, declined: 0, granted_to: null }), false);
    assert.equal(isTakeoverPending(undefined), false);
  });
});

describe("a takeover another task left open", () => {
  /** Computer, a task that ended, its unanswered ask, and a fresh task on the same computer. */
  function leftover(store: Store) {
    store.insertComputer({ id: "shared", name: "shared", capabilities: ["browser"], persistent: true, status: "running" });
    const dead = store.insertTask({ computer_id: "shared", goal: "sign in", max_steps: 5 });
    store.insertTakeover({ id: "leftover", computer_id: "shared", task_id: dead.id,
      state: "takeover_requested", expires_at: null });
    return { dead, next: store.insertTask({ computer_id: "shared", goal: "read mail", max_steps: 5 }) };
  }

  it("is closed at boot when its task is terminal, and a live task's row is left alone", () => {
    const path = join(mkdtempSync(join(tmpdir(), "modelbot-stale-takeover-")), "state.sqlite");
    let store = new Store(path);
    const { dead, next } = leftover(store);
    // The pre-W5 daemon died without closing the row, so write the terminal
    // status the way a crashed process leaves it: task terminal, takeover open.
    store.finishTask(dead.id, "failed");
    store.updateTakeoverState("leftover", "takeover_requested");
    store.insertTakeover({ id: "live", computer_id: "shared", task_id: next.id,
      state: "takeover_requested", expires_at: null });
    store.close();

    store = new Store(path);
    assert.deepEqual(store.closeStaleTakeovers(), { applied: true, closed: 1 });
    assert.equal(store.getTakeover("leftover")?.state, "terminated");
    assert.equal(store.getTakeover("live")?.state, "takeover_requested");
    // Versioned, so a second boot is a no-op.
    assert.deepEqual(store.closeStaleTakeovers(), { applied: false, closed: 0 });
    store.close();

    const reopened = new Store(path);
    assert.deepEqual(reopened.closeStaleTakeovers(), { applied: false, closed: 0 });
    reopened.close();
  });

  it("closes an unanswered row whose task row is gone entirely", () => {
    const store = new Store();
    store.insertComputer({ id: "shared", name: "shared", capabilities: ["browser"], persistent: false, status: "running" });
    store.insertTakeover({ id: "orphan", computer_id: "shared", task_id: "task_deleted",
      state: "takeover_requested", expires_at: null });
    assert.equal(store.closeStaleTakeovers().closed, 1);
    assert.equal(store.getTakeover("orphan")?.state, "terminated");
    store.close();
  });

  it("never stalls the next task: its own tools run and it is not reported as waiting", async () => {
    const store = new Store(), computer = new FakeComputer("shared");
    const { dead, next } = leftover(store);
    store.finishTask(dead.id, "failed");
    store.updateTakeoverState("leftover", "takeover_requested");
    const dispatcher = createToolDispatcher({ store, getClient: () => computer, emit: () => {} });
    try {
      // The blocker: this returned E_TAKEOVER_BUSY for the old task's row, so
      // the new task took zero steps.
      const result = await dispatcher.dispatch("browser_snapshot", {},
        { computerId: "shared", taskId: next.id });
      assert.equal(result.ok, true);
      assert.equal(store.activeTakeoverForComputer("shared", next.id), undefined);
      assert.equal(isTakeoverPending(store.activeTakeoverForComputer("shared", next.id)), false);
      // Unscoped reads agree: the row belongs to a task that has ended.
      assert.equal(store.activeTakeoverForComputer("shared"), undefined);
    } finally { await computer.close(); store.close(); }
  });

  it("a live task's own pending row still stops it, and still stops nobody else", async () => {
    const store = new Store(), computer = new FakeComputer("shared");
    const { next } = leftover(store);
    const mine = store.listTakeovers()[0]!;
    const dispatcher = createToolDispatcher({ store, getClient: () => computer, emit: () => {} });
    try {
      const blocked = await dispatcher.dispatch("browser_snapshot", {},
        { computerId: "shared", taskId: mine.task_id! });
      assert.equal(!blocked.ok && blocked.error.code, "E_TAKEOVER_BUSY");
      assert.equal((await dispatcher.dispatch("browser_snapshot", {},
        { computerId: "shared", taskId: next.id })).ok, true);
    } finally { await computer.close(); store.close(); }
  });

  it("an operator takeover with no task blocks every task on the computer", async () => {
    const store = new Store(), computer = new FakeComputer("shared");
    const { next } = leftover(store);
    store.updateTakeoverState("leftover", "terminated");
    store.insertTakeover({ id: "operator", computer_id: "shared", state: "human",
      expires_at: new Date(Date.now() + 60_000).toISOString() });
    const dispatcher = createToolDispatcher({ store, getClient: () => computer, emit: () => {} });
    try {
      const result = await dispatcher.dispatch("browser_snapshot", {},
        { computerId: "shared", taskId: next.id });
      assert.equal(!result.ok && result.error.code, "E_TAKEOVER_BUSY");
    } finally { await computer.close(); store.close(); }
  });
});

/**
 * Belt and braces for the boot migration: a row can also be left behind by a
 * task that is still marked running, which no migration will ever close. The
 * computer's gate is the authority on who holds it.
 */
describe("a task starting on a computer the agent already controls", () => {
  it("closes a pending row another task left, when the gate says agent", async () => {
    const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
    process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
    const daemon = await startDaemon({
      host: "127.0.0.1", port: 0, mcpToken: "stale-takeover-mcp", bootstrapToken: "stale-takeover-boot",
      workspaceRoot: mkdtempSync(join(tmpdir(), "mb-stale-takeover-")),
      agentLoop: { model: "test", adapter: { kind: "openai_compat", complete: async () => ({
        tool_calls: [{ id: "finish", name: "done" as const, arguments: { summary: "done" } }],
        usage: { tokens_in: 1, tokens_out: 1, usd_est: 0 },
      }) } },
    });
    try {
      const { headers } = await bootstrapSession(daemon, "stale-takeover-boot");
      daemon.store.insertComputer({ id: "shared", name: "shared", capabilities: ["browser"], persistent: false, status: "running" });
      const other = daemon.store.insertTask({ computer_id: "shared", goal: "sign in", max_steps: 5 });
      daemon.store.insertTakeover({ id: "leftover", computer_id: "shared", task_id: other.id,
        state: "takeover_requested", expires_at: null });

      const res = await fetch(`${daemon.baseUrl}/api/v1/tasks`, { method: "POST", headers,
        body: JSON.stringify({ computer_id: "shared", goal: "read mail", max_steps: 2 }) });
      assert.equal(res.status, 201);
      const started = ((await res.json()) as { task: { id: string } }).task;
      await until(() => daemon.store.getTakeover("leftover")?.state === "terminated",
        "the row another task left open was never closed");
      await until(() => daemon.store.getTask(started.id)?.status === "completed",
        "the new task never ran");
    } finally {
      await daemon.close();
      if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
      else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
    }
  });
});
