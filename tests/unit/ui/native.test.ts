/**
 * The native bridge and the attention loop (ux-spec §4, §3.2).
 *
 * There is no DOM in this runner, so the globals the module graph reads are
 * installed before the dynamic import below. Anything that genuinely needs a
 * browser (the palette’s rendering, the contextual alerts card) is verified in
 * a real one with Playwright.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

/* -------------------------------------------------------------------------
 * Fake browser
 * ---------------------------------------------------------------------- */

type AnyRecord = Record<string, unknown>;
const globals = globalThis as unknown as AnyRecord;

const posted: Array<{ method: string; args: unknown }> = [];
let permission = "granted";
let focuses = 0;

class FakeNotification {
  static get permission(): string {
    return permission;
  }
  static async requestPermission(): Promise<string> {
    permission = "granted";
    return permission;
  }
  closed = false;
  onclick?: () => void;
  readonly title: string;
  readonly body: string;
  readonly tag: string;
  constructor(title: string, options: { body?: string; tag?: string } = {}) {
    this.title = title;
    this.body = options.body ?? "";
    this.tag = options.tag ?? "";
    notices.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

const notices: FakeNotification[] = [];

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

class FakeWindow extends EventTarget {
  webkit: { messageHandlers: AnyRecord } | undefined;
  modelbotNative: unknown;
  focus(): void {
    focuses += 1;
  }
  open(): null {
    return null;
  }
}

const fakeWindow = new FakeWindow();
const sessionStore = new MemoryStorage();
const localStore = new MemoryStorage();

const focusState: {
  window: boolean;
  active: { tagName: string; id?: string; isContentEditable?: boolean } | null;
} = { window: false, active: null };

const fakeDocument = {
  title: "ModelBot",
  readyState: "complete",
  body: null as { tagName: string } | null,
  adoptedStyleSheets: [] as unknown[],
  querySelector: () => null,
  getElementById: () => null,
  addEventListener: () => {},
  get activeElement() {
    return focusState.active;
  },
  hasFocus() {
    return focusState.window;
  },
};

const fakeLocation = {
  href: "http://127.0.0.1:7804/",
  origin: "http://127.0.0.1:7804",
  protocol: "http:",
  host: "127.0.0.1:7804",
  search: "",
  hash: "",
};

/* --- a controllable WebSocket + fetch, for the watcher ------------------ */

type Socket = {
  url: string;
  listeners: Record<string, (event?: unknown) => void>;
  closed: boolean;
};
const sockets: Socket[] = [];

class FakeWebSocket {
  listeners: Record<string, (event?: unknown) => void> = {};
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    sockets.push(this as unknown as Socket);
  }
  addEventListener(name: string, fn: (event?: unknown) => void): void {
    this.listeners[name] = fn;
  }
  close(): void {
    this.closed = true;
  }
}

let approvals: unknown[] = [];
let takeovers: unknown[] = [];
let tasks: unknown[] = [];
let fetchCalls = 0;

globals["window"] = fakeWindow;
globals["document"] = fakeDocument;
globals["location"] = fakeLocation;
globals["sessionStorage"] = sessionStore;
globals["localStorage"] = localStore;
globals["Notification"] = FakeNotification;
globals["WebSocket"] = FakeWebSocket;
globals["fetch"] = async (input: string) => {
  fetchCalls += 1;
  const path = String(input);
  const body = path.includes("approvals")
    ? { approvals }
    : path.includes("takeovers")
      ? { takeovers }
      : { tasks };
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
};

const {
  attention,
  attentionFromApprovals,
  attentionFromTakeovers,
  externalUrl,
  liveAttention,
  modelbotNative,
  onNative,
  routeFromNotification,
} = await import("../../../src/ui/native.ts");
const { desktopAlerts } = await import("../../../src/ui/takeover-pings.ts");

function useBridge(): void {
  fakeWindow.webkit = {
    messageHandlers: {
      modelbot: {
        postMessage(message: { method: string; args: unknown }) {
          posted.push(message);
        },
      },
    },
  };
}

function noBridge(): void {
  fakeWindow.webkit = undefined;
}

function futureIso(ms = 60_000): string {
  return new Date(Date.now() + ms).toISOString();
}

beforeEach(() => {
  posted.length = 0;
  notices.length = 0;
  sockets.length = 0;
  approvals = [];
  takeovers = [];
  tasks = [];
  fetchCalls = 0;
  focuses = 0;
  permission = "granted";
  noBridge();
  fakeDocument.title = "ModelBot";
  fakeLocation.hash = "";
  focusState.window = false;
  focusState.active = null;
  sessionStore.clear();
  localStore.clear();
  attention.stop();
});

/* =========================================================================
 * The bridge
 * ====================================================================== */

describe("native bridge", () => {
  it("is not native and every method is a no-op without webkit.messageHandlers", () => {
    assert.equal(modelbotNative.isNative, false);

    // None of the five may throw, and none may reach a handler that isn’t there.
    modelbotNative.setBadge(3);
    modelbotNative.notify(
      "Your bot needs you.",
      "Open BotHearth and take control. The login is in the bot's browser, not in Arc.",
    );
    modelbotNative.setTitle("Finding last month’s invoice");
    modelbotNative.requestAttention(true);
    assert.equal(modelbotNative.openExternal("https://example.com/docs"), true);
    assert.equal(posted.length, 0, "nothing may be posted with no bridge present");
  });

  it("posts exactly the five contract methods once the handler exists", () => {
    useBridge();
    assert.equal(modelbotNative.isNative, true);

    modelbotNative.setBadge(2);
    modelbotNative.setBadge(0);
    modelbotNative.notify("Your bot needs you.", "It’s waiting for your OK.", "#/tasks/t_1");
    modelbotNative.setTitle("Renew the domain");
    modelbotNative.openExternal("https://orbstack.dev");
    modelbotNative.requestAttention(true);

    assert.deepEqual(
      posted.map((message) => message.method),
      ["setBadge", "setBadge", "notify", "setTitle", "openExternal", "requestAttention"],
    );
    assert.equal(posted[0]?.args, "2");
    assert.equal(posted[1]?.args, null, "a zero badge clears rather than showing 0");
    assert.deepEqual(posted[2]?.args, {
      id: "notify:#/tasks/t_1",
      title: "Your bot needs you.",
      body: "It’s waiting for your OK.",
      taskId: "#/tasks/t_1",
    });
    assert.deepEqual(posted[5]?.args, { critical: true });
    assert.equal(notices.length, 0, "the shell owns the banner in the native app");
  });

  it("falls back to a web notification when the shell could not show one", () => {
    useBridge();
    modelbotNative.notify("Your bot needs you.", "It’s waiting for your OK.", "#/tasks/t_9");
    assert.equal(notices.length, 0, "the shell was given the ping first");

    fakeWindow.dispatchEvent(
      new CustomEvent("modelbot:native", {
        detail: { kind: "notify-failed", notifyId: "notify:#/tasks/t_9" },
      }),
    );
    assert.equal(notices.length, 1, "an undelivered ping still reaches the person");
    assert.equal(notices[0]?.title, "Your bot needs you.");

    fakeWindow.dispatchEvent(
      new CustomEvent("modelbot:native", {
        detail: { kind: "notify-failed", notifyId: "notify:#/tasks/t_9" },
      }),
    );
    assert.equal(notices.length, 1, "the same ping is never shown twice");
  });

  it("openExternal refuses same-origin and anything that is not http(s)", () => {
    useBridge();
    for (const refused of [
      "http://127.0.0.1:7804/api/v1/tasks",
      "/#bootstrap=secret",
      "#/settings",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<b>x</b>",
      "modelbot://open",
      "",
    ]) {
      assert.equal(modelbotNative.openExternal(refused), false, refused);
      assert.equal(externalUrl(refused), null, refused);
    }
    assert.equal(posted.length, 0, "a refused URL never reaches the shell");

    for (const allowed of ["https://orbstack.dev", "http://example.com/help"]) {
      assert.equal(modelbotNative.openExternal(allowed), true, allowed);
    }
    assert.equal(posted.length, 2);
  });

  it("falls back to a tab-title badge in a browser", () => {
    fakeDocument.title = "ModelBot";
    modelbotNative.setBadge(2);
    assert.equal(fakeDocument.title, "(2) ModelBot");
    modelbotNative.setBadge(1);
    assert.equal(fakeDocument.title, "(1) ModelBot", "the count replaces, never stacks");
    modelbotNative.setBadge(0);
    assert.equal(fakeDocument.title, "ModelBot");
  });
});

/* =========================================================================
 * Shell -> page
 * ====================================================================== */

describe("shell events", () => {
  it("delivers each kind to its own listener and to the wildcard", () => {
    const seen: string[] = [];
    const offSettings = onNative("open-settings", () => seen.push("settings"));
    const offAll = onNative("*", (detail) => seen.push(`*${detail.kind ?? ""}`));

    fakeWindow.dispatchEvent(
      new CustomEvent("modelbot:native", { detail: { kind: "open-settings" } }),
    );
    fakeWindow.dispatchEvent(new CustomEvent("modelbot:native", { detail: { kind: "new-task" } }));
    assert.deepEqual(seen, ["settings", "*open-settings", "*new-task"]);

    offSettings();
    offAll();
    fakeWindow.dispatchEvent(
      new CustomEvent("modelbot:native", { detail: { kind: "open-settings" } }),
    );
    assert.equal(seen.length, 3, "unsubscribe stops delivery");
  });

  it("turns a notification click into a hash route, whichever form it arrives in", () => {
    assert.equal(routeFromNotification({ kind: "notification-click", taskId: "t_9" }), "#/tasks/t_9");
    assert.equal(routeFromNotification({ taskId: "#/tasks/t_9" }), "#/tasks/t_9");
    assert.equal(routeFromNotification({ route: "#/settings" }), "#/settings");
    assert.equal(routeFromNotification({ kind: "focus" }), null);
    assert.equal(routeFromNotification({ taskId: "" }), null);
  });
});

/* =========================================================================
 * The "your bot needs you" loop
 * ====================================================================== */

describe("attention — what is waiting on a person", () => {
  it("reads pending approvals and requested takeovers, and nothing else", () => {
    const rows = [
      { id: "a1", task_id: "t_1", status: "pending", bind_json: JSON.stringify({ expires: futureIso() }) },
      { id: "a2", task_id: "t_1", status: "allowed", bind_json: JSON.stringify({ expires: futureIso() }) },
      { id: "a3", task_id: "t_2", status: "pending", bind_json: JSON.stringify({ expires: "2000-01-01T00:00:00Z" }) },
      { id: "a4", task_id: null, status: "pending" },
    ];
    assert.deepEqual(
      attentionFromApprovals(rows).map((item) => item.id),
      ["a1", "a4"],
      "decided and expired approvals are not asks",
    );

    const takeoverRows = [
      { id: "k1", task_id: "t_3", state: "takeover_requested", expires_at: futureIso() },
      { id: "k2", task_id: "t_3", state: "human", expires_at: futureIso() },
      { id: "k3", task_id: "t_4", state: "resume_validating", expires_at: futureIso() },
      { id: "k4", task_id: "t_5", state: "takeover_requested", expires_at: "2000-01-01T00:00:00Z" },
    ];
    assert.deepEqual(
      attentionFromTakeovers(takeoverRows).map((item) => item.id),
      ["k1"],
      "already driving is not an ask, and an expired lease is not either",
    );
  });

  it("drops an ask whose own task has already ended", () => {
    const items = [
      { id: "k1", kind: "takeover" as const, taskId: "t_1", expiresAt: futureIso() },
      { id: "a1", kind: "approval" as const, taskId: "t_2", expiresAt: futureIso() },
      // No task_id at all: never dropped, since there is nothing to check it against.
      { id: "a2", kind: "approval" as const, taskId: null },
    ];
    const tasks = [
      { id: "t_1", status: "failed" },
      { id: "t_2", status: "running" },
    ];
    assert.deepEqual(
      liveAttention(items, tasks).map((item) => item.id),
      ["a1", "a2"],
      "a timed-out ask does not outlive the task it was raised for",
    );
    // No task list yet (the fetch failed, or this page has never asked): the
    // rows stand rather than being silently dropped for lack of information.
    assert.deepEqual(liveAttention(items, []).map((item) => item.id), ["k1", "a1", "a2"]);
  });

  it("announces once per request, badges the count, and closes what is answered", () => {
    const first = { id: "k1", kind: "takeover" as const, taskId: "t_1", expiresAt: futureIso() };
    const second = { id: "a1", kind: "approval" as const, taskId: "t_2", expiresAt: futureIso() };

    attention.sync([first]);
    attention.sync([first]);
    assert.equal(notices.length, 1, "a repeated sync must not repeat the alert");
    assert.equal(attention.count(), 1);
    assert.equal(fakeDocument.title, "(1) ModelBot");
    assert.equal(notices[0]?.title, "Your bot needs you.");
    assert.equal(
      notices[0]?.body,
      "Open BotHearth and take control. The login is in the bot's browser, not in Arc.",
    );

    attention.sync([first, second]);
    assert.equal(notices.length, 2);
    assert.equal(fakeDocument.title, "(2) ModelBot");
    assert.match(notices[1]?.body ?? "", /waiting for your OK/);

    attention.sync([second]);
    assert.equal(notices[0]?.closed, true, "an answered request must not sit on the desktop");
    assert.equal(notices[1]?.closed, false);
    assert.equal(fakeDocument.title, "(1) ModelBot");

    attention.clear();
    assert.equal(attention.count(), 0);
    assert.equal(fakeDocument.title, "ModelBot");
    assert.equal(notices[1]?.closed, true);
  });

  it("never puts task or page text on the desktop", () => {
    attention.sync([
      { id: "k9", kind: "takeover", taskId: "t_private", expiresAt: futureIso() },
    ]);
    const serialized = JSON.stringify(notices);
    assert.equal(serialized.includes("t_private"), false);
    assert.equal(serialized.includes("private"), false);
  });

  it("drops a request that expires without waiting for an event", () => {
    attention.sync([{ id: "k1", kind: "takeover", taskId: "t_1", expiresAt: "2000-01-01T00:00:00Z" }]);
    assert.equal(attention.count(), 0);
    assert.equal(notices.length, 0);
  });

  it("bounces the dock and notifies through the shell when it is native", () => {
    useBridge();
    attention.sync([{ id: "nk1", kind: "takeover", taskId: "t_7", expiresAt: futureIso() }]);
    const methods = posted.map((message) => message.method);
    // `setAttention` rides alongside the badge, because the badge
    // alone cannot tell the shell whether the bot is working or blocked.
    assert.deepEqual(methods, ["setBadge", "setAttention", "notify", "requestAttention"]);
    assert.deepEqual(posted[1]?.args, { waiting: 1 });
    assert.deepEqual((posted[2]?.args as AnyRecord)["taskId"], "#/tasks/t_7");
    assert.deepEqual(posted[3]?.args, { critical: true });
    assert.equal(notices.length, 0, "no web notification competes with the native banner");
  });

  it("opens the task on a fresh takeover even when the window has no document focus", () => {
    focusState.window = false;
    focusState.active = null;
    fakeLocation.hash = "#/";
    attention.sync([{ id: "k-idle", kind: "takeover", taskId: "t_1", expiresAt: futureIso() }]);
    assert.equal(fakeLocation.hash, "#/tasks/t_1");
    fakeLocation.hash = "#/";
    attention.sync([{ id: "k-idle", kind: "takeover", taskId: "t_1", expiresAt: futureIso() }]);
    assert.equal(fakeLocation.hash, "#/", "the same request must not navigate again");
  });

  it("does not steal the caret while an input is focused", () => {
    focusState.window = false;
    fakeLocation.hash = "#/";
    for (const active of [
      { tagName: "INPUT" },
      { tagName: "TEXTAREA" },
      { tagName: "DIV", isContentEditable: true },
    ]) {
      attention.clear();
      fakeLocation.hash = "#/";
      focusState.active = active;
      attention.sync([{ id: `k-${active.tagName}`, kind: "takeover", taskId: "t_1", expiresAt: futureIso() }]);
      assert.equal(fakeLocation.hash, "#/", active.tagName);
    }
  });

  it("opens the task from Home when a takeover arrives over the event stream", async () => {
    focusState.window = false;
    focusState.active = { tagName: "TEXTAREA", id: "home-goal" };
    fakeLocation.hash = "#/";
    tasks = [{ id: "t_run", status: "running" }];
    takeovers = [];

    const stop = attention.start();
    sockets[0]?.listeners["open"]?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fakeLocation.hash, "#/", "nothing waiting yet");

    takeovers = [
      { id: "tk_fresh", task_id: "t_run", state: "takeover_requested", expires_at: futureIso() },
    ];
    sockets[0]?.listeners["message"]?.({ data: JSON.stringify({ type: "takeover.requested" }) });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fakeLocation.hash, "#/tasks/t_run");

    fakeLocation.hash = "#/";
    sockets[0]?.listeners["message"]?.({ data: JSON.stringify({ type: "takeover.requested" }) });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fakeLocation.hash, "#/", "the same request must not navigate again");
    stop();
  });

  it("watches the event stream, reconciles from the two lists, and reconnects once", async () => {
    approvals = [{ id: "a1", task_id: "t_1", status: "pending", bind_json: JSON.stringify({ expires: futureIso() }) }];
    takeovers = [{ id: "k1", task_id: "t_1", state: "takeover_requested", expires_at: futureIso() }];

    const stop = attention.start();
    assert.equal(sockets.length, 1);
    assert.match(sockets[0]?.url ?? "", /^ws:\/\/127\.0\.0\.1:7804\/api\/v1\/events$/);

    sockets[0]?.listeners["open"]?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(attention.count(), 2, "one approval and one takeover both count");
    assert.equal(fetchCalls, 3, "approvals, takeovers and the tasks that own them");

    // An unrelated event must not cost a round-trip.
    const before = fetchCalls;
    sockets[0]?.listeners["message"]?.({ data: JSON.stringify({ type: "usage" }) });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fetchCalls, before, "only approval/takeover/task events reconcile");

    approvals = [];
    sockets[0]?.listeners["message"]?.({ data: JSON.stringify({ type: "approval.decided" }) });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(attention.count(), 1);

    sockets[0]?.listeners["close"]?.();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(sockets.length, 2, "a dropped stream reconnects exactly once");

    stop();
    assert.equal(sockets[1]?.closed, true);
  });

  it("clears the banner once the task a stale takeover names has failed", async () => {
    // The daemon timed the task out without anyone ever answering the
    // takeover request, so the row is still `takeover_requested` even though
    // the task it was raised for is done. Evidence: the S4 W5 screenshot,
    // task_17055be93b216b6c20cae7b6.
    takeovers = [{ id: "k1", task_id: "t_1", state: "takeover_requested", expires_at: futureIso() }];
    tasks = [{ id: "t_1", status: "failed" }];

    const stop = attention.start();
    sockets[0]?.listeners["open"]?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(attention.count(), 0, "the task's own status outranks the stale takeover row");
    stop();
  });

  it("start is idempotent — one socket however many callers ask", () => {
    attention.start();
    attention.start();
    assert.equal(sockets.length, 1);
    attention.stop();
  });
});

