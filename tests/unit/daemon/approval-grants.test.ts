import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeComputer } from "../../../src/computer-client/fake.ts";
import type { ComputerCallContext } from "../../../src/computer-client/types.ts";
import type { ToolName, ToolResult } from "../../../src/types/contracts.ts";
import { createToolDispatcher } from "../../../src/daemon/dispatcher.ts";
import { MAX_TASK_ORIGIN_GRANTS, Store } from "../../../src/daemon/store.ts";
import { grantedOriginsFor } from "../../../src/policy/index.ts";

/**
 * Public browsing needs no consent. A form submission still needs an exact
 * approval; consuming that approval must preserve an explicitly remembered
 * task grant, without turning "allow once" into permission for later writes.
 * The real policy engine and dispatcher are in the loop.
 */

/** Public GETs are free; POSTs still require a host-supplied origin grant. */
class Browser extends FakeComputer {
  url = "about:blank";
  navigations = 0;
  submissions = 0;
  redirect: Record<string, string>;

  constructor(id: string, redirect: Record<string, string> = {}) {
    super(id);
    this.redirect = redirect;
  }

  override async call(method: string, args?: unknown, context?: ComputerCallContext): Promise<ToolResult> {
    if (method === "browser_snapshot") {
      return { ok: true, data: { url: this.url, yaml: "-", snapshot_id: "s1" } };
    }
    if (method === "browser_navigate") {
      const requested = String((args as { url?: string }).url);
      const landed = this.redirect[requested] ?? requested;
      if (!context?.allowPublicNavigation && !(context?.navigationOrigins ?? []).includes(new URL(landed).origin)) {
        // Blocked before contact — the browser is left where it was.
        return { ok: false, error: { code: "E_POLICY", message: "blocked before contact",
          details: { navigation_url: landed } } };
      }
      this.navigations += 1;
      this.url = landed;
      return { ok: true, data: { url: landed, title: "T", snapshot_id: "s2" } };
    }
    if (method === "browser_type" && (args as { submit?: boolean }).submit) {
      assert.ok(context?.navigationOrigins.includes(new URL(this.url).origin),
        "a submission must carry the approved origin to the browser");
      this.submissions += 1;
      return { ok: true, data: { url: this.url } };
    }
    return super.call(method, args);
  }
}

interface Harness {
  store: Store;
  browser: Browser;
  taskId: string;
  requested: Array<Record<string, unknown>>;
  navigate(url: string): Promise<number>;
  /** Drive one submission to completion, approving every ask. Returns the ask count. */
  submit(text: string, decide?: "allow_once" | "allow_task"): Promise<number>;
  close(): Promise<void>;
}

function harness(redirect: Record<string, string> = {}): Harness {
  const store = new Store();
  const browser = new Browser("churn", redirect);
  store.insertComputer({ id: "churn", name: "n", capabilities: ["browser"], persistent: true, status: "running" });
  const task = store.insertTask({ computer_id: "churn", goal: "open a page", max_steps: 10 });
  const requested: Array<Record<string, unknown>> = [];
  const dispatcher = createToolDispatcher({
    store,
    getClient: () => browser,
    emit: async (type, body) => { if (type === "approval.requested") requested.push(body); },
  });
  const context = { computerId: "churn", taskId: task.id, mode: "supervised" as const,
    originSets: { readable: [], writable: [] } };

  const run = async (tool: ToolName, args: Record<string, unknown>, decide: "allow_once" | "allow_task" = "allow_once") => {
    let asks = 0;
    // The agent loop retries the same call after an approval resolves; more
    // than a handful of rounds here IS the churn this test exists to catch.
    for (let round = 0; round < 6; round += 1) {
      const result = await dispatcher.dispatch(tool, args, context);
      if (result.ok) return asks;
      assert.equal(result.error.code, "E_POLICY_PENDING",
        `unexpected failure: ${result.error.code} ${result.error.message}`);
      asks += 1;
      for (const pending of store.listApprovals("pending")) {
        store.setApprovalStatusIf(pending.id, "pending", "approved", decide);
      }
    }
    assert.fail("the approved call never completed");
  };
  return {
    store, browser, taskId: task.id, requested,
    navigate: (url) => run("browser_navigate", { url }),
    submit: (text, decide) => run("browser_type", { text, submit: true }, decide),
    async close() { await browser.close(); store.close(); },
  };
}

