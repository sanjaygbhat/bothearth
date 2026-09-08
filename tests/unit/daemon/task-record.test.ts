import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAgentLoop } from "../../../src/daemon/agent-loop.ts";
import { Store, taskSummaryFromEvents } from "../../../src/daemon/store.ts";
import { createFakeComputerClient } from "../../../src/computer-client/fake.ts";
import { createA11yDriver } from "../../../src/drivers/a11y.ts";

/**
 * A finished task has to be able to say how long it took and
 * what it did, and say the same thing every time it is asked. Before this the
 * duration did not exist and the receipt was recomputed on each render from a
 * capped activity feed, so a second look at the same task reported fewer steps
 * and no sites at all.
 */

/** A scripted run: navigate somewhere, then declare itself done. */
async function runOneNavigationTask(store: Store, computerId: string) {
  const computer = createFakeComputerClient(computerId);
  const task = store.insertTask({ computer_id: computerId, goal: "Open wikipedia and report the title", max_steps: 5 });
  const script = [
    { id: "go", name: "browser_navigate", arguments: { url: "https://www.wikipedia.org/" } },
    { id: "finish", name: "done", arguments: { summary: "The title is Wikipedia.", status: "success" } },
  ];
  let turn = 0;
  try {
    await runAgentLoop({
      taskId: task.id, computerId, goal: task.goal, model: "synthetic",
      computer, driver: createA11yDriver(computer), store,
      policyGate: () => ({ decision: "allow" }),
      adapter: { kind: "openai_compat", complete: async () => ({
        tool_calls: [script[turn++]!],
        usage: { tokens_in: 100, tokens_out: 20, usd_est: 0.02 },
      }) },
      emit: async (event) => {
        store.appendAuditRef({ type: event.type, body: event.body,
          task_id: task.id, computer_id: computerId, hash: "synthetic-unit-test" });
      },
    });
  } finally {
    await computer.close();
  }
  return task.id;
}

test("a finished task reports a real duration and a monotonic finish time", async () => {
  const store = new Store();
  try {
    const taskId = await runOneNavigationTask(store, "duration");
    const task = store.getTask(taskId)!;

    assert.equal(task.status, "completed");
    assert.ok(task.started_at, "a task that ran has a start time");
    assert.ok(task.finished_at, "a finished task has a finish time");
    assert.ok(Date.parse(task.started_at!) >= Date.parse(task.created_at),
      "work cannot start before the task was created");
    assert.ok(Number.isInteger(task.duration_ms), "duration is a number of milliseconds");

    // The finish clock may never precede the task's own last durable event —
    // the "Finished 12:58" over a feed holding 1:01 entries.
    const events = store.db.prepare(
      "SELECT ts FROM audit_refs WHERE task_id = ? ORDER BY seq DESC LIMIT 1",
    ).get(taskId) as { ts: string };
    assert.ok(task.finished_at! >= events.ts,
      `finish ${task.finished_at} must not precede the last event ${events.ts}`);
    assert.equal(task.duration_ms,
      Date.parse(task.finished_at!) - Date.parse(task.started_at!));
  } finally {
    store.close();
  }
});

test("re-reading a finished task returns byte-identical summaries", async () => {
  const store = new Store();
  try {
    const taskId = await runOneNavigationTask(store, "frozen");

    const first = store.getTask(taskId)!;
    assert.ok(first.summary, "a finished task carries its receipt");
    assert.deepEqual(first.summary!.sites, ["www.wikipedia.org"],
      "the site it visited survives into the frozen receipt");
    assert.ok(first.summary!.steps > 0, "steps are counted from the durable log");
    assert.equal(first.summary!.cost_usd, 0.04, "cost is the run total, both model turns");

    // Anything arriving after the freeze — a late audit append, another render,
    // a reload from disk — must not move the numbers.
    store.appendAuditRef({ type: "tool.call", task_id: taskId, computer_id: "frozen",
      body: { name: "browser_navigate", arguments: { url: "https://example.com/late" } },
      hash: "late-event" });

    const second = store.getTask(taskId)!;
    const third = store.listTasks().find((t) => t.id === taskId)!;
    assert.deepEqual(second.summary, first.summary, "the second read matches the first");
    assert.deepEqual(third.summary, first.summary, "the list endpoint matches the detail one");
    assert.equal(second.finished_at, first.finished_at);
    assert.equal(second.duration_ms, first.duration_ms);
    assert.equal(JSON.stringify(third.summary), JSON.stringify(first.summary));
  } finally {
    store.close();
  }
});

