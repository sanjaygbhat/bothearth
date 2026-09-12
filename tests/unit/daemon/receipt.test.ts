/**
 * The task receipt may only describe calls that came back `ok`, and may only
 * offer a file that is still on disk.
 *
 * The receipt used to be built from `tool.call` arguments, so a `write_file`
 * the computer rejected with `E_CAPABILITY` was still listed under "Files it
 * saved" with a working-looking Open button and a byte count, and a navigation
 * that never happened still counted as a site visited. Correcting the
 * projection did not touch the rows already frozen, so a re-opened task still
 * offered the phantom file on the same screen that says the write was
 * rejected. Two things close that: a one-time sweep over the frozen rows, and
 * a check on the way out of the API for everything else.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RECEIPT_REPAIR_VERSION, Store, taskSummaryFromEvents } from "../../../src/daemon/store.ts";
import { artifactOnDisk, verifiedArtifacts } from "../../../src/daemon/server.ts";

const rejected = {
  ok: false,
  error: { code: "E_CAPABILITY", message: "unknown method: write_file" },
};

test("a rejected write_file leaves no file on the receipt", () => {
  const summary = taskSummaryFromEvents([
    { type: "tool.call", body_json: JSON.stringify({ name: "write_file", arguments: { path: "out/today.md" } }) },
    { type: "tool.error", body_json: JSON.stringify({ name: "write_file", arguments: { path: "out/today.md" }, result: rejected }) },
    { type: "tool.call", body_json: JSON.stringify({ name: "write_file", arguments: { path: "out/today.md" } }) },
    { type: "tool.error", body_json: JSON.stringify({ name: "write_file", arguments: { path: "out/today.md" }, result: rejected }) },
    { type: "task.completed", body_json: JSON.stringify({ steps: 4 }) },
  ]);
  assert.deepEqual(summary.files_saved, [], "no file was written, so none may be offered");
});

test("a failed navigation leaves no site on the receipt", () => {
  const summary = taskSummaryFromEvents([
    { type: "tool.call", body_json: JSON.stringify({ name: "browser_navigate", arguments: { url: "https://blocked.example/" } }) },
    { type: "tool.error", body_json: JSON.stringify({ name: "browser_navigate", arguments: { url: "https://blocked.example/" },
      result: { ok: false, error: { code: "E_POLICY", message: "navigation blocked" } } }) },
    { type: "task.completed", body_json: JSON.stringify({ steps: 1 }) },
  ]);
  assert.deepEqual(summary.sites, [], "a page that was never reached was never visited");
});

test("successful calls are still recorded, from the result and not the request", () => {
  const summary = taskSummaryFromEvents([
    { type: "tool.call", body_json: JSON.stringify({ name: "browser_navigate", arguments: { url: "https://example.com/a" } }) },
    { type: "tool.result", body_json: JSON.stringify({ name: "browser_navigate", arguments: { url: "https://example.com/a" }, result: { ok: true } }) },
    { type: "tool.result", body_json: JSON.stringify({ name: "write_file", arguments: { path: "out/wishful.md" }, result: { ok: true } }) },
    // The path and byte count come from the computer's own answer, carried on
    // the promotion event the dispatcher only emits when the write succeeded.
    { type: "download.promoted", body_json: JSON.stringify({ source: "write_file", path: "out/report.csv", bytes: 134 }) },
    { type: "usage", body_json: JSON.stringify({ steps: 3, usd_est: 0.02 }) },
    { type: "task.completed", body_json: JSON.stringify({ steps: 3 }) },
  ]);
  assert.deepEqual(summary.sites, ["example.com"]);
  assert.deepEqual(summary.files_saved, ["out/report.csv"],
    "artifacts come from the promotion the computer earned, not the path the model asked for");
});

/** A workspace with one real file at `out/today.md`, cleaned up by the caller. */
function workspaceWithFile(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "mb-receipt-"));
  mkdirSync(join(root, "out"), { recursive: true });
  writeFileSync(join(root, "out", "today.md"), "x".repeat(227));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a phantom file is swept out of an already-frozen receipt, once", () => {
  const store = new Store();
  const ws = workspaceWithFile();
  try {
    // A failed run: a rejected `write_file`, no successful result and no
    // promotion, and a receipt frozen before the fix that names a file nothing
    // ever wrote.
    const task = store.insertTask({ computer_id: "cmp_1", goal: "Save today.md", max_steps: 20 });
    const append = (type: string, body: Record<string, unknown>) =>
      store.appendAuditRef({ type, body, task_id: task.id, computer_id: "cmp_1", hash: "receipt" });
    append("tool.call", { name: "write_file", arguments: { path: "today.md", content: "x" } });
    append("tool.error", { name: "write_file", code: "E_CAPABILITY" });
    append("task.failed", { reason: "capability" });
    store.finishTask(task.id, "failed");
    store.db.prepare("UPDATE tasks SET summary_json = ? WHERE id = ?").run(
      JSON.stringify({ steps: 6, sites: [], asks: 0, files_saved: ["today.md"], cost_usd: null }),
      task.id,
    );

    const first = store.repairFrozenFileLists((_id, file) => artifactOnDisk(ws.root, file));
    assert.deepEqual(first, { applied: true, repaired: 1 });

    const summary = store.getTask(task.id)!.summary!;
    assert.deepEqual(summary.files_saved, [], "a file no result and no promotion ever mentioned");
    assert.equal(summary.repaired, true, "the row says it has been corrected");
    assert.equal(summary.steps, 6, "the counts frozen from the old projection are left alone");

    // Versioned: a second boot does not re-scan, and would change nothing.
    assert.deepEqual(store.repairFrozenFileLists(() => false), { applied: false, repaired: 0 });
    assert.equal(
      (store.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      RECEIPT_REPAIR_VERSION,
    );
  } finally {
    ws.cleanup();
    store.close();
  }
});

