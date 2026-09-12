import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeComputer } from "../../../src/computer-client/fake.ts";
import type { ComputerCallContext } from "../../../src/computer-client/types.ts";
import type { ToolResult } from "../../../src/types/contracts.ts";
import { createToolDispatcher } from "../../../src/daemon/dispatcher.ts";
import { ExecComputerClient } from "../../../src/computer-client/exec-client.ts";
import type { JsonRpcClient } from "../../../src/sandbox/client.ts";
import { Store } from "../../../src/daemon/store.ts";
import { createApproval } from "../../../src/policy/approvals.ts";

test("empty optional gates let a form submit through without an approval", async () => {
  const store = new Store();
  const computer = new FakeComputer("autonomy");
  store.insertComputer({ id: computer.computerId, name: "research", capabilities: ["browser"], persistent: false, status: "running" });
  const task = store.insertTask({ computer_id: computer.computerId, goal: "post a form", max_steps: 20 });
  const dispatcher = createToolDispatcher({
    store, getClient: () => computer, emit: async () => {}, enabledGates: [],
  });
  const context = { taskId: task.id, computerId: computer.computerId, origin: "https://httpbin.org",
    originSets: { readable: [], writable: [] } };
  try {
    const submit = await dispatcher.dispatch("browser_type", { text: "send this", submit: true }, context);
    assert.equal(submit.ok, true);
    assert.equal(store.listApprovals().length, 0);
  } finally { await computer.close(); store.close(); }
});

test("an explicit new_domain gate still asks before a form submit", async () => {
  const store = new Store();
  const computer = new FakeComputer("gated");
  store.insertComputer({ id: computer.computerId, name: "research", capabilities: ["browser"], persistent: false, status: "running" });
  const task = store.insertTask({ computer_id: computer.computerId, goal: "post a form", max_steps: 20 });
  const dispatcher = createToolDispatcher({
    store, getClient: () => computer, emit: async () => {}, enabledGates: ["new_domain"],
  });
  const context = { taskId: task.id, computerId: computer.computerId, origin: "https://httpbin.org",
    originSets: { readable: [], writable: [] } };
  try {
    const submit = await dispatcher.dispatch("browser_type", { text: "send this", submit: true }, context);
    assert.equal(!submit.ok && submit.error.code, "E_POLICY_PENDING");
    assert.equal(store.listApprovals()[0]?.gate, "new_domain");
  } finally { await computer.close(); store.close(); }
});

test("normal browser research opens pages and tabs without granting form submissions", async () => {
  const store = new Store();
  const scopes: ComputerCallContext[] = [];
  class Browser extends FakeComputer {
    override async call(method: string, args?: unknown, context?: ComputerCallContext): Promise<ToolResult> {
      if (context) scopes.push(context);
      return super.call(method, args);
    }
  }
  const computer = new Browser("public-research");
  store.insertComputer({ id: computer.computerId, name: "research", capabilities: ["browser"], persistent: false, status: "running" });
  const task = store.insertTask({ computer_id: computer.computerId, goal: "audit a public website", max_steps: 20 });
  const dispatcher = createToolDispatcher({ store, getClient: () => computer, emit: async () => {} });
  const context = { taskId: task.id, computerId: computer.computerId, origin: "https://example.com",
    originSets: { readable: [], writable: [] } };
  try {
    assert.equal((await dispatcher.dispatch("browser_navigate", { url: "https://bothearth.com" }, context)).ok, true);
    assert.equal((await dispatcher.dispatch("browser_tabs", { action: "new", url: "https://developers.google.com" }, context)).ok, true);
    assert.equal(store.listApprovals().length, 0);
    assert.ok(scopes.every((scope) => scope.allowPublicNavigation === true));
    assert.deepEqual(store.taskGrantedOrigins(task.id), [], "reading never silently grants writes");
    const submit = await dispatcher.dispatch("browser_type", { text: "send this", submit: true }, context);
    assert.equal(!submit.ok && submit.error.code, "E_POLICY_PENDING", "submitting data remains a separate decision");
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "not a URL", "http://["]) {
      for (const tool of ["browser_navigate", "browser_tabs"] as const) {
        const unsafe = await dispatcher.dispatch(tool, { url, action: "new" }, context);
        assert.equal(!unsafe.ok && unsafe.error.code, "E_POLICY", `${tool}: ${url}`);
      }
    }
  } finally { await computer.close(); store.close(); }
});

