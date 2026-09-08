/**
 * The daemon offered the model `write_file` against a computer that
 * answered `E_CAPABILITY: unknown method: write_file`, twice, and then told the
 * owner the file was saved. Two properties keep that from recurring: a refusal
 * is reported in words rather than as a protocol string, and a tool the
 * computer has proved it cannot run is never offered to that computer again.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeComputer } from "../../../src/computer-client/fake.ts";
import type { ToolResult } from "../../../src/types/contracts.ts";
import { createToolDispatcher } from "../../../src/daemon/dispatcher.ts";
import { Store } from "../../../src/daemon/store.ts";

/** A computer built before `write_file` shipped. */
class OldComputer extends FakeComputer {
  readonly calls: string[] = [];
  override async call(method: string, args?: unknown): Promise<ToolResult> {
    this.calls.push(method);
    if (method === "write_file") {
      return { ok: false, error: { code: "E_CAPABILITY", message: "unknown method: write_file" } };
    }
    return super.call(method, args);
  }
}

function harness() {
  const store = new Store();
  const computer = new OldComputer("old-image");
  const events: Array<{ type: string; body: Record<string, unknown> }> = [];
  const unsupported: Array<[string, string]> = [];
  store.insertComputer({
    id: computer.computerId, name: "old", capabilities: ["browser"], persistent: true, status: "running",
  });
  const task = store.insertTask({ computer_id: computer.computerId, goal: "save a note", max_steps: 5 });
  const dispatcher = createToolDispatcher({
    store,
    getClient: () => computer,
    emit: async (type, body) => void events.push({ type, body }),
    onUnsupportedTool: (id, tool) => void unsupported.push([id, tool]),
  });
  return { store, computer, events, unsupported, task, dispatcher };
}

test("a tool the computer does not have is refused in words, and reported once", async () => {
  const h = harness();
  try {
    const result = await h.dispatcher.dispatch(
      "write_file",
      { path: "today.md", content: "hello", encoding: null, mode: null },
      { computerId: h.computer.computerId, taskId: h.task.id, mode: "supervised" },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "E_CAPABILITY");
    assert.doesNotMatch(result.error.message, /unknown method/i, "a protocol string is not an explanation");
    assert.match(result.error.message, /save files/i);
    assert.match(result.error.message, /needs an update/i);
    assert.match(result.error.message, /not try this again/i, "the model is told retrying cannot help");

    // The daemon is told which computer lost which tool, so it stops offering it.
    assert.deepEqual(h.unsupported, [[h.computer.computerId, "write_file"]]);

    const errors = h.events.filter((e) => e.type === "tool.error");
    assert.equal(errors.length, 1, "one feed line, not a retry storm");
    assert.doesNotMatch(JSON.stringify(errors[0]!.body), /unknown method/i);
  } finally {
    h.store.close();
  }
});

test("a refusal never produces a promotion, so the receipt stays empty", async () => {
  const h = harness();
  try {
    await h.dispatcher.dispatch(
      "write_file",
      { path: "today.md", content: "hello", encoding: null, mode: null },
      { computerId: h.computer.computerId, taskId: h.task.id, mode: "supervised" },
    );
    assert.equal(h.events.filter((e) => e.type === "download.promoted").length, 0,
      "nothing was written, so nothing may be announced as saved");
    const summary = (await import("../../../src/daemon/store.ts")).taskSummaryFromEvents(
      h.events.map((e) => ({ type: e.type, body_json: JSON.stringify(e.body) })),
    );
    assert.deepEqual(summary.files_saved, []);
  } finally {
    h.store.close();
  }
});

test("an ordinary failure is left alone — only 'unknown method' is rewritten", async () => {
  const h = harness();
  try {
    const result = await h.dispatcher.dispatch(
      "shell_exec",
      { command: "ls", cwd: null, timeout_ms: null },
      { computerId: h.computer.computerId, taskId: h.task.id, mode: "supervised" },
    );
    assert.equal(result.ok, false);
    // Browser-only computer: refused by the daemon's capability gate, which is a
    // different fact from "this computer is out of date".
    assert.deepEqual(h.unsupported, [], "a capability gate is not an out-of-date computer");
  } finally {
    h.store.close();
  }
});
