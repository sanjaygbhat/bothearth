import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeComputer } from "../../../src/computer-client/fake.ts";
import {
  createToolDispatcher,
  syncAndGrantTakeover,
  takeoverNeedsComputerSync,
} from "../../../src/daemon/dispatcher.ts";
import { Store } from "../../../src/daemon/store.ts";
import type { ToolResult } from "../../../src/types/contracts.ts";
import { feedLine, indexSnapshotLabels } from "../../../src/ui/task.ts";

/** A fake computer whose snapshot is whatever the test puts on screen. */
class Screen extends FakeComputer {
  url = "https://mail.example/#inbox";
  title = "Inbox";
  yaml = '- textbox "Search mail" [ref=e1]\n- link "Sign out" [ref=e2]';

  override async call(method: string, params?: unknown): Promise<ToolResult> {
    const result = await super.call(method, params);
    if (method !== "browser_snapshot" || !result.ok) return result;
    return { ok: true, data: { ...(result.data as Record<string, unknown>),
      url: this.url, title: this.title, yaml: this.yaml } };
  }
}

function harness() {
  const store = new Store(), computer = new Screen("observation");
  const events: Array<{ type: string; body: Record<string, unknown> }> = [];
  store.insertComputer({ id: computer.computerId, name: "Screen", capabilities: ["browser"],
    persistent: false, status: "running" });
  const task = store.insertTask({ computer_id: computer.computerId, goal: "read mail", max_steps: 5 });
  const dispatcher = createToolDispatcher({
    store, getClient: () => computer,
    emit: async (type, body) => { events.push({ type, body }); },
  });
  const context = { computerId: computer.computerId, taskId: task.id };
  return { store, computer, dispatcher, context, events };
}

const SIGN_IN = "Sign in and pass 2-step verification, then hand control back.";

/** Hand control to a person and back, the way the release route does. */
async function handOverAndBack(h: ReturnType<typeof harness>): Promise<string> {
  const asked = await h.dispatcher.dispatch("request_takeover", { reason: SIGN_IN }, h.context);
  assert.equal(asked.ok, true);
  const lease = h.store.activeTakeoverForComputer(h.computer.computerId, h.context.taskId)!;
  await h.computer.grantTakeover(lease.id);
  await h.computer.releaseTakeover(lease.id);
  h.store.updateTakeoverState(lease.id, "agent");
  return lease.id;
}

test("mail that talks about codes and passwords is not a screen asking for one", async () => {
  const h = harness();
  h.computer.yaml = [
    '- textbox "Search mail" [ref=e1]',
    '- row "Google, Your verification code is 220913" [ref=e2]',
    '- row "Reddit, one-time password for your account" [ref=e3]',
    '- link "Reset your password" [ref=e4]',
    '- paragraph: Use the OTP below to sign in.',
  ].join("\n");
  try {
    const result = await h.dispatcher.dispatch("browser_click", { ref: "e2" }, h.context);
    assert.equal(result.ok, true, "reading a mailbox must not force a takeover");
    assert.equal(h.store.activeTakeoverForComputer(h.computer.computerId), undefined);
  } finally { await h.computer.close(); h.store.close(); }
});

test("a real code or password field still reaches observation without minting a takeover", async () => {
  for (const yaml of [
    'modelbot_sensitive_fields: 1\n- textbox "Email or phone" [ref=e1]',
    'modelbot_sensitive_fields: 1 password\n- textbox "Password" [ref=e1]\n- button "Sign in" [ref=e2]',
    '- textbox "Enter code" [ref=e1]',
    '- textbox "2-step verification code" [ref=e1]',
  ]) {
    const h = harness();
    h.computer.url = "https://accounts.example/signin";
    h.computer.yaml = yaml;
    try {
      const result = await h.dispatcher.dispatch("browser_type",
        { ref: "e1", text: "hunter2" }, h.context);
      assert.equal(result.ok, true, yaml);
      assert.equal(h.store.activeTakeoverForComputer(h.computer.computerId), undefined, yaml);
      assert.equal(h.events.some((event) => event.type === "takeover.requested"), false, yaml);
    } finally { await h.computer.close(); h.store.close(); }
  }
});

