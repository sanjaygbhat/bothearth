import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeComputer } from "../../../src/computer-client/fake.ts";
import type { ComputerCallContext } from "../../../src/computer-client/types.ts";
import type { ToolName, ToolResult } from "../../../src/types/contracts.ts";
import { createToolDispatcher } from "../../../src/daemon/dispatcher.ts";
import { Store } from "../../../src/daemon/store.ts";

const DEST = "https://httpbin.org/post";
const DEST_ORIGIN = "https://httpbin.org";
const PAGE = "https://form.example/compose";

class Page extends FakeComputer {
  url = PAGE;
  yaml = '- link "Send" [ref=e1]';
  snapshotId = "s1";
  clicks = 0;
  failNext: string | null = null;

  override async call(
    method: string,
    args?: unknown,
    context?: ComputerCallContext,
  ): Promise<ToolResult> {
    if (method === "browser_snapshot") {
      return {
        ok: true,
        data: { url: this.url, yaml: this.yaml, snapshot_id: this.snapshotId, title: "Compose" },
      };
    }
    if (method === "browser_click") {
      if (this.failNext) {
        const code = this.failNext;
        this.failNext = null;
        return { ok: false, error: { code: code as "E_STALE_REF", message: code } };
      }
      if (!(context?.navigationOrigins ?? []).includes(DEST_ORIGIN)) {
        return {
          ok: false,
          error: {
            code: "E_POLICY",
            message: "blocked before contact",
            details: { navigation_url: DEST },
          },
        };
      }
      this.clicks += 1;
      this.url = DEST;
      return { ok: true, data: { url: DEST } };
    }
    if (method === "browser_type" && (args as { submit?: boolean }).submit) {
      const origin = new URL(this.url).origin;
      if (!(context?.navigationOrigins ?? []).includes(origin)) {
        return {
          ok: false,
          error: {
            code: "E_POLICY",
            message: "blocked before contact",
            details: { navigation_url: this.url },
          },
        };
      }
      return { ok: true, data: { url: this.url } };
    }
    if (method === "browser_navigate") {
      const url = String((args as { url?: string }).url);
      this.url = url;
      return { ok: true, data: { url, title: "T", snapshot_id: this.snapshotId } };
    }
    return super.call(method, args);
  }
}

function harness() {
  const store = new Store();
  const page = new Page("id");
  store.insertComputer({
    id: "id",
    name: "n",
    capabilities: ["browser"],
    persistent: true,
    status: "running",
  });
  const task = store.insertTask({ computer_id: "id", goal: "send the form", max_steps: 20 });
  const requested: Array<Record<string, unknown>> = [];
  const dispatcher = createToolDispatcher({
    store,
    getClient: () => page,
    emit: async (type, body) => {
      if (type === "approval.requested") requested.push(body);
    },
  });
  const context = {
    computerId: "id",
    taskId: task.id,
    mode: "supervised" as const,
    controlEpoch: 0,
    originSets: { readable: ["https://form.example"], writable: ["https://form.example"] },
  };
  const dispatch = (tool: ToolName, args: Record<string, unknown>) =>
    dispatcher.dispatch(tool, args, context);
  const click = (snapshot_id: string, ref: string) =>
    dispatch("browser_click", { snapshot_id, ref, button: "left", double_click: false });
  const approve = (decision: "allow_once" | "allow_task" = "allow_once") => {
    const pending = store.listApprovals("pending");
    assert.ok(pending.length > 0, "expected a pending approval");
    for (const row of pending) store.setApprovalStatusIf(row.id, "pending", "approved", decision);
  };
  return {
    store,
    page,
    requested,
    taskId: task.id,
    context,
    dispatch,
    click,
    approve,
    async close() {
      await page.close();
      store.close();
    },
  };
}

test("the same click after a re-snapshot is covered by one allow-once grant", async () => {
  const h = harness();
  try {
    const first = await h.click("s1", "e1");
    assert.equal(!first.ok && first.error.code, "E_POLICY_PENDING");
    h.approve("allow_once");
    h.page.yaml = '- generic [ref=e1]\n- link "Send" [ref=e2]';
    h.page.snapshotId = "s2";
    const retry = await h.click("s2", "e2");
    assert.equal(retry.ok, true, `retry failed: ${JSON.stringify(retry)}`);
    assert.equal(h.page.clicks, 1);
    assert.equal(h.requested.length, 1);
    const rows = h.store.listApprovals().filter((a) => a.task_id === h.taskId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "consumed");
    assert.deepEqual(h.store.taskGrantedOrigins(h.taskId), []);
  } finally {
    await h.close();
  }
});

