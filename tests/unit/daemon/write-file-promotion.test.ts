/**
 * The daemon half of `write_file`.
 *
 * Two properties a real failure turned on: a browser-only
 * computer — what the home-screen task box provisions — must actually be able to
 * save a file, and the saved file must reach the results view. The second is the
 * `download.promoted` event; the results view keys "Files it has saved" and its
 * "Open" link off the workspace-relative path it carries.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeComputer } from "../../../src/computer-client/fake.ts";
import type { ToolResult } from "../../../src/types/contracts.ts";
import { createToolDispatcher } from "../../../src/daemon/dispatcher.ts";
import { Store } from "../../../src/daemon/store.ts";
import { evaluateGate } from "../../../src/policy/gate.ts";

class WritingComputer extends FakeComputer {
  readonly calls: string[] = [];
  override async call(method: string, args?: unknown): Promise<ToolResult> {
    this.calls.push(method);
    if (method === "write_file") {
      const p = args as { path: string; content: string };
      return {
        ok: true,
        data: { path: `out/${p.path}`, bytes: p.content.length, sha256: "a".repeat(64) },
      };
    }
    return super.call(method, args);
  }
}

for (const mode of ["supervised", "strict"] as const) {
  test(`${mode}: a browser-only computer saves a file with no approval and announces it`, async () => {
    const store = new Store();
    const computer = new WritingComputer("writer");
    const events: Array<{ type: string; body: Record<string, unknown> }> = [];
    store.insertComputer({
      id: computer.computerId,
      name: "writer",
      // No "shell": exactly the computer the home screen creates, and the reason
      // the shell-gated files_write family could not serve this at all.
      capabilities: ["browser"],
      persistent: true,
      status: "running",
    });
    const task = store.insertTask({ computer_id: computer.computerId, goal: "save invoices", max_steps: 5 });
    const dispatcher = createToolDispatcher({
      store,
      getClient: () => computer,
      emit: async (type, body) => void events.push({ type, body }),
    });
    try {
      const result = await dispatcher.dispatch(
        "write_file",
        { path: "invoices.csv", content: "a,b\n1,2\n", encoding: null, mode: null },
        { computerId: computer.computerId, taskId: task.id, mode },
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(store.listApprovals().length, 0, "a local save must not prompt the human");
      assert.ok(computer.calls.includes("write_file"), "the capability filter must not block write_file");

      const promoted = events.filter((e) => e.type === "download.promoted");
      assert.equal(promoted.length, 1);
      // Workspace-relative: GET /api/v1/computers/:id/files?path= resolves it
      // against the host workspace root, so an absolute path would 403.
      assert.equal(promoted[0]!.body.path, "out/invoices.csv");
      assert.equal(promoted[0]!.body.approved_by, "policy");
      assert.equal(promoted[0]!.body.source, "write_file");
      assert.equal(promoted[0]!.body.computer_id, computer.computerId);

      // shell_exec on the same computer is still refused: the new tool widened
      // nothing beyond saving a file.
      const shell = await dispatcher.dispatch(
        "shell_exec",
        { command: "id" },
        { computerId: computer.computerId, taskId: task.id, mode },
      );
      assert.equal(shell.ok, false);
      assert.equal(!shell.ok && shell.error.code, "E_CAPABILITY");
    } finally {
      await computer.close();
      store.close();
    }
  });
}

test("a failed write announces nothing", async () => {
  const store = new Store();
  class RefusingComputer extends FakeComputer {
    override async call(method: string, args?: unknown): Promise<ToolResult> {
      if (method === "write_file") {
        return { ok: false, error: { code: "E_POLICY", message: "path must not contain '..'" } };
      }
      return super.call(method, args);
    }
  }
  const computer = new RefusingComputer("refuser");
  const events: string[] = [];
  store.insertComputer({ id: computer.computerId, name: "refuser", capabilities: ["browser"], persistent: true, status: "running" });
  const task = store.insertTask({ computer_id: computer.computerId, goal: "save", max_steps: 5 });
  const dispatcher = createToolDispatcher({
    store,
    getClient: () => computer,
    emit: async (type) => void events.push(type),
  });
  try {
    const result = await dispatcher.dispatch(
      "write_file",
      { path: "../escape.csv", content: "x", encoding: null, mode: null },
      { computerId: computer.computerId, taskId: task.id, mode: "supervised" },
    );
    assert.equal(result.ok, false);
    assert.equal(events.includes("download.promoted"), false);
  } finally {
    await computer.close();
    store.close();
  }
});

test("the gate allows write_file in every mode and on a force-human origin", () => {
  const base = {
    signals: {},
    origin_sets: { readable: [], writable: [] },
  };
  for (const mode of ["supervised", "strict"] as const) {
    for (const origin of ["https://example.com", "https://www.chase.com"]) {
      assert.deepEqual(
        evaluateGate({ ...base, call: { tool: "write_file", args: { path: "a.csv" } }, origin, mode }),
        { decision: "allow" },
        `${mode} ${origin}`,
      );
    }
  }
  // The kill switch still stops it, like every other tool.
  assert.equal(
    evaluateGate({
      ...base,
      call: { tool: "write_file", args: { path: "a.csv" } },
      origin: "https://example.com",
      mode: "supervised",
      kill_switch: true,
    }).decision,
    "deny",
  );
});