/* =========================================================================
 * Desktop alerts (browser half)
 * ====================================================================== */

describe("desktop alerts", () => {
  it("dedups across a reload, because the seen set is persisted for the tab", () => {
    const ping = {
      key: "takeover:d1",
      title: "Your bot needs you.",
      body: "Open BotHearth and take control. The login is in the bot's browser, not in Arc.",
      route: "#/tasks/t_1",
    };
    desktopAlerts.announce([ping]);
    assert.equal(notices.length, 1);
    assert.ok(sessionStore.getItem("modelbot.takeover-pings.seen"));

    desktopAlerts.announce([ping]);
    assert.equal(notices.length, 1);
  });

  it("opens the task on click, but not once the request has been answered", () => {
    const ping = {
      key: "takeover:d2",
      title: "Your bot needs you.",
      body: "Open BotHearth and take control. The login is in the bot's browser, not in Arc.",
      route: "#/tasks/t_2",
    };
    desktopAlerts.announce([ping]);
    fakeLocation.hash = "";
    notices[0]?.onclick?.();
    assert.equal(fakeLocation.hash, "#/tasks/t_2");
    assert.equal(focuses, 1);

    desktopAlerts.announce([]);
    fakeLocation.hash = "#/";
    notices[0]?.onclick?.();
    assert.equal(fakeLocation.hash, "#/", "a stale banner must not yank the person anywhere");
  });

  it("stays silent and unbroken when the browser has no Notification API", () => {
    const saved = globals["Notification"];
    delete globals["Notification"];
    try {
      assert.equal(desktopAlerts.permission(), "unsupported");
      desktopAlerts.announce([
        { key: "takeover:d3", title: "Your bot needs you.", body: "…", route: "#/" },
      ]);
      assert.equal(notices.length, 0);
    } finally {
      globals["Notification"] = saved;
    }
  });
});
