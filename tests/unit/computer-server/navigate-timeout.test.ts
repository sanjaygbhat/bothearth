import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { chromiumAvailable } from "../../../computer-server/src/browser/session.ts";
import { createState, dispatch } from "../../../computer-server/src/dispatch.ts";

const hasChromium = await chromiumAvailable().catch(() => false);
if (process.env.MODELBOT_TEST_REQUIRE_HOST_BROWSER === "1") {
  assert.ok(hasChromium, "Required host Chromium is unavailable");
}

describe("browser_navigate hanging subresource", () => {
  it("default wait returns before load; explicit load times out without wedging snapshot", {
    skip: !hasChromium && "Host Chromium unavailable; real-image tests remain required",
    timeout: 40_000,
  }, async (t) => {
    process.env.MODELBOT_WORKSPACE = mkdtempSync(join(tmpdir(), "mb-navto-ws-"));
    process.env.MODELBOT_PROFILE = mkdtempSync(join(tmpdir(), "mb-navto-pf-"));
    process.env.MODELBOT_QUARANTINE = mkdtempSync(join(tmpdir(), "mb-navto-q-"));
    process.env.MODELBOT_PROXY_SERVER = "http://127.0.0.1:9";
    process.env.MODELBOT_PROXY_BYPASS = "127.0.0.1";

    const hanging = new Set<ServerResponse>();
    const fixture = createServer((req, res) => {
      if (req.url === "/slow.gif") {
        hanging.add(res);
        res.writeHead(200, { "Content-Type": "image/gif" });
        return;
      }
      res.setHeader("Content-Type", "text/html");
      res.end(
        "<!doctype html><html><head><title>hang-fixture</title></head>" +
          '<body><h1>ready</h1><img src="/slow.gif" alt="slow"></body></html>',
      );
    });
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const address = fixture.address();
    assert.ok(address && typeof address === "object");
    const target = `http://127.0.0.1:${address.port}/`;
    const state = createState("browser");
    t.after(async () => {
      await state.browser?.close();
      for (const res of hanging) res.end();
      hanging.clear();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    });

    // Warm Chromium so the 8s bound is navigate, not launch.
    const warm = await dispatch(state, {
      jsonrpc: "2.0",
      id: 0,
      method: "browser_tabs",
      params: { action: "list" },
    });
    assert.equal(warm.ok, true);

    const dclStarted = Date.now();
    const dcl = await dispatch(state, {
      jsonrpc: "2.0",
      id: 1,
      method: "browser_navigate",
      params: { url: target, wait_until: null },
    });
    const dclMs = Date.now() - dclStarted;
    assert.equal(dcl.ok, true, `default navigate failed in ${dclMs}ms`);
    assert.ok(dclMs < 8_000, `default navigate took ${dclMs}ms, want < 8000`);
    if (!dcl.ok) return;
    const dclData = dcl.data as { url: string };
    assert.ok(
      dclData.url.includes(`127.0.0.1:${address.port}`),
      `default navigate url was ${dclData.url}`,
    );

    const loadStarted = Date.now();
    const load = await dispatch(state, {
      jsonrpc: "2.0",
      id: 2,
      method: "browser_navigate",
      params: { url: target, wait_until: "load" },
    });
    const loadMs = Date.now() - loadStarted;
    assert.ok(loadMs <= 16_000, `load navigate took ${loadMs}ms, want ≤ 16000`);
    assert.equal(load.ok, true, `load navigate failed in ${loadMs}ms`);
    if (!load.ok) return;
    const loadData = load.data as {
      url: string;
      title: string;
      timed_out?: boolean;
      wait_until?: string;
    };
    assert.equal(loadData.timed_out, true);
    assert.equal(loadData.wait_until, "load");
    assert.ok(
      loadData.url.includes(`127.0.0.1:${address.port}`),
      `load navigate url was ${loadData.url}`,
    );

    const snapStarted = Date.now();
    const snap = await Promise.race([
      dispatch(state, {
        jsonrpc: "2.0",
        id: 3,
        method: "browser_snapshot",
        params: {
          scope: null,
          interactive_only: true,
          depth: null,
          max_chars: 8000,
        },
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("snapshot hung after timed-out load navigate")), 8_000);
      }),
    ]);
    const snapMs = Date.now() - snapStarted;
    assert.equal(snap.ok, true, `snapshot after timed-out load failed in ${snapMs}ms`);
  });

  it("same-host stale URL on timeout is an error, not a committed ok", {
    skip: !hasChromium && "Host Chromium unavailable; real-image tests remain required",
    timeout: 40_000,
  }, async (t) => {
    process.env.MODELBOT_WORKSPACE = mkdtempSync(join(tmpdir(), "mb-navto-ws-"));
    process.env.MODELBOT_PROFILE = mkdtempSync(join(tmpdir(), "mb-navto-pf-"));
    process.env.MODELBOT_QUARANTINE = mkdtempSync(join(tmpdir(), "mb-navto-q-"));
    process.env.MODELBOT_PROXY_SERVER = "http://127.0.0.1:9";
    process.env.MODELBOT_PROXY_BYPASS = "127.0.0.1";

    const hanging = new Set<ServerResponse>();
    const fixture = createServer((req, res) => {
      if (req.url === "/hang") {
        hanging.add(res);
        return;
      }
      res.setHeader("Content-Type", "text/html");
      res.end("<!doctype html><html><head><title>ready</title></head><body>ready</body></html>");
    });
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const address = fixture.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const state = createState("browser");
    t.after(async () => {
      await state.browser?.close();
      for (const res of hanging) res.end();
      hanging.clear();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    });

    const warm = await dispatch(state, {
      jsonrpc: "2.0",
      id: 0,
      method: "browser_tabs",
      params: { action: "list" },
    });
    assert.equal(warm.ok, true);

    const ready = await dispatch(state, {
      jsonrpc: "2.0",
      id: 1,
      method: "browser_navigate",
      params: { url: `${origin}/`, wait_until: null },
    });
    assert.equal(ready.ok, true, "setup navigate to same-host page failed");

    const hangStarted = Date.now();
    const hang = await dispatch(state, {
      jsonrpc: "2.0",
      id: 2,
      method: "browser_navigate",
      params: { url: `${origin}/hang`, wait_until: null },
    });
    const hangMs = Date.now() - hangStarted;
    assert.ok(hangMs <= 18_000, `stale-url navigate took ${hangMs}ms, want ≤ 18000`);
    assert.equal(hang.ok, false, `same-host hang returned ok with ${JSON.stringify(hang)}`);
    if (hang.ok) return;
    assert.equal(hang.error.code, "E_IO");

    const snap = await Promise.race([
      dispatch(state, {
        jsonrpc: "2.0",
        id: 3,
        method: "browser_snapshot",
        params: {
          scope: null,
          interactive_only: true,
          depth: null,
          max_chars: 8000,
        },
      }),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("snapshot hung after uncommitted navigate timeout")),
          8_000,
        );
      }),
    ]);
    assert.equal(snap.ok, true, "snapshot after uncommitted timeout failed");
  });

  it("missing cdp still returns within the timeout bound", {
    skip: !hasChromium && "Host Chromium unavailable; real-image tests remain required",
    timeout: 40_000,
  }, async (t) => {
    process.env.MODELBOT_WORKSPACE = mkdtempSync(join(tmpdir(), "mb-navto-ws-"));
    process.env.MODELBOT_PROFILE = mkdtempSync(join(tmpdir(), "mb-navto-pf-"));
    process.env.MODELBOT_QUARANTINE = mkdtempSync(join(tmpdir(), "mb-navto-q-"));
    process.env.MODELBOT_PROXY_SERVER = "http://127.0.0.1:9";
    process.env.MODELBOT_PROXY_BYPASS = "127.0.0.1";

    const hanging = new Set<ServerResponse>();
    const fixture = createServer((req, res) => {
      if (req.url === "/slow.gif") {
        hanging.add(res);
        res.writeHead(200, { "Content-Type": "image/gif" });
        return;
      }
      res.setHeader("Content-Type", "text/html");
      res.end(
        "<!doctype html><html><head><title>hang-fixture</title></head>" +
          '<body><h1>ready</h1><img src="/slow.gif" alt="slow"></body></html>',
      );
    });
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const address = fixture.address();
    assert.ok(address && typeof address === "object");
    const target = `http://127.0.0.1:${address.port}/`;
    const state = createState("browser");
    t.after(async () => {
      await state.browser?.close();
      for (const res of hanging) res.end();
      hanging.clear();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    });

    const warm = await dispatch(state, {
      jsonrpc: "2.0",
      id: 0,
      method: "browser_tabs",
      params: { action: "list" },
    });
    assert.equal(warm.ok, true);

    const dcl = await dispatch(state, {
      jsonrpc: "2.0",
      id: 1,
      method: "browser_navigate",
      params: { url: target, wait_until: null },
    });
    assert.equal(dcl.ok, true, "setup navigate failed");
    assert.ok(state.browser);
    state.browser.cdp = null;

    const loadStarted = Date.now();
    const load = await dispatch(state, {
      jsonrpc: "2.0",
      id: 2,
      method: "browser_navigate",
      params: { url: target, wait_until: "load" },
    });
    const loadMs = Date.now() - loadStarted;
    assert.ok(loadMs <= 18_000, `missing-cdp load navigate took ${loadMs}ms, want ≤ 18000`);
    assert.equal(load.ok, true, `missing-cdp load navigate failed in ${loadMs}ms`);
    if (!load.ok) return;
    const loadData = load.data as { timed_out?: boolean; wait_until?: string };
    assert.equal(loadData.timed_out, true);
    assert.equal(loadData.wait_until, "load");
  });
});
