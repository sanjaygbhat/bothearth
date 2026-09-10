import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeComputer } from "../../../src/computer-client/fake.ts";
import type { ComputerCallContext } from "../../../src/computer-client/types.ts";
import type { ToolName, ToolResult } from "../../../src/types/contracts.ts";
import { createToolDispatcher } from "../../../src/daemon/dispatcher.ts";
import { Store } from "../../../src/daemon/store.ts";

/**
 * Reading a site is ordinary task work. Explicitly remembering a submission
 * approval covers subsequent form interactions on that site for this task.
 *
 * What a grant does NOT cover: another origin, and the gates that are about the
 * action rather than the site (payment, delete, upload, external send).
 */

class Browser extends FakeComputer {
  url = "about:blank";

  override async call(method: string, args?: unknown, context?: ComputerCallContext): Promise<ToolResult> {
    if (method === "browser_snapshot") {
      return { ok: true, data: { url: this.url, yaml: "-", snapshot_id: "s1" } };
    }
    if (method === "browser_navigate") {
      const url = String((args as { url?: string }).url);
      if (!context?.allowPublicNavigation && !(context?.navigationOrigins ?? []).includes(new URL(url).origin)) {
        return { ok: false, error: { code: "E_POLICY", message: "blocked before contact",
          details: { navigation_url: url } } };
      }
      this.url = url;
      return { ok: true, data: { url, title: "T", snapshot_id: "s2" } };
    }
    return super.call(method, args);
  }
}

function harness() {
  const store = new Store();
  const browser = new Browser("g1");
  store.insertComputer({ id: "g1", name: "n", capabilities: ["browser"], persistent: true, status: "running" });
  const task = store.insertTask({ computer_id: "g1", goal: "organise the inbox", max_steps: 50 });
  const asked: Array<{ tool: string; reason: string; can_remember: boolean }> = [];
  const dispatcher = createToolDispatcher({
    store,
    getClient: () => browser,
    emit: async (type, body) => {
      if (type !== "approval.requested") return;
      asked.push({
        tool: String(body.tool),
        reason: String(body.reason),
        can_remember: body.can_remember === true,
      });
    },
  });
  // `policy.strict_allowlist` is empty by default, so a shipped install starts a
  // task with no write grants. Reading a site must not silently add one.
  const context = { computerId: "g1", taskId: task.id, mode: "supervised" as const,
    originSets: { readable: [], writable: [] } };

  /** Run one call, answering every approval it raises, until it goes through. */
  const run = async (tool: ToolName, args: Record<string, unknown>): Promise<number> => {
    let asks = 0;
    for (let round = 0; round < 4; round += 1) {
      const result = await dispatcher.dispatch(tool, args, context);
      if (result.ok) return asks;
      assert.equal(result.error.code, "E_POLICY_PENDING",
        `${tool}: ${result.error.code} ${result.error.message}`);
      asks += 1;
      for (const pending of store.listApprovals("pending")) {
        store.setApprovalStatusIf(pending.id, "pending", "approved", "allow_task");
      }
    }
    assert.fail(`${tool} never went through`);
  };

  return {
    store, browser, asked, run, taskId: task.id,
    async close() { await browser.close(); store.close(); },
  };
}

test("one site grant covers typing, Enter, keys and clicks on that origin", async () => {
  const h = harness();
  try {
    assert.equal(await h.run("browser_navigate", { url: "https://mail.google.com/mail/u/0/" }), 0);
    assert.deepEqual(h.store.taskGrantedOrigins(h.taskId), []);
    assert.equal(await h.run("browser_type", { ref: "e1", text: "Noise/Social", submit: true }), 1,
      "submitting data is a separate decision from reading the page");
    assert.ok(h.store.taskGrantedOrigins(h.taskId).includes("https://mail.google.com"));

    // Everything the bot then does on that site. Each of these raised its own
    // "first time your bot has opened this site" card before the grant became
    // a decision about the origin instead of about one tool.
    assert.equal(await h.run("browser_type", { ref: "e1", text: "Noise/Social", submit: true }), 0);
    assert.equal(await h.run("browser_press", { key: "Enter" }), 0);
    assert.equal(await h.run("computer_key", { key: "Enter" }), 0);
    assert.equal(await h.run("browser_click", { ref: "e2" }), 0);
    assert.equal(await h.run("browser_navigate", { url: "https://mail.google.com/mail/u/0/#settings" }), 0);

    assert.equal(h.asked.length, 1, `extra asks: ${JSON.stringify(h.asked)}`);
  } finally { await h.close(); }
});

test("reading another site is free but does not extend a previous write grant", async () => {
  const h = harness();
  try {
    await h.run("browser_navigate", { url: "https://mail.google.com/" });
    assert.equal(await h.run("browser_type", { text: "label", submit: true }), 1);
    assert.equal(await h.run("browser_navigate", { url: "https://calendar.google.com/" }), 0);
    assert.ok(!h.store.taskGrantedOrigins(h.taskId).includes("https://calendar.google.com"));
    assert.equal(await h.run("browser_type", { text: "event", submit: true }), 1,
      "a form on another origin needs its own consent");
    assert.equal(h.asked.length, 2);
    assert.equal(h.asked[1]!.reason, "form_submit_new_origin:https://calendar.google.com");
  } finally { await h.close(); }
});

test("a card raised by a keystroke offers to remember the site it is on", async () => {
  const h = harness();
  try {
    // The page is already open — a restored session, not a navigation — so
    // there is no navigation approval for a grant to hang on. The card the
    // operator gets must still be one they can answer for the site.
    h.browser.url = "https://mail.google.com/mail/u/0/";

    assert.equal(await h.run("browser_type", { ref: "e1", text: "reddit", submit: true }), 1);
    assert.equal(h.asked.at(-1)!.tool, "browser_type");
    assert.equal(h.asked.at(-1)!.can_remember, true,
      "the operator must be able to answer for the site, not for one keystroke");
    assert.ok(h.store.taskGrantedOrigins(h.taskId).includes("https://mail.google.com"));

    assert.equal(await h.run("browser_press", { key: "Enter" }), 0,
      "the answer covered the site, so the next key is not a fresh question");
    assert.equal(h.asked.length, 1);
  } finally { await h.close(); }
});
