/**
 * A task pauses when it asks for a person to take over. Resume cannot answer
 * that ask — only the keyboard can — so this pause keeps the live view and the
 * Take-control card instead of the terminal receipt.
 */
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { TaskView } from "../../../src/ui/task.ts";
import { resetSession } from "../../../src/ui/session.ts";
import { PASSWORD_STILL_ON_SCREEN } from "../../../src/ui/takeover.ts";
import { installDom, settle, type FakeElement } from "./fake-dom.ts";

const AT = "2026-09-07T10:02:00.000Z";

type Json = Record<string, unknown>;

function detail(reason: string): Json {
  return {
    task: { id: "t_1", computer_id: "cmp_1", goal: "Sign in to the airline", status: "paused", created_at: AT },
    steps: [
      { kind: "task.started", body: {}, created_at: AT },
      { kind: "task.step", body: { status: "paused", reason }, created_at: AT },
    ],
  };
}

async function mount(routes: Record<string, Json>, posts?: string[]) {
  resetSession();
  const dom = installDom({ hash: "#/tasks/t_1" });
  const original = globalThis.fetch;
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    const key = String(path).split("?")[0]!;
    if ((init?.method ?? "GET") === "POST") {
      posts?.push(key);
      const body = routes[key];
      return body ? Response.json(body) : Response.json({ takeover: { state: "agent" } });
    }
    const body = routes[key];
    return body ? Response.json(body) : new Response("{}", { status: 404 });
  }) as typeof fetch;
  const view = new TaskView();
  const root = document.createElement("div") as unknown as FakeElement;
  await view.mount(root as unknown as HTMLElement, "t_1");
  await settle(8);
  return {
    root,
    stop() {
      view.unmount();
      globalThis.fetch = original;
      dom.restore();
    },
  };
}

const SESSION = { ok: true, csrf: "c", spend_cap_usd: 2, execution_mode: "standalone" };