test("a frozen receipt survives a daemon restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mb-task-record-"));
  const path = join(dir, "state.sqlite");
  let store = new Store(path);
  try {
    const taskId = await runOneNavigationTask(store, "restart");
    const before = store.getTask(taskId)!;
    store.close();
    store = new Store(path);
    const after = store.getTask(taskId)!;
    assert.deepEqual(after.summary, before.summary);
    assert.equal(after.duration_ms, before.duration_ms);
    assert.equal(after.finished_at, before.finished_at);
    assert.equal(after.started_at, before.started_at);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the receipt counts what the operator was asked and what was saved", () => {
  const summary = taskSummaryFromEvents([
    { type: "usage", body_json: JSON.stringify({ steps: 0, usd_est: 0 }) },
    { type: "tool.result", body_json: JSON.stringify({ name: "browser_navigate", arguments: { url: "https://wikipedia.org/wiki/Main" }, result: { ok: true } }) },
    { type: "approval.requested", body_json: JSON.stringify({ gate: "new_domain" }) },
    { type: "tool.result", body_json: JSON.stringify({ name: "browser_navigate", arguments: { url: "https://wikipedia.org/wiki/Other" }, result: { ok: true } }) },
    { type: "approval.requested", body_json: JSON.stringify({ gate: "upload" }) },
    { type: "download.promoted", body_json: JSON.stringify({ path: "/workspace/out/report.csv" }) },
    { type: "usage", body_json: JSON.stringify({ steps: 14, usd_est: 0.31 }) },
    { type: "task.completed", body_json: JSON.stringify({ steps: 14 }) },
  ]);
  assert.deepEqual(summary, {
    steps: 14,
    sites: ["wikipedia.org"],
    asks: 2,
    files_saved: ["/workspace/out/report.csv"],
    cost_usd: 0.31,
  });
});

test("a task still running has no receipt and no finish time", async () => {
  const store = new Store();
  try {
    const task = store.insertTask({ computer_id: "running", goal: "still going", max_steps: 5 });
    store.appendAuditRef({ type: "tool.call", task_id: task.id, computer_id: "running",
      body: { name: "browser_navigate", arguments: { url: "https://example.com" } }, hash: "h" });
    const running = store.getTask(task.id)!;
    assert.equal(running.summary, null, "a receipt is only written for a finished task");
    assert.equal(running.finished_at, null);
    assert.ok(running.started_at, "the first tool call starts the clock");
  } finally {
    store.close();
  }
});

/**
 * `finishTask` flips a task to terminal synchronously, but its own
 * terminal audit event is appended later on the serialized audit tail. The UI
 * polls tasks and `rejectBusy()` lists them on every create, so a read lands in
 * that gap routinely. It must not freeze a receipt computed from the log so
 * far — that is the "14 steps → 10 steps, None" defect the freeze exists to
 * prevent, reintroduced by ordering.
 */
test("a read racing the finish never freezes an incomplete receipt", () => {
  const store = new Store();
  const computerId = "b2-race";
  try {
    const task = store.insertTask({ computer_id: computerId, goal: "race the audit tail", max_steps: 20 });
    const append = (type: string, body: Record<string, unknown>) =>
      store.appendAuditRef({ type, body, task_id: task.id, computer_id: computerId, hash: "b2" });

    append("tool.call", { name: "browser_navigate", arguments: { url: "https://www.wikipedia.org/" } });
    append("tool.result", { name: "browser_navigate", arguments: { url: "https://www.wikipedia.org/" }, result: { ok: true } });
    append("usage", { steps: 10, usd_est: 0.10 });

    // The gap: terminal status is durable, the terminal event is not yet.
    assert.equal(store.finishTask(task.id, "completed"), true);
    const during = store.getTask(task.id)!;
    assert.equal(during.status, "completed");
    assert.equal(during.summary!.steps, 10, "the read sees only what has been appended");
    assert.equal(
      (store.db.prepare("SELECT summary_json FROM tasks WHERE id = ?").get(task.id) as { summary_json: string | null }).summary_json,
      null,
      "a read must not persist a receipt computed from a partial log",
    );

    // The audit tail drains: the rest of the run's events land.
    append("tool.result", { name: "browser_navigate", arguments: { url: "https://en.wikipedia.org/" }, result: { ok: true } });
    append("approval.requested", { gate: "new_domain" });
    append("usage", { steps: 14, usd_est: 0.31 });
    append("task.completed", { steps: 14, reason: "done" });

    store.freezeTaskSummary(task.id);
    const frozen = store.getTask(task.id)!;
    assert.deepEqual(frozen.summary, {
      steps: 14,
      sites: ["www.wikipedia.org", "en.wikipedia.org"],
      asks: 1,
      files_saved: [],
      cost_usd: 0.31,
    }, "the frozen receipt is the post-flush receipt, not the one the racing read saw");

    // And it is now durable: a later event cannot move it, and neither can a
    // second freeze.
    append("tool.call", { name: "browser_navigate", arguments: { url: "https://example.com/late" } });
    store.freezeTaskSummary(task.id);
    assert.deepEqual(store.getTask(task.id)!.summary, frozen.summary);
    assert.deepEqual(store.listTasks().find((t) => t.id === task.id)!.summary, frozen.summary);
  } finally {
    store.close();
  }
});