test("a file that really was written survives the sweep untouched", () => {
  const store = new Store();
  const ws = workspaceWithFile();
  try {
    const task = store.insertTask({ computer_id: "cmp_1", goal: "Save today.md", max_steps: 20 });
    const append = (type: string, body: Record<string, unknown>) =>
      store.appendAuditRef({ type, body, task_id: task.id, computer_id: "cmp_1", hash: "receipt" });
    append("tool.call", { name: "write_file", arguments: { path: "out/today.md", content: "x" } });
    append("tool.result", { name: "write_file", arguments: { path: "out/today.md" }, result: { ok: true } });
    append("download.promoted", { path: "out/today.md", bytes: 227 });
    append("task.completed", { reason: "done" });
    store.finishTask(task.id, "completed");
    store.freezeTaskSummary(task.id);
    assert.deepEqual(store.getTask(task.id)!.summary!.files_saved, ["out/today.md"]);

    assert.deepEqual(
      store.repairFrozenFileLists((_id, file) => artifactOnDisk(ws.root, file)),
      { applied: true, repaired: 0 },
    );
    const summary = store.getTask(task.id)!.summary!;
    assert.deepEqual(summary.files_saved, ["out/today.md"]);
    assert.equal(summary.repaired, undefined, "an untouched row is not labelled repaired");
  } finally {
    ws.cleanup();
    store.close();
  }
});

test("existence is judged in every shape a receipt records a path", () => {
  const ws = workspaceWithFile();
  try {
    assert.equal(artifactOnDisk(ws.root, "out/today.md"), true, "workspace-relative");
    assert.equal(artifactOnDisk(ws.root, "/workspace/out/today.md"), true, "container-absolute");
    assert.equal(artifactOnDisk(ws.root, "today.md"), true, "bare name, resolved under out/");
    assert.equal(artifactOnDisk(ws.root, "out/nothing.md"), false);
    assert.equal(artifactOnDisk(ws.root, "out"), false, "a directory is not a file it can open");
    assert.equal(artifactOnDisk(ws.root, "../escape.md"), false, "the jail holds");
    assert.equal(artifactOnDisk(ws.root, ""), false);
    // A workspace that is not on this machine at all means "cannot tell", and an
    // unverifiable record is kept rather than erased.
    assert.equal(artifactOnDisk(join(ws.root, "gone"), "out/today.md"), true);
  } finally {
    ws.cleanup();
  }
});

test("a takeover request is an ask, and steps match the live tool-call count", () => {
  const events = [
    { type: "usage", body_json: JSON.stringify({ steps: 0, usd_est: 0 }) },
    { type: "task.step", body_json: JSON.stringify({ status: "running" }) },
    { type: "tool.call", body_json: JSON.stringify({ name: "browser_navigate" }) },
    { type: "tool.result", body_json: JSON.stringify({
      name: "browser_navigate", arguments: { url: "https://github.com/login" }, result: { ok: true },
    }) },
    { type: "usage", body_json: JSON.stringify({ steps: 1, usd_est: 0.01 }) },
    { type: "tool.call", body_json: JSON.stringify({ name: "request_takeover" }) },
    { type: "takeover.requested", body_json: JSON.stringify({
      takeover_id: "tk_1",
      reason: "GitHub’s sign-in page is open. Please sign in directly in the browser.",
      field: { kind: "password", label: "password" },
    }) },
    { type: "usage", body_json: JSON.stringify({ steps: 2, usd_est: 0.02 }) },
    { type: "task.step", body_json: JSON.stringify({ status: "running" }) },
    { type: "task.cancelled", body_json: JSON.stringify({}) },
  ];
  const summary = taskSummaryFromEvents(events);
  assert.equal(summary.asks, 1, "request_takeover is a thing it asked you");
  assert.equal(summary.steps, 2, "two tool.call records, not three heartbeat rows");
  assert.deepEqual(summary.sites, ["github.com"]);
  assert.equal(
    taskSummaryFromEvents([
      ...events,
      { type: "takeover.requested", body_json: JSON.stringify({ reason: "ui" }) },
    ]).asks,
    1,
    "taking the keyboard yourself is not an ask",
  );
});

test("the task API drops a file that has since been deleted and says it did", () => {
  const ws = workspaceWithFile();
  try {
    const task = {
      id: "t_1",
      computer_id: "cmp_1",
      goal: "g",
      adapter: null,
      driver: null,
      capabilities: null,
      max_steps: 20,
      status: "completed",
      created_at: "2026-09-07T10:00:00.000Z",
      cancelled_at: null,
      started_at: null,
      finished_at: null,
      duration_ms: null,
      summary: {
        steps: 3,
        sites: [],
        asks: 0,
        files_saved: ["out/today.md", "out/deleted.md"],
        cost_usd: null,
      },
    };
    const checked = verifiedArtifacts(task, ws.root);
    assert.deepEqual(checked.summary!.files_saved, ["out/today.md"]);
    assert.equal(checked.summary!.repaired, true);
    // Nothing to correct means nothing is claimed: the record is returned as is.
    assert.equal(verifiedArtifacts(checked, ws.root), checked);
  } finally {
    ws.cleanup();
  }
});
