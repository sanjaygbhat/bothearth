import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServer } from "node:http";
import {
  BrowserSession,
  LAUNCH_ARGS,
  chromiumAvailable,
  disableCredentialStorage,
} from "../../../computer-server/src/browser/session.ts";
import { createState, dispatch } from "../../../computer-server/src/dispatch.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { filesRead } from "../../../computer-server/src/shell/tools.ts";

const hasChromium = await chromiumAvailable().catch(() => false);
if (process.env.MODELBOT_TEST_REQUIRE_HOST_BROWSER === "1") assert.ok(hasChromium, "Required host Chromium is unavailable");

it("keeps an unapproved download outside the ordinary workspace", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mb-download-"));
  const quarantine = mkdtempSync(join(tmpdir(), "mb-quarantine-"));
  process.env.MODELBOT_WORKSPACE = ws;
  process.env.MODELBOT_QUARANTINE = quarantine;

  const result = await new BrowserSession()["quarantineDownload"]({
    suggestedFilename: () => "sample.txt",
    saveAs: async (path) => writeFileSync(path, "downloaded"),
  }) as { path: string; basename: string; quarantined: boolean };

  assert.equal(result.path.startsWith(`${quarantine}/download_`), true);
  assert.equal(result.basename, "sample.txt");
  assert.equal(result.quarantined, true);
  assert.equal(existsSync(result.path), true);
  assert.equal(readdirSync(quarantine).length, 1);
  assert.deepEqual(readdirSync(ws), []);
  assert.equal(filesRead({ path: result.path, offset: null, limit: null }).ok, false);
});

