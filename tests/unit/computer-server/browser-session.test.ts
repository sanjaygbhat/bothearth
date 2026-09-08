import assert from "node:assert/strict";
import fs, {
  fstatSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  BrowserSession,
  clearStaleSingletons,
  launchWithLockRecovery,
} from "../../../computer-server/src/browser/session.ts";
import type { ServerState } from "../../../computer-server/src/dispatch.ts";
import { closeBrowser, installShutdown } from "../../../computer-server/src/rpc-loop.ts";
import { filesRead } from "../../../computer-server/src/shell/tools.ts";

it("quarantines one entry when the page listener and the click waiter see the same download", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mb-browser-ws-"));
  const quarantine = mkdtempSync(join(tmpdir(), "mb-browser-q-"));
  process.env.MODELBOT_WORKSPACE = workspace;
  process.env.MODELBOT_QUARANTINE = quarantine;

  let saves = 0;
  const download = {
    suggestedFilename: () => "one.txt",
    saveAs: async (path: string) => {
      saves += 1;
      writeFileSync(path, "one");
    },
  };
  let onDownload: ((download: typeof download) => void) | undefined;
  let resolveDownload: ((download: typeof download) => void) | undefined;
  const locator = {
    count: async () => 1,
    dblclick: async () => {},
    click: async () => {
      onDownload?.(download);
      resolveDownload?.(download);
    },
  };
  const page = {
    isClosed: () => false,
    locator: () => locator,
    getByRole: () => ({ nth: () => locator }),
    on: (event: string, listener: (download: typeof download) => void) => {
      if (event === "download") onDownload = listener;
    },
    waitForEvent: async () => await new Promise<typeof download>((resolve) => {
      resolveDownload = resolve;
    }),
  };
  const session = new BrowserSession();
  session.page = page as never;
  session.snaps.set("snap", {
    id: "snap",
    refs: new Set(["e1"]),
    bindings: new Map(),
    page: page as never,
  });
  session["wirePage"](page as never);

  const result = await session.click({
    snapshot_id: "snap",
    ref: "e1",
    button: "left",
    double_click: false,
  });

  assert.equal(result.ok, true);
  assert.equal(saves, 1);
  assert.equal(readdirSync(quarantine).length, 1);
  const listed = session.listQuarantine();
  assert.equal(listed.ok, true);
  if (listed.ok) {
    assert.equal((listed.data as { items: unknown[] }).items.length, 1);
  }
});

it("rejects an oversized file before reading and closes the fd when reading throws", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mb-browser-read-"));
  process.env.MODELBOT_WORKSPACE = workspace;
  const large = join(workspace, "large.bin");
  const small = join(workspace, "small.txt");
  writeFileSync(large, "");
  truncateSync(large, 1024 * 1024);
  writeFileSync(small, "small");

  const originalRead = fs.readFileSync;
  let reads = 0;
  let attemptedFd = -1;
  fs.readFileSync = ((fd: number) => {
    reads += 1;
    attemptedFd = fd;
    throw new Error("injected read failure");
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    const rejected = filesRead({ path: large, offset: null, limit: null });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, "E_LIMIT");
    assert.equal(reads, 0);

    const failed = filesRead({ path: small, offset: null, limit: null });
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.error.code, "E_IO");
    assert.equal(reads, 1);
  } finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
  }
  assert.throws(
    () => fstatSync(attemptedFd),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "EBADF",
  );
});

it("restarts the screencast after a popup becomes the live page", async () => {
  const pageA = { isClosed: () => false, on() {}, once() {} };
  const pageB = { isClosed: () => false, on() {}, once() {} };
  const pages = [pageA];
  const sent: string[] = [];
  const session = new BrowserSession();
  session.page = pageA as never;
  session.livePage = pageA as never;
  session.casting = true;
  session.cdp = { detach: async () => {} } as never;
  session.context = {
    pages: () => pages,
    newCDPSession: async () => ({
      on() {},
      detach: async () => {},
      send: async (method: string) => {
        sent.push(method);
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      },
    }),
  } as never;

  pages.push(pageB);
  await session["onContextPage"](pageB as never);

  assert.equal(session.livePage, pageB as never);
  assert.deepEqual(sent, ["Page.getFrameTree", "Fetch.enable", "Page.startScreencast"]);
});

it("leaves the tab count unchanged after a malformed new-tab URL", async () => {
  const pages = [{ isClosed: () => false }];
  let newPages = 0;
  const session = new BrowserSession();
  session.context = {
    pages: () => pages,
    newPage: async () => {
      newPages += 1;
      const page = { isClosed: () => false };
      pages.push(page);
      return page;
    },
  } as never;

  const before = pages.length;
  const result = await session.tabs({ action: "new", tab_id: null, url: "not a URL" });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "E_POLICY");
  assert.equal(pages.length, before);
  assert.equal(newPages, 0);
});

