import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runInit } from "../../../src/cli/init.ts";
import {
  attachDaemonFileLog,
  DAEMON_LOG_MAX_BYTES,
  daemonLogPath,
  detachDaemonFileLog,
  logInfo,
  redactLogFields,
} from "../../../src/daemon/log.ts";

const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

const CLI = fileURLToPath(new URL("../../../src/cli/index.ts", import.meta.url));
const VAULT_KEY = Buffer.alloc(32, 7).toString("hex");

const ENV_KEYS = [
  "MODELBOT_HOME",
  "MODELBOT_CONFIG",
  "MODELBOT_DATA_DIR",
  "MODELBOT_SQLITE_PATH",
  "MODELBOT_MCP_TOKEN",
  "MODELBOT_TOKEN",
  "MODELBOT_BOOTSTRAP_TOKEN",
  "MODELBOT_HOST",
  "MODELBOT_BIND",
  "MODELBOT_PORT",
  "MODELBOT_ALLOW_PUBLIC_BIND",
  "MODELBOT_WORKSPACE_ROOT",
  "MODELBOT_CODEX_HOME",
] as const;

async function withClearedInheritedEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of ENV_KEYS) {
      const prev = saved[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  }
}

function isolatedStartEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of ENV_KEYS) delete env[key];
  env.CI = "1";
  env.MODELBOT_NO_OPEN = "1";
  env.MODELBOT_VAULT_KEY_HEX = VAULT_KEY;
  env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  return env;
}

describe("daemon log redactor", () => {
  it("redacts secret keys after suffix and case/separator normalisation", () => {
    const out = redactLogFields({
      password_preview: "hunter2",
      "Authorization-Preview": "Bearer abc",
      apiKeyPreview: "sk-live-secret",
    }) as Record<string, unknown>;
    assert.equal(out.password_preview, "[redacted]");
    assert.equal(out["Authorization-Preview"], "[redacted]");
    assert.equal(out.apiKeyPreview, "[redacted]");
  });

  it("redacts a JWT inside an ordinary note field", () => {
    const out = redactLogFields({
      note: `user session ${JWT} ok`,
    }) as Record<string, unknown>;
    assert.equal(out.note, "user session [redacted] ok");
    assert.equal(String(out.note).includes("eyJ"), false);
  });

  it("leaves ordinary text untouched", () => {
    const out = redactLogFields({
      msg: "clicked Continue",
      count: 3,
    }) as Record<string, unknown>;
    assert.equal(out.msg, "clicked Continue");
    assert.equal(out.count, 3);
  });
});