test("an old navigation approval cannot reintroduce a public-read prompt after an upgrade", async () => {
  const store = new Store();
  const computer = new FakeComputer("legacy-navigation");
  store.insertComputer({ id: computer.computerId, name: "legacy", capabilities: ["browser"], persistent: false, status: "running" });
  const task = store.insertTask({ computer_id: computer.computerId, goal: "continue reading", max_steps: 5 });
  const args = { url: "https://example.com/article" };
  const approval = createApproval({ task_id: task.id, tool: "browser_navigate", gate: "new_domain",
    args: { action: args, navigation_url: args.url }, origin: "https://example.com", control_epoch: 0 });
  store.insertApproval({ id: approval.approval_id, task_id: task.id, tool: approval.tool, gate: "new_domain",
    args: approval.args, bind: { ...approval.bind, navigation_url: args.url } });
  const dispatcher = createToolDispatcher({ store, getClient: () => computer, emit: async () => {} });
  try {
    assert.equal((await dispatcher.dispatch("browser_navigate", args, { taskId: task.id, computerId: computer.computerId,
      origin: "about:blank", originSets: { readable: [], writable: [] } })).ok, true);
    assert.equal(store.listApprovals().length, 1, "the historical record is retained without another prompt");
    assert.deepEqual(store.taskGrantedOrigins(task.id), [], "an obsolete read approval grants no writes");
  } finally { await computer.close(); store.close(); }
});

for (const mode of ["supervised", "strict"] as const) test(`${mode} cross-origin form POST uses host scope and cannot contact a new origin before consent`, async () => {
  const store = new Store();
  let contacts = 0;
  let current = "https://source.example";
  class GuardedComputer extends FakeComputer {
    override async call(method: string, args?: unknown, context?: ComputerCallContext): Promise<ToolResult> {
      if (method === "browser_snapshot") return { ok: true, data: { url: current, yaml: "- button Submit [ref=e1]" } };
      if (method === "browser_click") {
        assert.ok(context);
        assert.equal(context.allowPublicNavigation, mode !== "strict");
        // A POST never inherits the public GET permission. Its destination
        // must still be present in the host's origin scope.
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
  const args = { ref: "e1", snapshot_id: "s1", navigation_origins: ["https://destination.example"], allow_public_navigation: true };
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
  const args = { url: "https://destination.example", navigation_origins: ["destination.example"], allow_public_navigation: true };
  await client.call("browser_navigate", args, { navigationOrigins: ["source.example"] });
  assert.deepEqual(calls, [{ method: "policy.call", params: {
    method: "browser_navigate", params: args, navigation_origins: ["source.example"],
  } }]);
  await client.call("browser_navigate", args, { navigationOrigins: [], allowPublicNavigation: true });
  assert.deepEqual(calls[1], { method: "policy.call", params: {
    method: "browser_navigate", params: args, navigation_origins: [], allow_public_navigation: true,
  } });
  await client.close();
});


test("extra model navigation_url arguments cannot override strict destinations", async () => {
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
  const context = { taskId: task.id, computerId: computer.computerId, origin: "https://source.example", mode: "strict" as const,
    originSets: { readable: ["https://source.example"], writable: ["https://source.example", "https://approved.example"] } };
  const args = { url: "https://approved.example", navigation_url: "https://unapproved.example" };
  try {
    assert.equal((await dispatcher.dispatch("browser_navigate", args, context)).ok, true);
    assert.equal(store.listApprovals().length, 0);
    assert.ok(scope.includes("https://approved.example"));
    assert.ok(!scope.includes("https://unapproved.example"));
    assert.equal((await dispatcher.dispatch("browser_navigate", { url: "https://unapproved.example" }, context)).ok, false);
    assert.equal((await dispatcher.dispatch("browser_tabs", { action: "new", url: "https://unapproved.example" }, context)).ok, false);
    assert.equal(store.listApprovals().length, 0, "strict mode refuses undeclared destinations without offering a grant");
  } finally { await computer.close(); store.close(); }
});