test("when control comes back the status poll carries the page the person left", async () => {
  const h = harness();
  try {
    await handOverAndBack(h);
    h.computer.url = "https://mail.example/#inbox";
    h.computer.title = "Inbox (12)";
    h.computer.yaml = '- link "Compose" [ref=e1]';
    const status = await h.dispatcher.dispatch("takeover_status", {}, h.context);
    assert.equal(status.ok, true);
    const page = (status.data as { page?: { url: string; title?: string; snapshot: string } }).page;
    assert.equal(page?.url, "https://mail.example/#inbox");
    assert.equal(page?.title, "Inbox (12)");
    assert.equal(page?.snapshot, '- link "Compose" [ref=e1]');
  } finally { await h.computer.close(); h.store.close(); }
});

test("asking again for the same reason on the same page answers with the page", async () => {
  const h = harness();
  try {
    await handOverAndBack(h);
    const again = await h.dispatcher.dispatch("request_takeover", { reason: SIGN_IN }, h.context);
    assert.equal(again.ok, false);
    assert.equal(!again.ok && again.error.code, "E_POLICY");
    const page = !again.ok
      ? (again.error.details as { page?: { url: string; snapshot: string } }).page
      : undefined;
    assert.equal(page?.url, "https://mail.example/#inbox");
    assert.ok(page?.snapshot.includes("Search mail"));
    assert.equal(h.store.activeTakeoverForComputer(h.computer.computerId), undefined,
      "the task must not park on a screen nobody can see");

    // Asking once more, having been shown the page, is a real ask.
    const meant = await h.dispatcher.dispatch("request_takeover", { reason: SIGN_IN }, h.context);
    assert.equal(meant.ok, true);
    assert.ok(h.store.activeTakeoverForComputer(h.computer.computerId));
  } finally { await h.computer.close(); h.store.close(); }
});

test("a declined ask answers with the page and a factual handback line", async () => {
  const h = harness();
  h.computer.url = "https://mail.example/search";
  h.computer.yaml = '- textbox "Search mail" [ref=e1]';
  try {
    // The false `otp_field` case: the model stopped on a search box, and the
    // person looked and said no code was needed.
    const asked = await h.dispatcher.dispatch("request_takeover",
      { reason: "otp_field" }, h.context);
    assert.equal(asked.ok, true);
    const lease = h.store.activeTakeoverForComputer(h.computer.computerId, h.context.taskId)!;
    await h.computer.declineTakeover(lease.id);
    h.store.declineTakeover(lease.id);

    const again = await h.dispatcher.dispatch("request_takeover", { reason: "otp_field" }, h.context);
    assert.equal(again.ok, false);
    if (again.ok) assert.fail("the declined ask was raised again");
    assert.equal(again.error.code, "E_POLICY");
    assert.equal(again.error.message, "The person gave control back.");
    const page = (again.error.details as { page?: { url: string; snapshot: string } }).page;
    assert.equal(page?.url, "https://mail.example/search");
    assert.ok(page?.snapshot.includes("Search mail"));
  } finally { await h.computer.close(); h.store.close(); }
});

test("the standalone loop is given the page too, though it names its own origin", async () => {
  const h = harness();
  // What agent-loop.ts passes on every call: an origin it already knows, which
  // used to skip the observation entirely and leave this whole path dead
  // outside the harness.
  const context = { ...h.context, origin: "https://mail.example", signals: {} };
  try {
    const asked = await h.dispatcher.dispatch("request_takeover", { reason: SIGN_IN }, context);
    assert.equal(asked.ok, true);
    const lease = h.store.activeTakeoverForComputer(h.computer.computerId, h.context.taskId)!;
    await h.computer.grantTakeover(lease.id);
    await h.computer.releaseTakeover(lease.id);
    h.store.updateTakeoverState(lease.id, "agent");

    const again = await h.dispatcher.dispatch("request_takeover", { reason: SIGN_IN }, context);
    assert.equal(again.ok, false);
    if (again.ok) return;
    const page = (again.error.details as { page?: { url: string } }).page;
    assert.equal(page?.url, "https://mail.example/#inbox");
    assert.equal(h.store.activeTakeoverForComputer(h.computer.computerId), undefined,
      "the standalone task parked on a screen nobody can see");
  } finally { await h.computer.close(); h.store.close(); }
});