test("a click whose resolved target changed after a refresh is not covered", async () => {
  const h = harness();
  try {
    const first = await h.click("s1", "e1");
    assert.equal(!first.ok && first.error.code, "E_POLICY_PENDING");
    h.approve("allow_once");
    const firstId = h.store.listApprovals()[0]!.id;
    h.page.yaml = '- link "Cancel" [ref=e1]';
    h.page.snapshotId = "s2";
    const retry = await h.click("s2", "e1");
    assert.equal(!retry.ok && retry.error.code, "E_POLICY_PENDING");
    assert.equal(h.page.clicks, 0);
    assert.equal(h.requested.length, 2);
    assert.equal(h.store.getApproval(firstId)?.status, "approved");
    const pending = h.store.listApprovals("pending");
    assert.equal(pending.length, 1);
    assert.notEqual(pending[0]!.id, firstId);
  } finally {
    await h.close();
  }
});

test("a failed dispatch does not spend the allow-once grant", async () => {
  const h = harness();
  try {
    const first = await h.click("s1", "e1");
    assert.equal(!first.ok && first.error.code, "E_POLICY_PENDING");
    h.approve("allow_once");
    h.page.failNext = "E_STALE_REF";
    h.page.yaml = '- link "Send" [ref=e3]';
    h.page.snapshotId = "s2";
    const stale = await h.click("s2", "e3");
    assert.equal(!stale.ok && stale.error.code, "E_STALE_REF");
    assert.equal(h.page.clicks, 0);
    const rows = h.store.listApprovals().filter((a) => a.task_id === h.taskId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "approved");
    h.page.snapshotId = "s3";
    const retry = await h.click("s3", "e3");
    assert.equal(retry.ok, true, `retry after stale failed: ${JSON.stringify(retry)}`);
    assert.equal(h.page.clicks, 1);
    assert.equal(h.requested.length, 1);
    assert.equal(h.store.getApproval(rows[0]!.id)?.status, "consumed");
  } finally {
    await h.close();
  }
});

test("allow this site for the task still scopes by origin", async () => {
  const h = harness();
  try {
    const first = await h.click("s1", "e1");
    assert.equal(!first.ok && first.error.code, "E_POLICY_PENDING");
    h.approve("allow_task");
    h.page.yaml = '- link "Send" [ref=e2]';
    h.page.snapshotId = "s2";
    assert.equal((await h.click("s2", "e2")).ok, true);
    assert.ok(h.store.taskGrantedOrigins(h.taskId).includes(DEST_ORIGIN));
    h.page.yaml = '- button "Again" [ref=e1]';
    const again = await h.dispatch("browser_type", { text: "again", submit: true });
    assert.equal(again.ok, true, "a later submit on the granted origin must not re-ask");
    assert.equal(h.requested.length, 1);
    assert.equal(
      (await h.dispatch("browser_navigate", { url: "https://other.example/" })).ok,
      true,
    );
    h.page.url = "https://other.example/";
    const other = await h.dispatch("browser_type", { text: "nope", submit: true });
    assert.equal(!other.ok && other.error.code, "E_POLICY_PENDING");
    assert.equal(h.requested.length, 2);
    assert.ok(!h.store.taskGrantedOrigins(h.taskId).includes("https://other.example"));
  } finally {
    await h.close();
  }
});