it("a frame waiting for its CDP acknowledgement cannot cross a control transition", async () => {
  let acknowledge!: () => void;
  const ack = new Promise<void>((resolve) => { acknowledge = resolve; });
  let frame!: (event: { sessionId: number; data: string; metadata: object }) => Promise<void>;
  const cdp = { async detach() {}, on(_name: string, callback: typeof frame) { frame = callback; },
    async send(method: string) { if (method === "Page.screencastFrameAck") await ack; } };
  const session = new BrowserSession();
  session.context = { newCDPSession: async () => cdp } as never;
  await session.attachCdp({} as never);
  session.casting = true;
  const modes: string[] = [];
  session.onLiveFrame = (header) => { modes.push(header.mode); };
  const event = { sessionId: 1, data: "AQID", metadata: {} };
  const pending = frame(event);
  session.setLiveMode("human", true);
  acknowledge();
  await pending;
  assert.deepEqual(modes, [], "old agent pixels must not be relabeled as HUMAN");
  await frame(event);
  assert.deepEqual(modes, [], "a late event from the old subscription must also be discarded");
  await session.attachCdp({} as never);
  await frame(event);
  assert.deepEqual(modes, ["human"]);
});

it("removes the profile lock a dead Chromium left behind, and keeps a live one", () => {
  const profile = mkdtempSync(join(tmpdir(), "mb-singleton-"));
  const lock = join(profile, "SingletonLock");
  for (const name of ["SingletonSocket", "SingletonCookie"]) {
    writeFileSync(join(profile, name), "");
  }
  symlinkSync("f8305084b27f-32", lock);

  clearStaleSingletons(profile);
  assert.deepEqual(readdirSync(profile), [], "a lock from a container that is gone must go");

  // The owner named by the link is this process: alive, so the lock stands.
  symlinkSync(`${hostname()}-${process.pid}`, lock);
  clearStaleSingletons(profile);
  assert.deepEqual(readdirSync(profile), ["SingletonLock"]);
});

it("clears the lock and retries once when Chromium reports the profile in use", async () => {
  const profile = mkdtempSync(join(tmpdir(), "mb-relaunch-"));
  symlinkSync(`${hostname()}-${process.pid}`, join(profile, "SingletonLock"));
  writeFileSync(join(profile, "SingletonSocket"), "");

  let attempts = 0;
  const context = await launchWithLockRecovery(profile, async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error(
        "browserType.launchPersistentContext: Failed to create a ProcessSingleton for your profile directory. This usually means that the profile is already in use by another instance of Chromium.",
      );
    }
    return "context";
  });
  assert.equal(context, "context");
  assert.equal(attempts, 2);
  assert.deepEqual(readdirSync(profile), []);

  await assert.rejects(
    launchWithLockRecovery(profile, async () => {
      throw new Error("profile appears to be in use by another Chromium process");
    }),
    (error: Error) =>
      /still says so after SingletonLock, SingletonSocket, SingletonCookie were removed/.test(error.message) &&
      error.message.includes(profile),
  );

  // An unrelated failure is not a lock problem: surface it as it came.
  await assert.rejects(
    launchWithLockRecovery(profile, async () => { throw new Error("no such executable"); }),
    { message: "no such executable" },
  );
});

it("closes the browser on SIGTERM before the process exits, and does not wait forever", async () => {
  let closed = false;
  let exited: number | null = null;
  const state = {
    browser: { abortActs: () => {}, close: async () => { closed = true; } },
  } as unknown as ServerState;
  const beforeTerm = process.listeners("SIGTERM");
  const spare = { SIGINT: process.listeners("SIGINT"), SIGHUP: process.listeners("SIGHUP") };
  installShutdown(state, (code) => { exited = code; });
  process.emit("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, true, "Chromium must clean up its own lock before we die");
  assert.equal(exited, 0);
  assert.deepEqual(
    process.listeners("SIGTERM"),
    beforeTerm,
    "the handler is spent: a second signal takes the default action",
  );
  for (const [signal, before] of Object.entries(spare)) {
    for (const listener of process.listeners(signal)) {
      if (!before.includes(listener)) process.removeListener(signal, listener);
    }
  }

  const stuck = { abortActs: () => {}, close: () => new Promise<void>(() => {}) };
  const started = Date.now();
  await closeBrowser({ browser: stuck } as unknown as ServerState, 20);
  assert.ok(Date.now() - started < 1000, "a hung close must not hold the shutdown open");
});