test("a page handed back is not quoted back at the model in full", async () => {
  const h = harness();
  h.computer.yaml = Array.from({ length: 900 }, (_, i) => `- link "row ${i}" [ref=e${i}]`).join("\n");
  try {
    await handOverAndBack(h);
    const status = await h.dispatcher.dispatch("takeover_status", {}, h.context);
    assert.equal(status.ok, true);
    const page = (status.data as { page?: { snapshot: string } }).page!;
    assert.ok(h.computer.yaml.length > 16_000, "the fixture page is not large enough to matter");
    assert.ok(page.snapshot.length <= 4_000, `page snapshot was ${page.snapshot.length} chars`);
  } finally { await h.computer.close(); h.store.close(); }
});

test("typing an OTP-marked field does not mint a takeover", async () => {
  const h = harness();
  h.computer.url = "https://mail.example/search";
  h.computer.yaml = 'modelbot_sensitive_fields: 1 otp\n- textbox "Search mail" [ref=e1]';
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const typed = await h.dispatcher.dispatch("browser_type", { ref: "e1", text: "reddit" }, h.context);
      assert.equal(typed.ok, true, `attempt ${attempt} minted a takeover`);
      assert.equal(h.store.activeTakeoverForComputer(h.computer.computerId), undefined);
    }
    const asked = await h.dispatcher.dispatch("request_takeover", { reason: "otp_field" }, h.context);
    assert.equal(asked.ok, true);
    assert.ok(h.store.activeTakeoverForComputer(h.computer.computerId));
  } finally { await h.computer.close(); h.store.close(); }
});

test("an OTP-only page still shows the field without minting a takeover", async () => {
  const h = harness();
  h.computer.url = "https://accounts.example/challenge";
  h.computer.yaml = 'modelbot_sensitive_fields: 1 otp\n- textbox "Enter it" [ref=e1]';
  try {
    const result = await h.dispatcher.dispatch("browser_type", { ref: "e1", text: "123456" }, h.context);
    assert.equal(result.ok, true);
    assert.equal(h.store.activeTakeoverForComputer(h.computer.computerId), undefined);
  } finally { await h.computer.close(); h.store.close(); }
});

test("the same ask goes through once the page has moved", async () => {
  const h = harness();
  try {
    await handOverAndBack(h);
    await h.dispatcher.dispatch("takeover_status", {}, h.context);
    h.computer.url = "https://accounts.example/challenge";
    h.computer.yaml = '- textbox "Enter code" [ref=e1]';
    const again = await h.dispatcher.dispatch("request_takeover", { reason: SIGN_IN }, h.context);
    assert.equal(again.ok, true);
    assert.ok(h.store.activeTakeoverForComputer(h.computer.computerId));
  } finally { await h.computer.close(); h.store.close(); }
});

/**
 * Serialized stdio: each RPC waits for the previous. A hung snapshot holds
 * request_takeover in the queue until the snapshot is released.
 */