describe("a task paused for a takeover", () => {
  it("keeps the live view and offers Take control, not Resume", async () => {
    const view = await mount({
      "/api/v1/session": SESSION,
      "/api/v1/tasks/t_1": detail("takeover"),
      "/api/v1/approvals": { approvals: [] },
      "/api/v1/takeovers": { takeovers: [
        { id: "tk_1", computer_id: "cmp_1", task_id: "t_1", state: "takeover_requested" },
      ] },
    });
    try {
      assert.equal(view.root.querySelector(".done-scroll"), null, "the receipt took over the screen");
      const buttons = view.root.querySelectorAll("button").map((node) => node.textContent);
      assert.ok(!buttons.includes("Resume"), `Resume was offered for a takeover pause: ${buttons.join(", ")}`);
      assert.ok(view.root.querySelector(".takeover-ask"), "the Take-control card is missing");
      assert.ok(
        buttons.some((text) => text.startsWith("Take control")),
        `no Take-control button: ${buttons.join(", ")}`,
      );
      assert.ok(view.root.querySelector(".feed"), "the live view is gone");
      assert.equal(view.root.querySelector(".task-bar .spend")!.textContent, "",
        "the bar reported the run as settled while a person still has to answer");
    } finally {
      view.stop();
    }
  });

  it("keeps the live view and offers Give control back when the hold has paused", async () => {
    const view = await mount({
      "/api/v1/session": SESSION,
      "/api/v1/tasks/t_1": detail("takeover"),
      "/api/v1/approvals": { approvals: [] },
      "/api/v1/takeovers": { takeovers: [
        { id: "tk_1", computer_id: "cmp_1", task_id: "t_1", state: "paused" },
      ] },
    });
    try {
      assert.equal(view.root.querySelector(".done-scroll"), null, "a paused hold must not show the receipt");
      assert.ok(view.root.querySelector(".takeover-ask"), "the return-control card is missing");
      assert.match(view.root.querySelector(".takeover-ask h2")!.textContent, /Control has paused/);
      const buttons = view.root.querySelectorAll("button").map((node) => node.textContent);
      assert.ok(buttons.includes("Give control back"), `Give control back is missing: ${buttons.join(", ")}`);
      assert.ok(buttons.some((text) => text.startsWith("Take control")), `no Take-control button: ${buttons.join(", ")}`);
      assert.ok(!buttons.includes("Resume"), `Resume was offered for a paused hold: ${buttons.join(", ")}`);
      assert.ok(view.root.querySelector(".feed"), "the live view is gone");
    } finally {
      view.stop();
    }
  });

  it("keeps Give control back on a cancelled task that still holds the computer", async () => {
    const view = await mount({
      "/api/v1/session": SESSION,
      "/api/v1/session/devices": { devices: [{ id: "dev_me", label: "This Mac", current: true }] },
      "/api/v1/tasks/t_1": {
        task: { id: "t_1", computer_id: "cmp_1", goal: "Sign in to GitHub", status: "cancelled", created_at: AT, cancelled_at: AT },
        steps: [
          { kind: "task.started", body: {}, created_at: AT },
          { kind: "task.cancelled", body: {}, created_at: AT },
        ],
      },
      "/api/v1/approvals": { approvals: [] },
      "/api/v1/takeovers": { takeovers: [
        { id: "tk_1", computer_id: "cmp_1", task_id: "t_1", state: "human", holder: "dev_me" },
      ] },
    });
    try {
      assert.equal(view.root.querySelector(".done-scroll"), null, "a live hold must not show the receipt");
      assert.ok(view.root.querySelector(".driving"), "the driving card is missing");
      const buttons = view.root.querySelectorAll("button").map((node) => node.textContent);
      assert.ok(buttons.some((text) => text?.includes("Give control back")), `Give control back is missing: ${buttons.join(", ")}`);
      const panelGive = view.root.querySelector(".view-acts")?.querySelectorAll("button")
        .find((node) => node.textContent === "Give control back");
      assert.ok(panelGive, "the live panel lost Give control back");
      assert.equal(panelGive.hidden, false);
    } finally {
      view.stop();
    }
  });

  it("says how to leave a password page and offers to clear the screen", async () => {
    const posts: string[] = [];
    const view = await mount({
      "/api/v1/session": SESSION,
      "/api/v1/session/devices": { devices: [{ id: "dev_me", label: "This Mac", current: true }] },
      "/api/v1/tasks/t_1": {
        task: { id: "t_1", computer_id: "cmp_1", goal: "Sign in to GitHub", status: "cancelled", created_at: AT },
        steps: [{ kind: "task.cancelled", body: {}, created_at: AT }],
      },
      "/api/v1/approvals": { approvals: [] },
      "/api/v1/takeovers": { takeovers: [
        { id: "tk_1", computer_id: "cmp_1", task_id: "t_1", state: "human", holder: "dev_me" },
      ] },
      "/api/v1/takeover/tk_1/release": {
        takeover: { state: "human", field: { kind: "password", label: "password" } },
        blocked_by: { kind: "password" },
      },
      "/api/v1/takeover/tk_1/clear": { takeover: { state: "agent" } },
    }, posts);
    try {
      const give = view.root.querySelectorAll("button").find((node) => node.textContent?.includes("Give control back") && node.className.includes("primary"));
      assert.ok(give);
      give.click();
      await settle(8);
      assert.ok(posts.includes("/api/v1/takeover/tk_1/release"));
      assert.match(view.root.textContent, new RegExp(PASSWORD_STILL_ON_SCREEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      const clear = view.root.querySelectorAll("button").find((node) => node.textContent === "Clear the screen and give control back");
      assert.ok(clear);
      assert.equal(clear.hidden, false);
      clear.click();
      await settle(8);
      assert.ok(posts.includes("/api/v1/takeover/tk_1/clear"));
    } finally {
      view.stop();
    }
  });

  it("shows the receipt with Resume for a pause Resume can fix", async () => {
    const view = await mount({
      "/api/v1/session": SESSION,
      // An approval that timed out: no cap to raise, so a plain Resume is the
      // offer. A `spend_cap` or `max_steps` pause is refused a bare resume and
      // gets "Resume with a higher budget" / "Resume with more steps" instead.
      "/api/v1/tasks/t_1": detail("approval"),
      "/api/v1/approvals": { approvals: [] },
      "/api/v1/takeovers": { takeovers: [] },
    });
    try {
      assert.ok(view.root.querySelector(".done-scroll"), "a timed-out approval pause lost its receipt");
      const buttons = view.root.querySelectorAll(".done-acts button").map((node) => node.textContent);
      assert.ok(buttons.includes("Resume"), `Resume is missing: ${buttons.join(", ")}`);
    } finally {
      view.stop();
    }
  });
});

for (const state of ["human", "paused"]) it(`a cancelled task keeps recovery controls for its ${state} hold`, async () => {
  const stopped = detail("takeover");
  (stopped.task as Json).status = "cancelled";
  const view = await mount({
    "/api/v1/session": { ...SESSION, device_id: "device_1" },
    "/api/v1/session/devices": { devices: [{ id: "device_1", current: true }] },
    "/api/v1/tasks/t_1": stopped,
    "/api/v1/approvals": { approvals: [] },
    "/api/v1/takeovers": { takeovers: [{ id: "tk_1", computer_id: "cmp_1", task_id: "t_1", state, holder: "device_1" }] },
  });
  try {
    assert.equal(view.root.querySelector(".done-scroll") === null, true);
    assert.ok(view.root.querySelectorAll("button").some(button => button.textContent.startsWith("Give control back")));
    assert.ok(view.root.querySelector("canvas"));
  } finally { view.stop(); }
});

/**
 * Driving lease: the poll can be 15 s stale; `input_ack.expires_at` is not.
 * The fake DOM's WebSocket is a stub, so these cases install a live one.
 */
class LiveSocket extends EventTarget {
  static OPEN = 1;
  readyState = 1;
  url: string;
  sent: Array<Record<string, unknown>> = [];
  constructor(url: string) {
    super();
    this.url = url;
    liveSockets.push(this);
  }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
}

const liveSockets: LiveSocket[] = [];

function liveSocket(path: string): LiveSocket {
  const socket = liveSockets.filter((s) => s.url.includes(path)).at(-1);
  assert.ok(socket, `no socket for ${path}`);
  return socket;
}

function liveControl(msg: object): void {
  liveSocket("/api/v1/live/").dispatchEvent(
    new MessageEvent("message", { data: JSON.stringify({ v: 1, ...msg }) }),
  );
}

function pump(t: TestContext, ms: number): void {
  let left = ms;
  while (left > 0) {
    const step = Math.min(500, left);
    liveControl({ t: "pong" });
    t.mock.timers.tick(step);
    left -= step;
  }
}

async function mountDriving(t: TestContext, expiresAt: string) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
  resetSession();
  liveSockets.length = 0;
  const originalWs = globalThis.WebSocket;
  const dom = installDom({ hash: "#/tasks/t_1" });
  Object.assign(globalThis, { WebSocket: LiveSocket });
  window.setTimeout = globalThis.setTimeout;
  window.setInterval = globalThis.setInterval;
  window.clearTimeout = globalThis.clearTimeout;
  window.clearInterval = globalThis.clearInterval;
  const originalFetch = globalThis.fetch;
  const routes: Record<string, Json> = {
    "/api/v1/session": SESSION,
    "/api/v1/session/devices": { devices: [{ id: "dev_me", label: "This Mac", current: true }] },
    "/api/v1/tasks/t_1": {
      task: { id: "t_1", computer_id: "cmp_1", goal: "Sign in", status: "running", created_at: AT },
      steps: [{ kind: "task.started", body: {}, created_at: AT }],
    },
    "/api/v1/approvals": { approvals: [] },
    "/api/v1/takeovers": { takeovers: [
      { id: "tk_1", computer_id: "cmp_1", task_id: "t_1", state: "human", holder: "dev_me", expires_at: expiresAt },
    ] },
  };
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    const key = String(path).split("?")[0]!;
    if ((init?.method ?? "GET") === "POST") return Response.json({ ok: true });
    const body = routes[key];
    return body ? Response.json(body) : new Response("{}", { status: 404 });
  }) as typeof fetch;
  const view = new TaskView();
  const root = document.createElement("div") as unknown as FakeElement;
  await view.mount(root as unknown as HTMLElement, "t_1");
  await settle(8);
  liveControl({ t: "mode", mode: "human", epoch: 2 });
  return {
    root,
    routes,
    stop() {
      view.unmount();
      globalThis.fetch = originalFetch;
      globalThis.WebSocket = originalWs;
      dom.restore();
    },
  };
}

