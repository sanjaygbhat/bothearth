/**
 * `modelbot status` + the Herdr plugin manifest.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startDaemon, type DaemonHandle } from "../../../src/daemon/server.ts";
import { fetchStatusSnapshot } from "../../../src/cli/status.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const pluginDir = join(root, "flavours/herdr-plugin");
const BOOT = "herdr-boot-token-test-xxxxxx";
const MCP = "herdr-mcp-token-test-xxxxxxx";

describe("herdr plugin + status", () => {
  let daemon: DaemonHandle;
  let prevBoot: string | undefined;
  let prevBase: string | undefined;

  before(async () => {
    process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
    daemon = await startDaemon({
      host: "127.0.0.1",
      port: 0,
      mcpToken: MCP,
      bootstrapToken: BOOT,
    });
    prevBoot = process.env.MODELBOT_BOOTSTRAP_TOKEN;
    prevBase = process.env.MODELBOT_BASE_URL;
    process.env.MODELBOT_BOOTSTRAP_TOKEN = BOOT;
    process.env.MODELBOT_BASE_URL = daemon.baseUrl;
  });

  after(async () => {
    await daemon.close();
    if (prevBoot === undefined) delete process.env.MODELBOT_BOOTSTRAP_TOKEN;
    else process.env.MODELBOT_BOOTSTRAP_TOKEN = prevBoot;
    if (prevBase === undefined) delete process.env.MODELBOT_BASE_URL;
    else process.env.MODELBOT_BASE_URL = prevBase;
  });

  it("manifest has required fields and actions", () => {
    const toml = readFileSync(join(pluginDir, "herdr-plugin.toml"), "utf8");
    assert.match(toml, /^id\s*=\s*"modelbot"/m);
    assert.match(toml, /min_herdr_version\s*=\s*"0\.8\.2"/);
    for (const id of [
      "status",
      "start",
      "stop",
      "computer-create",
      "computer-open",
      "takeover-open",
    ]) {
      assert.match(toml, new RegExp(`id\\s*=\\s*"${id}"`));
    }
    assert.match(toml, /\[\[panes\]\]/);
    assert.ok(!/\[\[startup\]\]/.test(toml));
    assert.ok(existsSync(join(pluginDir, "README.md")));
    assert.ok(existsSync(join(pluginDir, "bin/status-watch")));
    assert.ok(existsSync(join(pluginDir, "actions/status.mjs")));
  });

  it("fetchStatusSnapshot lists empty collections", async () => {
    const snap = await fetchStatusSnapshot(daemon.baseUrl);
    assert.equal(snap.baseUrl, daemon.baseUrl);
    assert.ok(Array.isArray(snap.computers));
    assert.ok(Array.isArray(snap.tasks));
    assert.ok(Array.isArray(snap.takeovers));
    assert.ok(Array.isArray(snap.approvals));
  });

  it("status action script exits 0 against live daemon", async () => {
    // Bootstrap is single-use; re-seed after fetchStatusSnapshot consumed it.
    const hash = createHash("sha256").update(BOOT).digest("hex");
    // Reset only this fixture; production registration never resurrects a used token.
    daemon.store.db.prepare("DELETE FROM bootstrap_tokens WHERE token_hash = ?").run(hash);
    daemon.store.registerBootstrapToken(
      hash,
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    );
    const code = await new Promise<number>((resolveCode) => {
      const child = spawn(
        process.execPath,
        [join(pluginDir, "actions/status.mjs")],
        {
          env: {
            ...process.env,
            MODELBOT_BOOTSTRAP_TOKEN: BOOT,
            MODELBOT_BASE_URL: daemon.baseUrl,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let out = "";
      let err = "";
      child.stdout?.on("data", (b) => {
        out += String(b);
      });
      child.stderr?.on("data", (b) => {
        err += String(b);
      });
      child.on("close", (c) => {
        assert.match(out, /"computers"/, err);
        resolveCode(c ?? 1);
      });
    });
    assert.equal(code, 0);
  });
});
