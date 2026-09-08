import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeComputer } from "../../../src/computer-client/fake.ts";
import type { ComputerCallContext } from "../../../src/computer-client/types.ts";
import type { ToolResult } from "../../../src/types/contracts.ts";
import { createToolDispatcher } from "../../../src/daemon/dispatcher.ts";
import { ExecComputerClient } from "../../../src/computer-client/exec-client.ts";
import type { JsonRpcClient } from "../../../src/sandbox/client.ts";
import { Store } from "../../../src/daemon/store.ts";

for (const mode of ["supervised", "strict"] as const) test(`${mode} document navigation uses host scope and cannot contact a new origin before consent`, async () => {
  const store = new Store();
  let contacts = 0;
  let current = "https://source.example";
  class GuardedComputer extends FakeComputer {
    override async call(method: string, args?: unknown, context?: ComputerCallContext): Promise<ToolResult> {
      if (method === "browser_snapshot") return { ok: true, data: { url: current, yaml: "- link Destination [ref=e1]" } };
      if (method === "browser_click") {
        assert.ok(context);
        if (!context.navigationOrigins.includes("https://destination.example")) {
          // A failed navigation can leave an error page at the requested URL.
          current = "https://destination.example";
          return { ok: false, error: { code: "E_POLICY", message: "blocked before contact",
            details: { navigation_url: "https://destination.example/profile" } } };
        }
        contacts++;
        return { ok: true, data: { url: current } };
      }
      return super.call(method, args);
    }
  }
  const computer = new GuardedComputer("nav-policy");
  store.insertComputer({ id: computer.computerId, name: "nav", capabilities: ["browser"], persistent: true, status: "running" });
  const task = store.insertTask({ computer_id: computer.computerId, goal: "read", max_steps: 5 });
  const dispatcher = createToolDispatcher({ store, getClient: () => computer, emit: async () => {} });
  const context = { computerId: computer.computerId, taskId: task.id, mode,
    originSets: { readable: ["https://source.example"], writable: ["https://source.example"] } };
  // Agent arguments cannot replace the trusted third-argument policy context.
  const args = { ref: "e1", snapshot_id: "s1", navigation_origins: ["https://destination.example"] };
  try {
    const blocked = await dispatcher.dispatch("browser_click", args, context);
    assert.equal(blocked.ok, false);
    assert.equal(contacts, 0);
    if (mode === "strict") {
      assert.equal(store.listApprovals().length, 0);
      return;
    }
    assert.equal(!blocked.ok && blocked.error.code, "E_POLICY_PENDING");
    const approval = store.listApprovals("pending")[0]!;
    assert.equal(JSON.parse(approval.args_json).navigation_url, "https://destination.example/profile");
    assert.equal(JSON.parse(approval.bind_json).origin, "https://destination.example");
    store.setApprovalStatusIf(approval.id, "pending", "approved", "allow_once");
    assert.equal((await dispatcher.dispatch("browser_click", args, context)).ok, true);
    assert.equal(contacts, 1);
    assert.equal(store.getApproval(approval.id)?.status, "consumed");
    current = "https://source.example";
    const otherTask = store.insertTask({ computer_id: computer.computerId, goal: "separate", max_steps: 5 });
    assert.equal((await dispatcher.dispatch("browser_click", args, { ...context, taskId: otherTask.id })).ok, false);
    assert.equal(contacts, 1, "another task cannot reuse the approved origin");
  } finally { await computer.close(); store.close(); }
});


test("exec transport keeps host navigation scope outside model arguments", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  class RecordingClient extends ExecComputerClient {
    protected override async rpc(): Promise<JsonRpcClient> {
      return { child: null, request: async (method, params) => {
        calls.push({ method, params }); return { ok: true, data: {} };
      }, notify: async () => {}, close: async () => {} };
    }
  }
  const client = new RecordingClient("trusted-envelope");
  const args = { url: "https://destination.example", navigation_origins: ["destination.example"] };
  await client.call("browser_navigate", args, { navigationOrigins: ["source.example"] });
  assert.deepEqual(calls, [{ method: "policy.call", params: {
    method: "browser_navigate", params: args, navigation_origins: ["source.example"],
  } }]);
  await client.close();
});


test("extra model navigation_url arguments cannot grant a different destination", async () => {
  const store = new Store();
  let scope: string[] = [];
  class RecordingComputer extends FakeComputer {
    override async call(method: string, args?: unknown, context?: ComputerCallContext): Promise<ToolResult> {
      if (context) scope = context.navigationOrigins;
      return super.call(method, args);
    }
  }
  const computer = new RecordingComputer("forged-navigation-url");
  store.insertComputer({ id: computer.computerId, name: "forged", capabilities: ["browser"], persistent: false, status: "running" });
  const task = store.insertTask({ computer_id: computer.computerId, goal: "navigate", max_steps: 3 });
  const dispatcher = createToolDispatcher({ store, getClient: () => computer, emit: async () => {} });
  const context = { taskId: task.id, computerId: computer.computerId, origin: "https://source.example",
    originSets: { readable: ["https://source.example"], writable: [] } };
  const args = { url: "https://approved.example", navigation_url: "https://unapproved.example" };
  try {
    assert.equal((await dispatcher.dispatch("browser_navigate", args, context)).ok, false);
    const approval = store.listApprovals("pending")[0]!;
    store.setApprovalStatusIf(approval.id, "pending", "approved", "allow_once");
    assert.equal((await dispatcher.dispatch("browser_navigate", args, context)).ok, true);
    assert.ok(scope.includes("https://approved.example"));
    assert.ok(!scope.includes("https://unapproved.example"));
    assert.equal((await dispatcher.dispatch("browser_navigate", { url: "https://unapproved.example" }, context)).ok, false);
  } finally { await computer.close(); store.close(); }
});