describe("computer-server browser tools (Playwright)", () => {
  it("navigate HTTP fixture → snapshot refs → screenshot → mouse click", { skip: !hasChromium && "Host Chromium unavailable; real-image tests remain required" }, async (t) => {
    const ws = mkdtempSync(join(tmpdir(), "mb-br-"));
    const profile = mkdtempSync(join(tmpdir(), "mb-pf-"));
    process.env.MODELBOT_WORKSPACE = ws;
    process.env.MODELBOT_PROFILE = profile;

    process.env.MODELBOT_QUARANTINE = mkdtempSync(join(tmpdir(), "mb-quarantine-browser-"));
    process.env.MODELBOT_PROXY_SERVER = "http://127.0.0.1:9";
    process.env.MODELBOT_PROXY_BYPASS = "127.0.0.1";
    const fixture = createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end("<html><body><button id=b>Go</button><script>document.getElementById('b').onclick=()=>{document.title='clicked'}</script></body></html>");
    });
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const address = fixture.address();
    assert.ok(address && typeof address === "object");
    const state = createState("browser");
    t.after(async () => { await state.browser?.close(); await new Promise<void>((resolve) => fixture.close(() => resolve())); });
    const nav = await dispatch(state, {
      jsonrpc: "2.0",
      id: 1,
      method: "browser_navigate",
      params: {
        url: `http://127.0.0.1:${address.port}/`,
        wait_until: "load",
      },
    });
    assert.equal(nav.ok, true);

    const snap = await dispatch(state, {
      jsonrpc: "2.0",
      id: 2,
      method: "browser_snapshot",
      params: {
        scope: null,
        interactive_only: true,
        depth: null,
        max_chars: 8000,
      },
    });
    assert.equal(snap.ok, true);
    if (!snap.ok) return;
    const data = snap.data as {
      snapshot_id: string;
      refs: string[];
      yaml: string;
    };
    assert.ok(data.snapshot_id);
    assert.ok(data.refs.length >= 1);

    const shot = await dispatch(state, {
      jsonrpc: "2.0",
      id: 3,
      method: "browser_screenshot",
      params: {
        full_page: false,
        max_width: 1280,
        max_height: 720,
        snapshot_id: null,
        ref: null,
      },
    });
    assert.equal(shot.ok, true);
    if (shot.ok) {
      const s = shot.data as {
        image_id: string;
        css_width: number;
        scale: number;
      };
      assert.ok(s.image_id);
      assert.ok(s.css_width > 0);
      assert.ok(s.scale > 0);
    }

    const click = await dispatch(state, {
      jsonrpc: "2.0",
      id: 4,
      method: "computer_mouse",
      params: {
        action: "click",
        x: 40,
        y: 20,
        x2: null,
        y2: null,
        button: 0,
        dx: null,
        dy: null,
      },
    });
    assert.equal(click.ok, true);

    // stale ref
    const stale = await dispatch(state, {
      jsonrpc: "2.0",
      id: 5,
      method: "browser_click",
      params: {
        snapshot_id: "snap_missing",
        ref: "e999",
        button: "left",
        double_click: false,
      },
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, "E_STALE_REF");

  });

  it("uses Chromium's own identity and retains private credential preferences", { skip: !hasChromium && "Host Chromium unavailable" }, async (t) => {
    process.env.MODELBOT_WORKSPACE = mkdtempSync(join(tmpdir(), "mb-fp-ws-"));
    const profile = mkdtempSync(join(tmpdir(), "mb-fp-pf-"));
    process.env.MODELBOT_PROFILE = profile;
    process.env.MODELBOT_QUARANTINE = mkdtempSync(join(tmpdir(), "mb-fp-q-"));
    process.env.MODELBOT_PROXY_SERVER = "http://127.0.0.1:9";
    process.env.MODELBOT_PROXY_BYPASS = "127.0.0.1";
    const session = new BrowserSession();
    t.after(() => session.close());
    await session.start();
    const page = session.page;
    assert.ok(page);
    const fingerprint = await page.evaluate(() => ({
      webdriver: navigator.webdriver,
      userAgent: navigator.userAgent,
      languages: [...navigator.languages],
    }));
    assert.match(fingerprint.userAgent, /Chrome/);
    assert.ok(fingerprint.languages.length);
    assert.ok(!LAUNCH_ARGS.some(arg => /AutomationControlled|user-agent|no-sandbox/.test(arg)));

    // Chrome's own password manager, off in the profile it just ran on — read
    // after the shutdown that rewrites Preferences, so this is Chromium's copy,
    // not ours. Credential filling remains disabled across browser restarts.
    await session.close();
    const live = JSON.parse(readFileSync(join(profile, "Default", "Preferences"), "utf8")) as
      { credentials_enable_service?: boolean; profile?: { password_manager_enabled?: boolean } };
    assert.equal(live.credentials_enable_service, false, "Chromium re-enabled the password manager");
    assert.equal(live.profile?.password_manager_enabled, false);
  });

  it("keeps the password manager off in a profile that already had it on", () => {
    const profile = mkdtempSync(join(tmpdir(), "mb-prefs-"));
    mkdirSync(join(profile, "Default"), { recursive: true });
    writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({
      credentials_enable_service: true,
      profile: { password_manager_enabled: true, name: "Person 1" },
      autofill: { profile_enabled: true },
      extensions: { settings: {} },
    }));
    disableCredentialStorage(profile);
    const prefs = JSON.parse(readFileSync(join(profile, "Default", "Preferences"), "utf8")) as
      Record<string, Record<string, unknown> & boolean>;
    assert.equal(prefs.credentials_enable_service, false);
    assert.equal(prefs.credentials_enable_autosignin, false);
    assert.equal(prefs.profile.password_manager_enabled, false);
    assert.equal(prefs.autofill.profile_enabled, false);
    assert.equal(prefs.autofill.credit_card_enabled, false);
    // Everything else the profile had is still there.
    assert.equal(prefs.profile.name, "Person 1");
    assert.ok(prefs.extensions);
    assert.ok(LAUNCH_ARGS.includes("--password-store=basic"));
  });

  it("starts under a POSIX TZ the container may inherit", { skip: !hasChromium && "Host Chromium unavailable" }, async (t) => {
    // `TZ=:/etc/localtime` is a perfectly ordinary host setting. Playwright
    // rejects anything that is not an IANA zone, and the launch failure it
    // raises sends the operator to seccomp and user namespaces for a bad env var.
    const prior = process.env.TZ;
    process.env.TZ = ":/etc/localtime";
    process.env.MODELBOT_WORKSPACE = mkdtempSync(join(tmpdir(), "mb-tz-ws-"));
    process.env.MODELBOT_PROFILE = mkdtempSync(join(tmpdir(), "mb-tz-pf-"));
    process.env.MODELBOT_QUARANTINE = mkdtempSync(join(tmpdir(), "mb-tz-q-"));
    process.env.MODELBOT_PROXY_SERVER = "http://127.0.0.1:9";
    process.env.MODELBOT_PROXY_BYPASS = "127.0.0.1";
    const session = new BrowserSession();
    t.after(async () => {
      await session.close();
      if (prior === undefined) delete process.env.TZ;
      else process.env.TZ = prior;
    });
    await session.start();
    assert.ok(session.page, "a non-IANA TZ stopped the browser from starting");
  });

  it("starts on a profile a killed Chromium left locked", { skip: !hasChromium && "Host Chromium unavailable" }, async (t) => {
    const profile = mkdtempSync(join(tmpdir(), "mb-lock-pf-"));
    process.env.MODELBOT_WORKSPACE = mkdtempSync(join(tmpdir(), "mb-lock-ws-"));
    process.env.MODELBOT_PROFILE = profile;
    process.env.MODELBOT_QUARANTINE = mkdtempSync(join(tmpdir(), "mb-lock-q-"));
    process.env.MODELBOT_PROXY_SERVER = "http://127.0.0.1:9";
    process.env.MODELBOT_PROXY_BYPASS = "127.0.0.1";
    // What a container that was SIGTERMed with the browser alive leaves on the volume.
    symlinkSync("f8305084b27f-32", join(profile, "SingletonLock"));
    writeFileSync(join(profile, "SingletonCookie"), "");

    const session = new BrowserSession();
    t.after(() => session.close());
    await session.start();
    assert.ok(session.page, "a lock from a dead container must not stop the launch");
    // Chromium took the profile: the lock names this host, not the dead one.
    assert.match(readlinkSync(join(profile, "SingletonLock")), new RegExp(`^${hostname()}-\\d+$`));
  });
});