test("public navigation asks nothing; a submission consumes exactly one approval", async () => {
  const h = harness();
  try {
    assert.equal(await h.navigate("https://example.com"), 0);
    assert.equal(h.requested.length, 0);
    assert.deepEqual(h.store.taskGrantedOrigins(h.taskId), []);
    assert.equal(await h.submit("first submission"), 1, "one submission, one approval");
    assert.equal(h.requested.length, 1, "one approval.requested event");
    assert.equal(h.browser.navigations, 1);
    assert.equal(h.browser.url, "https://example.com");
    assert.equal(h.browser.submissions, 1);
    // The approval the operator answered is the one that let the tool through.
    const approvals = h.store.listApprovals().filter((a) => a.task_id === h.taskId);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]!.status, "consumed");
  } finally { await h.close(); }
});

test("public redirects from apex to www need no approval or write grant", async () => {
  const h = harness({ "https://wikipedia.org/": "https://www.wikipedia.org/" });
  try {
    const asks = await h.navigate("https://wikipedia.org/");
    assert.equal(asks, 0);
    assert.equal(h.browser.url, "https://www.wikipedia.org/");
    assert.equal(h.store.listApprovals().length, 0);
    assert.deepEqual(h.store.taskGrantedOrigins(h.taskId), []);
  } finally { await h.close(); }
});

test("an approval remembered for the task never resolves without leaving a grant behind", async () => {
  const h = harness();
  try {
    await h.navigate("https://example.com");
    await h.submit("first submission", "allow_task");
    const granted = h.store.taskGrantedOrigins(h.taskId);
    assert.ok(granted.includes("https://example.com"), `granted origins: ${granted.join(", ")}`);
    // Spending the approval is what used to destroy the grant. Going back to the
    // same site inside the same task must not ask a second time.
    await h.navigate("https://example.com/page-two");
    const again = await h.submit("another submission", "allow_task");
    assert.equal(again, 0, "a granted site is not re-gated inside the same task");
    assert.equal(h.requested.length, 1);
  } finally { await h.close(); }
});

test("allow once buys the one call and is never written down", async () => {
  const h = harness();
  try {
    // The card says "just this once". It used to record a task-lifetime write
    // grant on the origin, so every later submit and keystroke there went
    // through unasked on the strength of a question answered about one action.
    assert.equal(await h.navigate("https://example.com"), 0);
    assert.equal(await h.submit("first submission"), 1);
    assert.deepEqual(h.store.taskGrantedOrigins(h.taskId), [],
      "allow_once recorded a grant the operator never gave");
    assert.equal(await h.navigate("https://example.com/page-two"), 0);
    assert.equal(await h.submit("another submission"), 1,
      "the site was trusted for the rest of the task");
    assert.equal(h.requested.length, 2);
  } finally { await h.close(); }
});

test("a grant belongs to one task and does not leak to the next", async () => {
  const h = harness();
  try {
    await h.navigate("https://example.com");
    await h.submit("first submission", "allow_task");
    assert.ok(h.store.taskGrantedOrigins(h.taskId).includes("https://example.com"));
    const other = h.store.insertTask({ computer_id: "churn", goal: "another", max_steps: 5 });
    assert.deepEqual(h.store.taskGrantedOrigins(other.id), [],
      "a second task starts with no granted origins");
  } finally { await h.close(); }
});

test("remembering a site for the task answers the next ask on that site", async () => {
  const h = harness();
  try {
    await h.navigate("https://example.com");
    const asks = await h.submit("first submission", "allow_task");
    assert.equal(asks, 1);
    assert.equal(await h.navigate("https://www.example.com/deep/link"), 0);
    assert.equal(await h.submit("another submission", "allow_task"), 0);
    assert.equal(h.requested.length, 1, "the remembered grant answered the rest");
  } finally { await h.close(); }
});

