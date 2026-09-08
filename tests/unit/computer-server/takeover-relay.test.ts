import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_TABS,
  chooseLivePage,
} from "../../../computer-server/src/browser/live-page.ts";
import {
  BrowserSession,
  actWithSignal,
} from "../../../computer-server/src/browser/session.ts";
import { createState, dispatch } from "../../../computer-server/src/dispatch.ts";

function page(closed: boolean) {
  return { isClosed: () => closed };
}

describe("chooseLivePage", () => {
  it("returns last non-closed page", () => {
    const a = page(false);
    const b = page(true);
    const c = page(false);
    assert.equal(chooseLivePage([a, b, c]), c);
    assert.equal(chooseLivePage([a, b]), a);
    assert.equal(chooseLivePage([b]), undefined);
    assert.equal(chooseLivePage([]), undefined);
    assert.equal(MAX_TABS, 5);
  });
});

describe("actWithSignal", () => {
  it("aborted signal prevents the Playwright call", async () => {
    const ac = new AbortController();
    ac.abort();
    let called = false;
    await assert.rejects(
      () =>
        actWithSignal(ac.signal, async () => {
          called = true;
        }),
      (err: unknown) => {
        assert.equal((err as Error).name, "AbortError");
        return true;
      },
    );
    assert.equal(called, false);
  });
});

type FakeLocator = {
  click(opts?: unknown): Promise<void>;
  dblclick(opts?: unknown): Promise<void>;
  count(): Promise<number>;
};