test("allow-once for a form dest is not reused after the action host is swapped", async () => {
  const store = new Store();
  const page = new Page("id");
  page.yaml = '- button "Submit" [ref=e1]';
  store.insertComputer({
    id: "id", name: "n", capabilities: ["browser"], persistent: true, status: "running",
  });
  const task = store.insertTask({ computer_id: "id", goal: "send the form", max_steps: 20 });
  const seen: string[][] = [];
  const requested: string[] = [];
  const dispatcher = createToolDispatcher({
    store,
    getClient: () => page,
    emit: async (type, body) => {
      if (type === "approval.requested") requested.push(String(body.reason ?? ""));
    },
    execute: async (client, tool, args, callContext) => {
      seen.push([...(callContext?.navigationOrigins ?? [])]);
      return client.call(tool, args, callContext);
    },
  });
  const click = (dest: string) => dispatcher.dispatch(
    "browser_click",
    { snapshot_id: "s1", ref: "e1", button: "left", double_click: false },
    {
      computerId: "id",
      taskId: task.id,
      mode: "supervised",
      origin: PAGE,
      originSets: { readable: ["https://form.example"], writable: ["https://form.example"] },
      signals: { form_submit_origin: dest },
    },
  );
  try {
    const first = await click(DEST_ORIGIN);
    assert.equal(!first.ok && first.error.code, "E_POLICY_PENDING");
    const firstId = store.listApprovals("pending")[0]!.id;
    store.setApprovalStatusIf(firstId, "pending", "approved", "allow_once");
    const swapped = await click("https://evil.example");
    assert.equal(!swapped.ok && swapped.error.code, "E_POLICY_PENDING");
    assert.equal(store.getApproval(firstId)?.status, "approved");
    const pending = store.listApprovals("pending");
    assert.equal(pending.length, 1);
    assert.notEqual(pending[0]!.id, firstId);
    assert.equal(requested.length, 2);
    assert.equal(page.clicks, 0);
    assert.ok(seen.every((origins) => !origins.includes("https://evil.example")));
    assert.ok(!store.taskGrantedOrigins(task.id).includes("https://evil.example"));
  } finally {
    await page.close();
    store.close();
  }
});

test("an allow-once granted before a takeover is not reused after the epoch changes", async () => {
  const h = harness();
  try {
    const first = await h.click("s1", "e1");
    assert.equal(!first.ok && first.error.code, "E_POLICY_PENDING");
    h.approve("allow_once");
    const firstId = h.store.listApprovals()[0]!.id;
    h.context.controlEpoch = 1;
    const retry = await h.click("s1", "e1");
    assert.equal(!retry.ok && retry.error.code, "E_POLICY_PENDING");
    assert.notEqual(!retry.ok && retry.error.message, "approval binding mismatch");
    assert.equal(h.store.getApproval(firstId)?.status, "approved");
    const pending = h.store.listApprovals("pending");
    assert.equal(pending.length, 1);
    assert.notEqual(pending[0]!.id, firstId);
    assert.equal(h.page.clicks, 0);
    assert.equal(h.requested.length, 2);
  } finally {
    await h.close();
  }
});

test("a throw before the computer runs does not spend allow-once", async () => {
  const store = new Store();
  const page = new Page("id");
  page.yaml = '- button "Submit" [ref=e1]';
  store.insertComputer({
    id: "id", name: "n", capabilities: ["browser"], persistent: true, status: "running",
  });
  const task = store.insertTask({ computer_id: "id", goal: "send the form", max_steps: 20 });
  let boom = false;
  const dispatcher = createToolDispatcher({
    store,
    getClient: () => page,
    emit: async () => {},
    execute: async (client, tool, args, callContext) => {
      if (boom) throw new Error("computer never ran");
      return client.call(tool, args, callContext);
    },
  });
  const context = {
    computerId: "id",
    taskId: task.id,
    mode: "supervised" as const,
    origin: PAGE,
    originSets: { readable: ["https://form.example"], writable: ["https://form.example"] },
    signals: { form_submit_origin: DEST_ORIGIN },
  };
  const click = () => dispatcher.dispatch(
    "browser_click",
    { snapshot_id: "s1", ref: "e1", button: "left", double_click: false },
    context,
  );
  try {
    const first = await click();
    assert.equal(!first.ok && first.error.code, "E_POLICY_PENDING");
    store.setApprovalStatusIf(store.listApprovals("pending")[0]!.id, "pending", "approved", "allow_once");
    const id = store.listApprovals()[0]!.id;
    boom = true;
    await assert.rejects(() => click(), /computer never ran/);
    assert.equal(store.getApproval(id)?.status, "approved");
    assert.equal(page.clicks, 0);
    boom = false;
    const retry = await click();
    assert.equal(retry.ok, true, `retry after throw failed: ${JSON.stringify(retry)}`);
    assert.equal(page.clicks, 1);
    assert.equal(store.getApproval(id)?.status, "consumed");
  } finally {
    await page.close();
    store.close();
  }
});