class SerializedRpc extends FakeComputer {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly blockSnapshot: Promise<void>;
  takeoverParams: unknown;
  constructor(id: string) {
    super(id);
    this.blockSnapshot = new Promise<void>(() => {});
  }
  override async call(method: string, params?: unknown): Promise<ToolResult> {
    if (method === "request_takeover") this.takeoverParams = params;
    const run = this.tail.then(async () => {
      if (method === "browser_snapshot") await this.blockSnapshot;
      return super.call(method, params);
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

/** First request_takeover never answers; a later call (acquire reconcile) does. */
class TimeoutThenOk extends FakeComputer {
  takeoverCalls = 0;
  override async call(method: string, params?: unknown): Promise<ToolResult> {
    if (method === "request_takeover") {
      this.takeoverCalls += 1;
      if (this.takeoverCalls === 1) return new Promise<ToolResult>(() => {});
    }
    return super.call(method, params);
  }
}

function hungHarness() {
  const store = new Store(), computer = new SerializedRpc("hung-page");
  const events: Array<{ type: string; body: Record<string, unknown> }> = [];
  store.insertComputer({ id: computer.computerId, name: "Hung", capabilities: ["browser"],
    persistent: false, status: "running" });
  const task = store.insertTask({ computer_id: computer.computerId, goal: "sign in", max_steps: 5 });
  const dispatcher = createToolDispatcher({
    store, getClient: () => computer,
    emit: async (type, body) => { events.push({ type, body }); },
  });
  const context = { computerId: computer.computerId, taskId: task.id };
  return { store, computer, dispatcher, context, events };
}

test("request_takeover records a row when browser_snapshot never resolves", { timeout: 8_000 }, async () => {
  const h = hungHarness();
  try {
    const started = Date.now();
    const result = await h.dispatcher.dispatch("request_takeover", { reason: "sign_in" }, h.context);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 7_000, `request_takeover took ${elapsed}ms with a hung snapshot`);
    assert.equal(!result.ok && result.error.code, "E_TAKEOVER_BUSY");
    const row = h.store.latestTakeoverForComputer(h.computer.computerId);
    assert.ok(row, "store has a takeover row for the computer");
    assert.equal(row.state, "takeover_requested");
    const queuedId = (h.computer.takeoverParams as { takeover_id?: string } | undefined)?.takeover_id;
    assert.equal(row.id, queuedId, "row id is the lease id passed into request_takeover");
    const types = h.events.map((event) => event.type);
    const callAt = types.indexOf("tool.call");
    const askedAt = types.indexOf("takeover.requested");
    assert.ok(callAt >= 0, "emit log contains tool.call");
    assert.ok(askedAt > callAt, "takeover.requested follows tool.call");
    const callBody = h.events[callAt]!.body;
    assert.equal("arguments" in callBody, false, "pre-observe tool.call must not carry arguments");
  } finally { await h.computer.close(); h.store.close(); }
});

test("a hung snapshot on browser_click emits tool.call then tool.error E_TIMEOUT", async () => {
  const h = hungHarness();
  try {
    const result = await h.dispatcher.dispatch(
      "browser_click",
      { snapshot_id: "snap_hung", ref: "e1", button: "left", double_click: false },
      { ...h.context, timeoutMs: 50 },
    );
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, "E_TIMEOUT");
    const types = h.events.map((event) => event.type);
    assert.deepEqual(types, ["tool.call", "tool.error"]);
    const error = h.events[1]!.body;
    assert.equal(error.cause, "observe");
    assert.equal("arguments" in error, false);
    const emitted = error.result as ToolResult;
    assert.equal(emitted.ok, false);
    assert.equal(!emitted.ok && emitted.error.code, "E_TIMEOUT");
  } finally { await h.computer.close(); h.store.close(); }
});

test("a password typed on a sensitive page stays out of audit events and task steps", async () => {
  const h = harness();
  const secret = "hunter2-never-in-events";
  h.computer.url = "https://accounts.example/signin";
  h.computer.yaml = 'modelbot_sensitive_fields: 1 password\n- textbox "Password" [ref=e1]\n- button "Sign in" [ref=e2]';
  try {
    const result = await h.dispatcher.dispatch("browser_type",
      { ref: "e1", text: secret }, h.context);
    assert.equal(result.ok, true);
    assert.equal(h.store.activeTakeoverForComputer(h.computer.computerId), undefined);
    assert.equal(h.events.some((event) => event.type === "takeover.requested"), false);
    const call = h.events.find((event) => event.type === "tool.call");
    assert.ok(call, "typing still emits tool.call so a hang is visible");
    assert.equal("arguments" in call.body, false);
    const recorded = h.events.find((event) => event.type === "tool.result");
    assert.ok(recorded, "typing still emits tool.result");
    const auditArgs = recorded.body.arguments as { text?: unknown; ref?: unknown };
    assert.equal(auditArgs.text, `<${secret.length} chars>`);
    assert.equal(auditArgs.ref, "e1");
    assert.equal(JSON.stringify(h.events).includes(secret), false);
    const labels = indexSnapshotLabels(h.computer.yaml);
    const steps = h.events.map((event) => feedLine(event.type, event.body, { labels }));
    assert.equal(JSON.stringify(steps).includes(secret), false);
    const asked = await h.dispatcher.dispatch("request_takeover", { reason: "password" }, h.context);
    assert.equal(asked.ok, true);
    assert.ok(h.store.activeTakeoverForComputer(h.computer.computerId));
    assert.equal(JSON.stringify(h.events).includes(secret), false);
  } finally { await h.computer.close(); h.store.close(); }
});

test("an unfocused Password textbox without a sign-in control is not a hold", async () => {
  const h = harness();
  h.computer.url = "https://mail.example/#inbox";
  h.computer.yaml = '- textbox "Password" [ref=e1]\n- button "New chat" [ref=e2]';
  try {
    const result = await h.dispatcher.dispatch("browser_type",
      { ref: "e1", text: "not-a-login" }, h.context);
    assert.equal(result.ok, true, "a name-only Password box is a hint, not a hold");
    assert.equal(h.store.activeTakeoverForComputer(h.computer.computerId), undefined);
  } finally { await h.computer.close(); h.store.close(); }
});

test("signed-in chatgpt.com settings with Change password is not a hold", async () => {
  const h = harness();
  h.computer.url = "https://chatgpt.com/#settings";
  h.computer.yaml = [
    '- heading "Settings" [ref=e1]',
    '- button "Change password" [ref=e2]',
    '- button "Log out" [ref=e3]',
  ].join("\n");
  try {
    const result = await h.dispatcher.dispatch("browser_click", { ref: "e2" }, h.context);
    assert.equal(result.ok, true, "Change password is not a login form");
    assert.equal(h.store.activeTakeoverForComputer(h.computer.computerId), undefined);
  } finally { await h.computer.close(); h.store.close(); }
});

test("acquire after a timed-out mint grants the computer lease", { timeout: 4_000 }, async () => {
  const store = new Store(), computer = new TimeoutThenOk("timeout-mint");
  store.insertComputer({ id: computer.computerId, name: "Hang", capabilities: ["browser"],
    persistent: false, status: "running" });
  const task = store.insertTask({ computer_id: computer.computerId, goal: "sign in", max_steps: 5 });
  const dispatcher = createToolDispatcher({ store, getClient: () => computer, emit: () => {} });
  const context = { computerId: computer.computerId, taskId: task.id, timeoutMs: 80 };
  try {
    const result = await dispatcher.dispatch("request_takeover", { reason: "sign_in" }, context);
    assert.equal(!result.ok && result.error.code, "E_TAKEOVER_BUSY");
    const row = store.latestTakeoverForComputer(computer.computerId);
    assert.ok(row, "timeout mint wrote a store row");
    assert.equal(takeoverNeedsComputerSync(row.id), true);
    assert.equal(computer.getTakeoverState(), "agent");
    const direct = await computer.grantTakeover(row.id);
    assert.equal(direct.ok, false, "grant before reconcile must not bind a daemon-only id");
    const granted = await syncAndGrantTakeover(computer, row.id);
    assert.equal(granted.ok, true, "acquire re-issues request_takeover then grants");
    assert.equal(computer.getTakeoverState(), "human");
    assert.equal(computer.takeoverCalls, 2);
    assert.equal(takeoverNeedsComputerSync(row.id), false);
    assert.equal((granted.data as { takeover_id?: string }).takeover_id, row.id);
  } finally { await computer.close(); store.close(); }
});
