import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../../../src/daemon/store.ts";
import { FakeComputer } from "../../../src/computer-client/fake.ts";
import { createToolDispatcher } from "../../../src/daemon/dispatcher.ts";
import type { ToolResult } from "../../../src/types/contracts.ts";

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
  store.insertComputer({ id: computer.computerId, name: "Screen", capabilities: ["browser"],
    persistent: false, status: "running" });
  const task = store.insertTask({ computer_id: computer.computerId, goal: "read mail", max_steps: 5 });
  const dispatcher = createToolDispatcher({ store, getClient: () => computer, emit: () => {} });
  const context = { computerId: computer.computerId, taskId: task.id };
  return { store, computer, dispatcher, context };
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

test("a real code or password field still stops the agent", async () => {
  for (const [yaml, reason] of [
    ['modelbot_sensitive_fields: 1\n- textbox "Email or phone" [ref=e1]', "password_field"],
    ['- textbox "Password" [ref=e1]', "password_field"],
    ['- textbox "Enter code" [ref=e1]', "otp_field"],
    ['- textbox "2-step verification code" [ref=e1]', "otp_field"],
  ] as const) {
    const h = harness();
    h.computer.url = "https://accounts.example/signin";
    h.computer.yaml = yaml;
    try {
      const result = await h.dispatcher.dispatch("browser_type",
        { ref: "e1", text: "hunter2" }, h.context);
      assert.equal(!result.ok && result.error.code, "E_TAKEOVER_BUSY", yaml);
      assert.equal(!result.ok && result.error.message, reason, yaml);
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

test("a declined ask tells the model the field is not sensitive, and shows the page", async () => {
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
    assert.equal(again.error.message,
      "The person looked and says this field is not sensitive and no sign-in is needed. " +
      "Continue the task yourself; do not ask for control for this field again.");
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

test('"not needed, continue" holds for that field until the page moves', async () => {
  const h = harness();
  h.computer.url = "https://mail.example/search";
  h.computer.yaml = 'modelbot_sensitive_fields: 1 otp\n- textbox "Search mail" [ref=e1]';
  try {
    // The false positive: the container marked a short numeric box, the gate
    // stopped on it, and the person looked and said no code was needed.
    const stopped = await h.dispatcher.dispatch("browser_type", { ref: "e1", text: "reddit" }, h.context);
    assert.equal(!stopped.ok && stopped.error.code, "E_TAKEOVER_BUSY");
    assert.equal(!stopped.ok && stopped.error.message, "otp_field");
    const lease = h.store.activeTakeoverForComputer(h.computer.computerId, h.context.taskId)!;
    await h.computer.declineTakeover(lease.id);
    h.store.declineTakeover(lease.id);

    // Every later attempt on the same field goes through, and no second card is
    // raised: the decline used to buy exactly one turn.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const typed = await h.dispatcher.dispatch("browser_type", { ref: "e1", text: "reddit" }, h.context);
      assert.equal(typed.ok, true, `attempt ${attempt} was refused again`);
      assert.equal(h.store.activeTakeoverForComputer(h.computer.computerId), undefined,
        "the card the person dismissed came back");
    }

    // The model typing into the field changes the page's contents but not the
    // page: the standalone loop, which names its own origin, must still see it.
    h.computer.yaml = 'modelbot_sensitive_fields: 1 otp\n- textbox "Search mail" [ref=e1]: "reddit"';
    const standalone = { ...h.context, origin: "https://mail.example", signals: {} };
    const later = await h.dispatcher.dispatch("browser_type", { ref: "e1", text: "!" }, standalone);
    assert.equal(later.ok, true, "the dismissed card came back on the standalone loop");

    // A different page is a different question.
    h.computer.url = "https://accounts.example/challenge";
    const elsewhere = await h.dispatcher.dispatch("browser_type", { ref: "e1", text: "123456" }, h.context);
    assert.equal(!elsewhere.ok && elsewhere.error.code, "E_TAKEOVER_BUSY");
  } finally { await h.computer.close(); h.store.close(); }
});

test("an OTP-only page asks about a code, not a password", async () => {
  const h = harness();
  h.computer.url = "https://accounts.example/challenge";
  h.computer.yaml = 'modelbot_sensitive_fields: 1 otp\n- textbox "Enter it" [ref=e1]';
  try {
    const result = await h.dispatcher.dispatch("browser_type", { ref: "e1", text: "123456" }, h.context);
    assert.equal(!result.ok && result.error.code, "E_TAKEOVER_BUSY");
    assert.equal(!result.ok && result.error.message, "otp_field",
      "a 2-step verification screen was reported as a password box");
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
