/**
 * `start` at the CLI seam:
 *  - a freshly initialised install has a model name but no credential, so
 *    standalone execution stays off (`agentLoop.credentialed === false`);
 *  - `start` hands a parent process the port, bootstrap URL and pid — over IPC
 *    always, and as one JSON stdout line under `--ready-json`.
 * Binds an ephemeral port (never 7777) and stops the child immediately.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { runInit } from "../../../src/cli/init.ts";
import { buildProductionComposition, isLocalEndpoint } from "../../../src/cli/start.ts";

const CLI = fileURLToPath(new URL("../../../src/cli/index.ts", import.meta.url));

const ENV_KEYS = [
  "MODELBOT_HOME", "MODELBOT_CONFIG", "MODELBOT_DATA_DIR", "MODELBOT_SQLITE_PATH",
  "MODELBOT_MCP_TOKEN", "MODELBOT_TOKEN", "MODELBOT_BOOTSTRAP_TOKEN", "MODELBOT_HOST",
  "MODELBOT_BIND", "MODELBOT_PORT", "MODELBOT_ALLOW_PUBLIC_BIND", "MODELBOT_WORKSPACE_ROOT",
  "MODELBOT_CODEX_HOME",
] as const;

const VAULT_KEY = Buffer.alloc(32, 7).toString("hex");

async function freshHome(): Promise<{ home: string; dataDir: string }> {
  const home = mkdtempSync(join(tmpdir(), "mb-ready-"));
  const dataDir = join(home, "data");
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  const savedVault = process.env.MODELBOT_VAULT_KEY_HEX;
  process.env.MODELBOT_VAULT_KEY_HEX = VAULT_KEY;
  try {
    await runInit(["--home", home, "--data-dir", dataDir, "--skip-detect", "--skip-images", "--quiet", "--force"]);
  } finally {
    for (const key of ENV_KEYS) {
      const prev = saved[key];
      if (prev === undefined) delete process.env[key]; else process.env[key] = prev;
    }
    if (savedVault === undefined) delete process.env.MODELBOT_VAULT_KEY_HEX;
    else process.env.MODELBOT_VAULT_KEY_HEX = savedVault;
  }
  return { home, dataDir };
}

describe("fresh install has no usable credential", () => {
  it("the shipped config names a model but standalone stays off until a key exists", async () => {
    const { home } = await freshHome();
    const saved = process.env.MODELBOT_VAULT_KEY_HEX;
    process.env.MODELBOT_VAULT_KEY_HEX = VAULT_KEY;
    try {
      const composition = await buildProductionComposition({ home, port: 0 });
      assert.ok(composition.daemon.agentLoop!.model.length > 0, "example config still names a model");
      assert.equal(composition.daemon.agentLoop!.credentialed, false);
      assert.equal(composition.daemon.autoConnectProvider, true);
      assert.equal(typeof composition.daemon.dataDir, "string");
    } finally {
      if (saved === undefined) delete process.env.MODELBOT_VAULT_KEY_HEX;
      else process.env.MODELBOT_VAULT_KEY_HEX = saved;
    }
  });

  it("treats a loopback model server as credentialed and a hosted one as not", () => {
    assert.equal(isLocalEndpoint("http://127.0.0.1:11434/v1"), true);
    assert.equal(isLocalEndpoint("http://127.2.3.4:1234/v1"), true);
    assert.equal(isLocalEndpoint("http://localhost:1234/v1"), true);
    assert.equal(isLocalEndpoint("http://[::1]:1234/v1"), true);
    assert.equal(isLocalEndpoint("https://api.openai.com/v1"), false);
    assert.equal(isLocalEndpoint("http://10.0.0.5/v1"), false);
    // A `.local` name is claimable by anything on the LAN, so it needs a credential.
    assert.equal(isLocalEndpoint("http://printer.local/v1"), false);
    assert.equal(isLocalEndpoint("http://ollama.local:11434/v1"), false);
    assert.equal(isLocalEndpoint(undefined), false);
    assert.equal(isLocalEndpoint("not a url"), false);
  });
});

describe("local handoff for the app shell", () => {
  /** The daemon also writes JSON logs to stdout, so a parent must scan lines. */
  async function startChild(extra: string[], match: RegExp, ipcChannel = true): Promise<{
    line: string;
    lines: string[];
    ipc: Record<string, unknown> | undefined;
  }> {
    const { home } = await freshHome();
    const child = spawn(
      process.execPath,
      [...process.execArgv.filter((a) => !a.startsWith("--inspect")), CLI, "start", "--home", home, "--port", "0", "--no-open", ...extra],
      {
        stdio: ipcChannel ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
        env: { ...process.env, MODELBOT_VAULT_KEY_HEX: VAULT_KEY, MODELBOT_TEST_FAKE_COMPUTER: "1" },
      },
    );
    let out = "";
    let stderr = "";
    let ipc: Record<string, unknown> | undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => { out += c; });
    child.stderr.on("data", (c: string) => { stderr += c; });
    child.on("message", (m) => { if (!ipc) ipc = m as Record<string, unknown>; });
    try {
      const line = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out; stdout=${out} stderr=${stderr}`)), 30_000);
        const check = setInterval(() => {
          const hit = out.split("\n").map((l) => l.trim()).find((l) => match.test(l));
          if (hit && (ipc || !ipcChannel)) { clearInterval(check); clearTimeout(timer); resolve(hit); }
        }, 50);
        child.once("exit", (code) => {
          clearInterval(check); clearTimeout(timer);
          reject(new Error(`start exited ${code}: ${stderr}`));
        });
      });
      return { line, lines: out.split("\n").map((l) => l.trim()).filter(Boolean), ipc };
    } finally {
      child.kill("SIGTERM");
    }
  }

  it("prints the link and the pair hint when no parent is listening", async () => {
    const { line, lines } = await startChild([], /^Open http:/, false);
    assert.match(line, /^Open http:\/\/127\.0\.0\.1:\d+\/#bootstrap=.+/);
    assert.ok(lines.includes("This link works for 10 minutes. Lost it? Run: bothearth pair"));
    assert.deepEqual(lines.filter((l) => l.includes("#bootstrap=")), [line]);
  });

  it("hands a parent the full ready message over IPC and keeps the token off stdout", async () => {
    const { line, lines, ipc } = await startChild([], /modelbot start ready/);
    assert.doesNotMatch(line, /#bootstrap=/);
    assert.deepEqual(lines.filter((l) => l.includes("#bootstrap=")), []);
    assert.equal(ipc?.type, "modelbot.ready");
    assert.equal(typeof ipc?.port, "number");
    assert.notEqual(ipc?.port, 7777);
    assert.equal(typeof ipc?.pid, "number");
    assert.match(String(ipc?.bootstrap_url), /#bootstrap=/);
  });

  it("--ready-json prints exactly one JSON line carrying port, url and pid", async () => {
    const { line, lines, ipc } = await startChild(["--ready-json"], /"modelbot\.ready"/);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.equal(parsed.type, "modelbot.ready");
    assert.equal(typeof parsed.port, "number");
    assert.equal(typeof parsed.pid, "number");
    assert.match(String(parsed.bootstrap_url), new RegExp(`^http://127\\.0\\.0\\.1:${parsed.port}/#bootstrap=`));
    // The one-time token appears on exactly one stdout line and nowhere else.
    assert.deepEqual(lines.filter((l) => l.includes("#bootstrap=")), [line]);
    assert.deepEqual(parsed, ipc);
  });
});