describe("the driving countdown follows the live ack", () => {
  it("an input_ack with a later expiry extends the countdown and suppresses the paused copy", async (t) => {
    const view = await mountDriving(t, new Date(5000).toISOString());
    try {
      assert.match(view.root.querySelector(".driving")!.textContent, /Control pauses in 0:04/);
      assert.doesNotMatch(view.root.querySelector(".driving")!.textContent, /Control has paused/);
      liveControl({ t: "input_ack", epoch: 2, expires_at: new Date(11_000).toISOString() });
      assert.match(view.root.querySelector(".driving")!.textContent, /Control pauses in 0:10/);
      pump(t, 5000);
      assert.match(view.root.querySelector(".driving")!.textContent, /Control pauses in 0:05/);
      assert.doesNotMatch(view.root.textContent, /Control has paused/);
      assert.ok(view.root.querySelector(".driving"));
      view.routes["/api/v1/takeovers"] = { takeovers: [
        { id: "tk_1", computer_id: "cmp_1", task_id: "t_1", state: "paused", holder: "dev_me", expires_at: new Date(5000).toISOString() },
      ] };
      liveSocket("/api/v1/events").dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "takeover.expired", ts: AT, task_id: "t_1", computer_id: "cmp_1",
          body: { takeover_id: "tk_1" },
        }),
      }));
      await settle(8);
      assert.ok(view.root.querySelector(".driving"), "a newer ack must not yield the paused card");
      assert.doesNotMatch(view.root.textContent, /Control has paused/);
    } finally {
      view.stop();
    }
  });

  it("a lease that actually expires with no acks still shows paused", async (t) => {
    const view = await mountDriving(t, new Date(5000).toISOString());
    try {
      assert.match(view.root.querySelector(".driving")!.textContent, /Control pauses in 0:04/);
      pump(t, 4000);
      assert.match(view.root.querySelector(".driving")!.textContent, /Control has paused/);
      assert.match(view.root.querySelector(".driving")!.textContent, /Take control again/);
    } finally {
      view.stop();
    }
  });
});