function delayedClickLocator(ms: number, log: string[], tag: string): FakeLocator {
  return {
    async click() {
      log.push(`${tag}:start`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${tag}:done`);
    },
    async dblclick() {},
    async count() {
      return 1;
    },
  };
}

function instantLocator(log: string[], tag: string): FakeLocator {
  return {
    async click() {
      log.push(`${tag}:click`);
    },
    async dblclick() {},
    async count() {
      return 1;
    },
  };
}

function fakePage(id: string, loc: FakeLocator) {
  return {
    id,
    isClosed: () => false,
    url: () => `https://${id}.example/`,
    title: async () => id,
    locator: () => loc,
    getByRole: () => ({ nth: () => loc }),
    waitForEvent: async () => {
      throw new Error("no download");
    },
    keyboard: {
      press: async () => {},
      insertText: async () => {},
    },
    mouse: {
      move: async () => {},
      click: async () => {},
      dblclick: async () => {},
      down: async () => {},
      up: async () => {},
      wheel: async () => {},
    },
    on: () => {},
    once: () => {},
    close: async () => {},
    bringToFront: async () => {},
    viewportSize: () => ({ width: 1280, height: 720 }),
  };
}

function fakeCdp() {
  return {
    on() {},
    async send(method: string) {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    },
    async detach() {},
  };
}

describe("takeover grant waits for in-flight click", () => {
  it("grant ack resolves after 200ms click settles; second click after abort is refused", async () => {
    const log: string[] = [];
    const loc = delayedClickLocator(200, log, "a");
    const pageA = fakePage("A", loc);
    const session = new BrowserSession();
    session.page = pageA as never;
    session.livePage = pageA as never;
    session.snaps.set("snap_1", {
      id: "snap_1",
      refs: new Set(["e1"]),
      bindings: new Map(),
      page: pageA as never,
    });

    const state = createState("browser");
    state.browser = session;
    state.takeover.state = "agent";

    const clickP = session.click({
      snapshot_id: "snap_1",
      ref: "e1",
      button: "left",
      double_click: false,
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(log.includes("a:start"));
    assert.equal(log.includes("a:done"), false);

    state.takeover.state = "takeover_requested";
    let clickDoneAtGrant = false;
    const grantP = dispatch(state, {
      jsonrpc: "2.0",
      id: 1,
      method: "takeover.grant",
      params: {},
    }).then((res) => {
      clickDoneAtGrant = log.includes("a:done");
      return res;
    });

    const clickRes = await clickP;
    const grantRes = await grantP;
    assert.equal(clickRes.ok, true);
    assert.equal(grantRes.ok, true);
    assert.equal(clickDoneAtGrant, true);
    assert.ok(log.includes("a:done"));

    await assert.rejects(
      () =>
        session.click({
          snapshot_id: "snap_1",
          ref: "e1",
          button: "left",
          double_click: false,
        }),
      (err: unknown) => {
        assert.equal((err as Error).name, "AbortError");
        return true;
      },
    );

    const viaDispatch = await dispatch(state, {
      jsonrpc: "2.0",
      id: 2,
      method: "browser_click",
      params: {
        snapshot_id: "snap_1",
        ref: "e1",
        button: "left",
        double_click: false,
      },
    });
    assert.equal(viaDispatch.ok, false);
    if (!viaDispatch.ok) assert.equal(viaDispatch.error.code, "E_TAKEOVER_BUSY");
  });
});

describe("livePage vs action page", () => {
  it("snapshot on A, popup B, click(ref) runs on A; live view follows B", async () => {
    const log: string[] = [];
    const locA = instantLocator(log, "A");
    const locB = instantLocator(log, "B");
    const pageA = fakePage("A", locA);
    const pageB = fakePage("B", locB);
    const opened: unknown[] = [pageA];
    const session = new BrowserSession();
    session.page = pageA as never;
    session.livePage = pageA as never;
    session.context = {
      pages: () => opened,
      newCDPSession: async () => fakeCdp(),
    } as never;
    session.snaps.set("snap_a", {
      id: "snap_a",
      refs: new Set(["e1"]),
      bindings: new Map(),
      page: pageA as never,
    });

    opened.push(pageB);
    await (
      session as unknown as { onContextPage(p: unknown): Promise<void> }
    ).onContextPage(pageB);

    assert.equal(session.page, pageA as never);
    assert.equal(session.livePage, pageB as never);

    const clicked = await session.click({
      snapshot_id: "snap_a",
      ref: "e1",
      button: "left",
      double_click: false,
    });
    assert.equal(clicked.ok, true);
    assert.deepEqual(log, ["A:click"]);
  });
});

describe("relay live.key vs agent computer_key", () => {
  it("HUMAN live.key and agent computer_key use native keyboard with takeover gating", async () => {
    const presses: string[] = [];
    const cdp: Array<{ method: string; params: Record<string, unknown> }> = [];
    const session = new BrowserSession();
    session.page = {
      isClosed: () => false,
      bringToFront: async () => {},
      keyboard: {
        press: async (key: string) => {
          presses.push(key);
        },
      },
    } as never;
    session.cdp = {
      send: async (method: string, params?: Record<string, unknown>) => {
        cdp.push({ method, params: params ?? {} });
      },
    } as never;

    const state = createState("browser");
    state.browser = session;
    state.takeover.state = "human";

    const live = await dispatch(state, {
      jsonrpc: "2.0",
      id: 1,
      method: "live.key",
      params: { key: "Backspace", mods: null, epoch: state.takeover.epoch },
    });
    assert.equal(live.ok, true);
    assert.deepEqual(presses, ["Backspace"]);
    presses.length = 0;

    const agent = await dispatch(state, {
      jsonrpc: "2.0",
      id: 2,
      method: "computer_key",
      params: { key: "Backspace", mods: null },
    });
    assert.equal(agent.ok, false);
    assert.equal(presses.length, 0);

    state.takeover.state = "agent";
    const agentOk = await dispatch(state, {
      jsonrpc: "2.0",
      id: 3,
      method: "computer_key",
      params: { key: "a", mods: 2 },
    });
    assert.equal(agentOk.ok, true);
    assert.deepEqual(presses, ["Control+a"]);
    const after = cdp.filter((c) => c.method === "Input.dispatchKeyEvent").length;
    assert.equal(after, 0);
  });

});

type RelayPage = ReturnType<typeof relayPage>;

function relayPage(
  id: string,
  typed: string[] = [],
  sensitive = 0,
  isClosed = () => false,
) {
  return {
    id,
    isClosed,
    on: () => {},
    once: () => {},
    close: async () => {},
    bringToFront: async () => {},
    // `maskSecrets` marks in the page and reports what it marked.
    evaluate: async () =>
      Array.from({ length: sensitive }, () => ({ kind: "password", label: "Passwd" })),
    locator: () => ({ count: async () => sensitive }),
    keyboard: {
      insertText: async (text: string) => {
        typed.push(text);
      },
    },
    mouse: {
      move: async () => {},
      down: async () => {
        typed.push("mouse:down");
      },
      up: async () => {},
    },
    viewportSize: () => ({ width: 1280, height: 720 }),
  };
}

describe("takeover relay targeting", () => {
  it("binds A before a pre-grant popup B and relays only to A", async () => {
    const typedA: string[] = [];
    const typedB: string[] = [];
    const pageA = relayPage("A", typedA);
    const pageB = relayPage("B", typedB);
    const opened: RelayPage[] = [pageA];
    const session = new BrowserSession();
    session.page = pageA as never;
    session.livePage = pageA as never;
    session.context = {
      pages: () => opened,
      newCDPSession: async () => ({
        on() {},
        async send(method: string) {
          if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
        },
        async detach() {},
      }),
    } as never;
    const state = createState("browser");
    state.browser = session;

    const requested = await dispatch(state, {
      jsonrpc: "2.0",
      id: 1,
      method: "request_takeover",
      params: { reason: "password" },
    });
    assert.equal(requested.ok, true);

    opened.push(pageB);
    await (session as unknown as { onContextPage(page: RelayPage): Promise<void> })
      .onContextPage(pageB);
    assert.equal(session.livePage, pageB as never);

    const granted = await dispatch(state, {
      jsonrpc: "2.0",
      id: 2,
      method: "takeover.grant",
      params: {},
    });
    assert.equal(granted.ok, true);
    assert.equal(session.relayPage, pageA as never);

    const relayed = await dispatch(state, {
      jsonrpc: "2.0",
      id: 3,
      method: "live.text",
      params: { text: "secret", epoch: state.takeover.epoch },
    });
    assert.equal(relayed.ok, true);
    assert.deepEqual(typedA, ["secret"]);
    assert.deepEqual(typedB, []);
  });

  it("fails closed when the request-bound page is gone", async () => {
    let closedA = false;
    const typedB: string[] = [];
    const pageA = relayPage("A", [], 0, () => closedA);
    const pageB = relayPage("B", typedB);
    const session = new BrowserSession();
    session.page = pageA as never;
    session.livePage = pageB as never;
    const state = createState("browser");
    state.browser = session;

    const requested = await dispatch(state, {
      jsonrpc: "2.0",
      id: 1,
      method: "request_takeover",
      params: { reason: "password" },
    });
    assert.equal(requested.ok, true);
    closedA = true;
    const granted = await dispatch(state, {
      jsonrpc: "2.0",
      id: 2,
      method: "takeover.grant",
      params: {},
    });
    assert.equal(granted.ok, true);

    const relayed = await dispatch(state, {
      jsonrpc: "2.0",
      id: 3,
      method: "live.text",
      params: { text: "secret", epoch: state.takeover.epoch },
    });
    assert.equal(relayed.ok, false);
    if (!relayed.ok) assert.equal(relayed.error.code, "E_IO");
    assert.deepEqual(typedB, []);
  });

  it("freezes HUMAN relay target when a popup opens", async () => {
    const typedA: string[] = [];
    const typedB: string[] = [];
    const pageA = relayPage("A", typedA);
    const pageB = relayPage("B", typedB);
    const opened: RelayPage[] = [pageA];
    const session = new BrowserSession();
    session.page = pageA as never;
    session.livePage = pageA as never;
    session.context = {
      pages: () => opened,
      newCDPSession: async () => ({
        on() {},
        async send(method: string) {
          if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
        },
        async detach() {},
      }),
    } as never;
    const state = createState("browser");
    state.browser = session;
    await dispatch(state, {
      jsonrpc: "2.0",
      id: 1,
      method: "takeover.sync",
      params: { takeover_id: "tk_freeze", expires_at: new Date().toISOString() },
    });
    const granted = await dispatch(state, {
      jsonrpc: "2.0",
      id: 2,
      method: "takeover.grant",
      params: {},
    });
    assert.equal(granted.ok, true);

    opened.push(pageB);
    await (session as unknown as { onContextPage(page: RelayPage): Promise<void> })
      .onContextPage(pageB);

    session.cdp = { send: async () => {} } as never;
    const pointer = await dispatch(state, {
      jsonrpc: "2.0",
      id: 3,
      method: "live.pointer",
      params: { kind: "down", x: 850, y: 325, button: 0, epoch: state.takeover.epoch },
    });
    assert.equal(pointer.ok, true);

    const result = await dispatch(state, {
      jsonrpc: "2.0",
      id: 4,
      method: "live.text",
      params: { text: "secret", epoch: state.takeover.epoch },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(typedA, ["mouse:down", "secret"]);
    assert.deepEqual(typedB, []);
    assert.equal(session.livePage, pageA as never);
  });

  it("rejects relay outside HUMAN and with a stale epoch", async () => {
    const state = createState("browser");
    const outside = await dispatch(state, {
      jsonrpc: "2.0",
      id: 1,
      method: "live.text",
      params: { text: "x", epoch: state.takeover.epoch },
    });
    assert.equal(outside.ok, false);
    if (!outside.ok) assert.equal(outside.error.code, "E_TAKEOVER_BUSY");

    state.takeover.state = "human";
    const stale = await dispatch(state, {
      jsonrpc: "2.0",
      id: 2,
      method: "live.key",
      params: { key: "a", epoch: state.takeover.epoch - 1 },
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, "E_TAKEOVER_BUSY");
  });

  it("masks and counts sensitive fields across all open pages", async () => {
    const action = relayPage("action", [], 1);
    const live = relayPage("live", [], 0);
    const session = new BrowserSession();
    session.page = action as never;
    session.livePage = live as never;
    session.context = { pages: () => [action, live] } as never;
    const state = createState("browser");
    state.browser = session;
    state.takeover.state = "resume_validating";
    const result = await dispatch(state, {
      jsonrpc: "2.0",
      id: 1,
      method: "takeover.masked-observation",
      params: {},
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal((result.data as { still_sensitive: boolean }).still_sensitive, true);
    }
  });

  it("binds native key input to the frozen relay page", async () => {
    const sent: string[] = [];
    const relay = { ...relayPage("relay"), keyboard: { press: async (key: string) => { sent.push(key); } } };
    const stale = { ...relayPage("stale"), keyboard: { press: async () => assert.fail("key sent to stale page") } };
    const session = new BrowserSession();
    session.page = relay as never;
    session.livePage = stale as never;
    session.setLiveMode("human");
    assert.equal((await session.liveKey({ key: "a", mods: 0 })).ok, true);
    assert.deepEqual(sent, ["a"]);
  });

  it("rejects pointer kinds outside the frozen contract", async () => {
    const state = createState("browser");
    state.takeover.state = "human";
    const result = await dispatch(state, {
      jsonrpc: "2.0",
      id: 1,
      method: "live.pointer",
      params: { kind: "click", x: 1, y: 1, epoch: state.takeover.epoch },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "E_IO");
  });
});