test("the approval card is told when it expires and whether it can be remembered", async () => {
  const h = harness();
  try {
    await h.navigate("https://example.com");
    await h.submit("first submission");
    const body = h.requested[0]!;
    const bind = body.bind as { expires: string; origin: string };
    assert.equal(body.expires_at, bind.expires, "the deadline rides on the payload, not just the bind");
    assert.equal(body.can_remember, true, "a site gate can be remembered for the task");
    assert.deepEqual(body.remember_origins, ["https://example.com", "https://www.example.com"]);
    // 120 s is the zero-config default (schema `policy.approval_ttl_sec`).
    const created = Date.parse(String(body.created_at));
    assert.equal(Date.parse(bind.expires) - created, 120_000);
    assert.equal(bind.origin, "https://example.com", "the approval is bound to the form's page");
  } finally { await h.close(); }
});

test("a grant covers the site's www alias and nothing wider", () => {
  assert.deepEqual(grantedOriginsFor("https://wikipedia.org/wiki/X"),
    ["https://wikipedia.org", "https://www.wikipedia.org"]);
  assert.deepEqual(grantedOriginsFor("https://www.wikipedia.org/"),
    ["https://www.wikipedia.org", "https://wikipedia.org"]);
  assert.deepEqual(grantedOriginsFor("https://mail.example.com/"),
    ["https://mail.example.com", "https://www.mail.example.com"]);
  assert.deepEqual(grantedOriginsFor("http://example.com:8080/"),
    ["http://example.com:8080", "http://www.example.com:8080"]);
  // Different scheme, IP literals and non-web schemes grant nothing extra.
  assert.deepEqual(grantedOriginsFor("https://127.0.0.1:9000/"), ["https://127.0.0.1:9000"]);
  assert.deepEqual(grantedOriginsFor("http://localhost:3000/"), ["http://localhost:3000"]);
  assert.deepEqual(grantedOriginsFor("file:///etc/passwd"), []);
  assert.deepEqual(grantedOriginsFor("not a url"), []);
});

test("origin grants are capped per task and the refusal is visible", () => {
  const store = new Store();
  try {
    const task = store.insertTask({ computer_id: "grant-cap", goal: "grant storm", max_steps: 5 });
    const wanted = Array.from({ length: 40 }, (_, i) => `https://site${i}.example`);
    const granted = wanted.flatMap((origin) => store.grantTaskOrigins(task.id, [origin], "ap_1"));
    assert.equal(granted.length, MAX_TASK_ORIGIN_GRANTS);
    assert.equal(store.countTaskGrantedOrigins(task.id), MAX_TASK_ORIGIN_GRANTS);
    assert.equal(store.taskGrantedOrigins(task.id).length, MAX_TASK_ORIGIN_GRANTS);
    assert.ok(!store.taskGrantedOrigins(task.id).includes("https://site32.example"),
      "past the cap the answer is no, not a longer allowlist");
  } finally {
    store.close();
  }
});

test("the recorded decision is the human's, and an outer transaction survives", () => {
  const store = new Store();
  try {
    const task = store.insertTask({ computer_id: "decide", goal: "decide", max_steps: 5 });
    const approval = store.insertApproval({
      task_id: task.id, tool: "browser_navigate", args: { url: "https://example.com/" },
      gate: "new_domain", bind: { origin: "https://example.com" },
    });
    store.setApprovalStatusIf(approval.id, "pending", "approved", "allow_task");

    // Called inside an open transaction, a bare BEGIN threw and the catch
    // rolled the OUTER transaction back, losing unrelated work.
    store.db.exec("BEGIN IMMEDIATE");
    store.db.prepare("UPDATE tasks SET goal = ? WHERE id = ?").run("outer work", task.id);
    const consumed = store.consumeApprovalWithGrant(
      approval.id, "approved", task.id, ["https://example.com"], "allow_task",
    );
    store.db.exec("COMMIT");

    assert.ok(consumed, "the approval was consumed");
    assert.equal(store.getTask(task.id)!.goal, "outer work", "the outer transaction committed");
    // A fixed "allow_once" made the durable record of the answer a lie.
    assert.equal(store.getApproval(approval.id)!.decision, "allow_task");
    assert.deepEqual(store.taskGrantedOrigins(task.id), ["https://example.com"]);
  } finally {
    store.close();
  }
});
