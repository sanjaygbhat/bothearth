import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BrowserSession } from "../../../computer-server/src/browser/session.ts";

const STALE_MSG = "The page changed — take a new snapshot and continue.";

function actPage(opts: {
  count: number | (() => Promise<number>);
  click?: () => Promise<void>;
  fill?: () => Promise<void>;
}) {
  let clicked = 0;
  const locator = {
    count: typeof opts.count === "function" ? opts.count : async () => opts.count,
    dblclick: async () => {},
    click: async () => {
      clicked += 1;
      if (opts.click) return opts.click();
    },
    fill: opts.fill ?? (async () => {}),
    pressSequentially: async () => {},
    press: async () => {},
  };
  const page = {
    isClosed: () => false,
    url: () => "http://127.0.0.1/next",
    title: async () => "Next",
    locator: () => locator,
    getByRole: () => ({ nth: () => locator }),
    on() {},
    waitForEvent: async () => new Promise(() => {}),
  };
  const session = new BrowserSession();
  session.page = page as never;
  session.snaps.set("snap_old", {
    id: "snap_old",
    refs: new Set(["e1"]),
    bindings: new Map(),
    page: page as never,
  });
  session.snapshot = async () => ({
    ok: true,
    data: {
      snapshot_id: "snap_new",
      yaml: '- button "Done" [ref=e2]',
      truncated: false,
      refs: ["e2"],
      url: "http://127.0.0.1/next",
      title: "Next",
    },
  });
  return { session, locator, clicked: () => clicked };
}

describe("stale ref after navigation", () => {
  it("pre-action miss of an old ref is E_STALE_REF with a snapshot, not a 30s click wait", async () => {
    let hang = 0;
    const { session, clicked } = actPage({
      count: 0,
      click: async () => {
        hang += 1;
      },
    });
    const started = Date.now();
    const stale = await session.click({
      snapshot_id: "snap_old",
      ref: "e1",
      button: "left",
      double_click: false,
    });
    const elapsed = Date.now() - started;
    assert.equal(stale.ok, false, `expected stale, got ${JSON.stringify(stale)}`);
    if (stale.ok) return;
    assert.equal(stale.error.code, "E_STALE_REF");
    assert.notEqual(stale.error.code, "E_IO");
    assert.equal(stale.error.message, STALE_MSG);
    assert.match(stale.error.message, /take a new snapshot and continue/);
    const details = stale.error.details ?? {};
    assert.equal(details.retry, "browser_snapshot");
    assert.equal(details.url, "http://127.0.0.1/next");
    assert.equal(details.title, "Next");
    assert.equal(details.snapshot_id, "snap_new");
    assert.notEqual(details.snapshot_id, "snap_old");
    assert.equal(details.yaml, '- button "Done" [ref=e2]');
    assert.deepEqual(details.refs, ["e2"]);
    assert.equal(clicked(), 0);
    assert.equal(hang, 0);
    assert.ok(elapsed < 500, `stale ref took ${elapsed}ms`);
  });

  async function assertResolveCountStale(message: string) {
    let hang = 0;
    const { session, clicked } = actPage({
      count: async () => {
        throw new Error(message);
      },
      click: async () => {
        hang += 1;
      },
    });
    const stale = await session.click({
      snapshot_id: "snap_old",
      ref: "e1",
      button: "left",
      double_click: false,
    });
    assert.equal(stale.ok, false, `expected stale, got ${JSON.stringify(stale)}`);
    if (stale.ok) return;
    assert.equal(stale.error.code, "E_STALE_REF");
    assert.notEqual(stale.error.code, "E_IO");
    assert.equal(stale.error.message, STALE_MSG);
    assert.equal(clicked(), 0);
    assert.equal(hang, 0);
  }

  it("resolve-time count throw of execution context destroyed is E_STALE_REF", async () => {
    await assertResolveCountStale(
      "Execution context was destroyed, most likely because of a navigation.",
    );
  });

  it("resolve-time count throw of not attached is E_STALE_REF", async () => {
    await assertResolveCountStale("locator.count: Element is not attached to the DOM");
  });

  it("resolve-time count throw of no longer matched is E_STALE_REF", async () => {
    await assertResolveCountStale("locator is no longer matched");
  });

  it("click that throws execution context destroyed is E_IO", async () => {
    const { session, clicked } = actPage({
      count: 1,
      click: async () => {
        throw new Error("Execution context was destroyed, most likely because of a navigation.");
      },
    });
    const started = Date.now();
    const click = await session.click({
      snapshot_id: "snap_old",
      ref: "e1",
      button: "left",
      double_click: false,
    });
    const elapsed = Date.now() - started;
    assert.equal(click.ok, false, `expected E_IO, got ${JSON.stringify(click)}`);
    if (click.ok) return;
    assert.equal(click.error.code, "E_IO");
    assert.notEqual(click.error.code, "E_STALE_REF");
    assert.match(click.error.message, /execution context was destroyed/i);
    assert.equal(clicked(), 1);
    assert.ok(elapsed < 500, `act-path E_IO took ${elapsed}ms`);
  });

  it("type locator teardown after a miss-mapped act is E_IO", async () => {
    const { session } = actPage({
      count: 1,
      fill: async () => {
        throw new Error("locator.fill: Element is not attached to the DOM");
      },
    });
    const typed = await session.type({
      snapshot_id: "snap_old",
      ref: "e1",
      text: "hi",
      submit: false,
      slowly: false,
    });
    assert.equal(typed.ok, false, `expected E_IO, got ${JSON.stringify(typed)}`);
    if (typed.ok) return;
    assert.equal(typed.error.code, "E_IO");
    assert.notEqual(typed.error.code, "E_STALE_REF");
  });

  it("native runner prompt says E_STALE_REF is not takeover", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
    const src = readFileSync(join(root, "src/daemon/codex-runner.ts"), "utf8");
    assert.match(src, /take a new snapshot and continue/);
  });
});
