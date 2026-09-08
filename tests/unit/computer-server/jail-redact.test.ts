import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createState, dispatch } from "../../../computer-server/src/dispatch.ts";
import { redactSnapshotYaml, redactUrl } from "../../../computer-server/src/redact.ts";

it("contains a missing quarantine mount as E_SANDBOX_DEAD and keeps RPC alive", async () => {
  const previous = process.env.MODELBOT_QUARANTINE;
  const missing = join(tmpdir(), `mb-missing-quarantine-${process.pid}-${Date.now()}`);
  process.env.MODELBOT_QUARANTINE = missing;
  try {
    const state = createState("browser");
    const unavailable = await dispatch(state, {
      jsonrpc: "2.0",
      id: 1,
      method: "browser_navigate",
      params: { url: "https://example.com" },
    });
    assert.equal(unavailable.ok, false);
    if (!unavailable.ok) {
      assert.equal(unavailable.error.code, "E_SANDBOX_DEAD");
      assert.match(
        unavailable.error.message,
        new RegExp(`E_QUARANTINE_MOUNT_MISSING.*${missing}`),
      );
    }

    const promotion = await dispatch(state, {
      jsonrpc: "2.0",
      id: 2,
      method: "quarantine.promote",
      params: { id: "download_0123456789abcdef01234567" },
    });
    assert.equal(promotion.ok, false);

    const alive = await dispatch(state, {
      jsonrpc: "2.0",
      id: 3,
      method: "takeover_status",
      params: {},
    });
    assert.equal(alive.ok, true);
  } finally {
    if (previous === undefined) delete process.env.MODELBOT_QUARANTINE;
    else process.env.MODELBOT_QUARANTINE = previous;
  }
});

describe("computer-server shell jail", () => {
  it("lists/reads under workspace; blocks profile + symlink escape", async () => {
    const root = mkdtempSync(join(tmpdir(), "mb-jail-"));
    process.env.MODELBOT_WORKSPACE = root;
    writeFileSync(join(root, "a.txt"), "alpha");
    mkdirSync(join(root, "sub"));
    try {
      symlinkSync("/etc/passwd", join(root, "sub", "escape"));
    } catch {
      /* windows */
    }

    const state = createState("shell");
    const list = await dispatch(state, {
      jsonrpc: "2.0",
      id: 1,
      method: "files_list",
      params: { path: "." },
    });
    assert.equal(list.ok, true);

    const read = await dispatch(state, {
      jsonrpc: "2.0",
      id: 2,
      method: "files_read",
      params: { path: "a.txt", offset: null, limit: null },
    });
    assert.equal(read.ok, true);

    const profile = await dispatch(state, {
      jsonrpc: "2.0",
      id: 3,
      method: "files_read",
      params: { path: "/home/browser/profile/Cookies", offset: null, limit: null },
    });
    assert.equal(profile.ok, false);
    if (!profile.ok) assert.equal(profile.error.code, "E_POLICY");

    const escape = await dispatch(state, {
      jsonrpc: "2.0",
      id: 4,
      method: "files_read",
      params: { path: "sub/escape", offset: null, limit: null },
    });
    assert.equal(escape.ok, false);
    if (!escape.ok) assert.equal(escape.error.code, "E_POLICY");
  });

  it("shell_exec caps + takeover busy", async () => {
    const root = mkdtempSync(join(tmpdir(), "mb-sh-"));
    process.env.MODELBOT_WORKSPACE = root;
    const state = createState("shell");
    const exec = await dispatch(state, {
      jsonrpc: "2.0",
      id: 1,
      method: "shell_exec",
      params: { command: "echo hi", cwd: null, timeout_ms: 5000 },
    });
    assert.equal(exec.ok, true);

    await dispatch(state, {
      jsonrpc: "2.0",
      id: 2,
      method: "request_takeover",
      params: { reason: "test", category: null },
    });
    await dispatch(state, {
      jsonrpc: "2.0",
      id: 3,
      method: "takeover.grant",
      params: {},
    });
    const busy = await dispatch(state, {
      jsonrpc: "2.0",
      id: 4,
      method: "shell_exec",
      params: { command: "echo no", cwd: null, timeout_ms: 1000 },
    });
    assert.equal(busy.ok, false);
    if (!busy.ok) assert.equal(busy.error.code, "E_TAKEOVER_BUSY");
  });
});

describe("redaction", () => {
  it("strips token URLs and secret fields", () => {
    const u = redactUrl("https://x.test/cb?token=sekrit&ok=1");
    assert.match(u, /REDACTED/);
    assert.doesNotMatch(u, /sekrit/);
    const y = redactSnapshotYaml(
      '- textbox "Password" [ref=e1]: "hunter2"\n- link "ok" [ref=e2]',
    );
    assert.match(y, /\*\*\*/);
    assert.doesNotMatch(y, /hunter2/);
  });
});