describe("daemon file log", () => {
  it("writes redacted secret fields to the file", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mb-log-redact-"));
    const path = attachDaemonFileLog(dataDir);
    try {
      logInfo("provider configured", {
        token: "sekrit-token",
        mcp_token: "mcp-sekrit",
        bootstrap: "boot-sekrit",
        authorization: "Bearer abc",
        cookie: "sid=1",
        csrf: "csrf-sekrit",
        password: "hunter2",
        api_key: "sk-live-secret",
        secret: "top-sekrit",
      });
      const body = readFileSync(path, "utf8");
      assert.match(body, /"msg":"provider configured"/);
      assert.match(body, /\[redacted\]/);
      assert.doesNotMatch(body, /sekrit/);
      assert.doesNotMatch(body, /hunter2/);
      assert.doesNotMatch(body, /sk-live-secret/);
      assert.doesNotMatch(body, /sid=1/);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(path, daemonLogPath(dataDir));
    } finally {
      detachDaemonFileLog();
    }
  });

  it("rotates to daemon.log.1 when the file exceeds 20 MB", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mb-log-rotate-"));
    const path = attachDaemonFileLog(dataDir);
    try {
      writeFileSync(`${path}.1`, "old-rotated\n");
      const fd = openSync(path, "w");
      ftruncateSync(fd, DAEMON_LOG_MAX_BYTES + 1);
      closeSync(fd);
      logInfo("after-rotate");
      assert.equal(existsSync(`${path}.1`), true);
      assert.ok(statSync(`${path}.1`).size > DAEMON_LOG_MAX_BYTES);
      assert.doesNotMatch(readFileSync(`${path}.1`, "utf8"), /old-rotated/);
      const body = readFileSync(path, "utf8");
      assert.match(body, /"msg":"after-rotate"/);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(statSync(`${path}.1`).mode & 0o777, 0o600);
    } finally {
      detachDaemonFileLog();
    }
  });

  it("drops inherited MODELBOT data-dir keys from the start child env", () => {
    const env = isolatedStartEnv({
      PATH: "/bin",
      MODELBOT_DATA_DIR: "/owner/real-data",
      MODELBOT_CONFIG: "/owner/config.yaml",
      MODELBOT_SQLITE_PATH: "/owner/db.sqlite",
      MODELBOT_HOME: "/owner/.modelbot",
    });
    assert.equal(env.MODELBOT_DATA_DIR, undefined);
    assert.equal(env.MODELBOT_CONFIG, undefined);
    assert.equal(env.MODELBOT_SQLITE_PATH, undefined);
    assert.equal(env.MODELBOT_HOME, undefined);
    assert.equal(env.CI, "1");
    assert.equal(env.MODELBOT_NO_OPEN, "1");
    assert.equal(env.MODELBOT_VAULT_KEY_HEX, VAULT_KEY);
    assert.equal(env.MODELBOT_TEST_FAKE_COMPUTER, "1");
    assert.equal(env.PATH, "/bin");
  });

  it("clears inherited MODELBOT paths while init runs", async () => {
    const previous = process.env.MODELBOT_DATA_DIR;
    process.env.MODELBOT_DATA_DIR = "/owner/real-data";
    try {
      await withClearedInheritedEnv(async () => {
        assert.equal(process.env.MODELBOT_DATA_DIR, undefined);
        assert.equal(process.env.MODELBOT_CONFIG, undefined);
        assert.equal(process.env.MODELBOT_SQLITE_PATH, undefined);
      });
      assert.equal(process.env.MODELBOT_DATA_DIR, "/owner/real-data");
    } finally {
      if (previous === undefined) delete process.env.MODELBOT_DATA_DIR;
      else process.env.MODELBOT_DATA_DIR = previous;
    }
  });

  it("foreground start appends structured lines under a temp data dir", async () => {
    const home = mkdtempSync(join(tmpdir(), "mb-log-start-"));
    const dataDir = join(home, "data");
    const savedVault = process.env.MODELBOT_VAULT_KEY_HEX;
    process.env.MODELBOT_VAULT_KEY_HEX = VAULT_KEY;
    try {
      await withClearedInheritedEnv(() =>
        runInit([
          "--home",
          home,
          "--data-dir",
          dataDir,
          "--skip-detect",
          "--skip-images",
          "--quiet",
          "--force",
        ]),
      );
    } finally {
      if (savedVault === undefined) delete process.env.MODELBOT_VAULT_KEY_HEX;
      else process.env.MODELBOT_VAULT_KEY_HEX = savedVault;
    }

    const logFile = daemonLogPath(dataDir);
    const child = spawn(
      process.execPath,
      [
        ...process.execArgv.filter((a) => !a.startsWith("--inspect")),
        CLI,
        "start",
        "--home",
        home,
        "--port",
        "0",
        "--no-open",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: isolatedStartEnv(process.env),
      },
    );
    let out = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      out += c;
    });
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out; stdout=${out} stderr=${stderr}`)),
          30_000,
        );
        const check = setInterval(() => {
          if (
            existsSync(logFile) &&
            readFileSync(logFile, "utf8").includes("modelbot start ready")
          ) {
            clearInterval(check);
            clearTimeout(timer);
            resolve();
          }
        }, 50);
        child.once("exit", (code) => {
          clearInterval(check);
          clearTimeout(timer);
          reject(new Error(`start exited ${code}: ${stderr}`));
        });
      });
      const body = readFileSync(logFile, "utf8");
      assert.match(body, /"msg":"modelbot start ready"/);
      assert.equal(statSync(logFile).mode & 0o777, 0o600);
    } finally {
      child.kill("SIGTERM");
    }
  });
});