it("says the browser is unavailable instead of asking a human to take over a screen that is not there", async () => {
  process.env.MODELBOT_WORKSPACE = mkdtempSync(join(tmpdir(), "mb-dead-ws-"));
  process.env.MODELBOT_PROFILE = mkdtempSync(join(tmpdir(), "mb-dead-pf-"));
  // No quarantine mount: start() fails before Chromium is ever launched.
  process.env.MODELBOT_QUARANTINE = join(tmpdir(), "mb-dead-absent");
  const state = createState("browser");

  const nav = await dispatch(state, {
    jsonrpc: "2.0", id: 1, method: "browser_navigate",
    params: { url: "https://example.com/", wait_until: "load" },
  });
  assert.equal(nav.ok, false);
  if (nav.ok) return;
  assert.equal(nav.error.code, "E_SANDBOX_DEAD");
  assert.match(nav.error.message, /browser cannot start/);
  assert.match(nav.error.message, /E_QUARANTINE_MOUNT_MISSING/, "the launch error itself must reach the model");

  const takeover = await dispatch(state, {
    jsonrpc: "2.0", id: 2, method: "request_takeover", params: { reason: "please sign in" },
  });
  assert.equal(takeover.ok, false, "a takeover onto a dead browser is a blank canvas");
  if (takeover.ok) return;
  assert.equal(takeover.error.code, "E_SANDBOX_DEAD");
  assert.equal(state.takeover.state, "agent", "the task must not park in needs-you");
});
