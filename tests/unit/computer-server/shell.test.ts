import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  SHELL_STREAM_CAP,
  createStreamCollector,
  environmentForCommand,
  lastCollectors,
  shellExec,
} from "../../../computer-server/src/shell/tools.ts";

const CAP2 = SHELL_STREAM_CAP * 2;

/** PIDs of `sleep 30` whose parent is gone, pid 1, or this process — not live wait-loop children. */
function sleep30Pids(): Set<string> {
  const out = execSync("ps -ax -o pid=,ppid=,command=", { encoding: "utf8" });
  const live = new Set<string>();
  const sleeps: { pid: string; ppid: string }[] = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const [pid, ppid, cmd] = t.split(/\s+/, 3);
    if (!pid || !ppid || cmd === undefined) continue;
    live.add(pid);
    if (/^(?:\/(?:usr\/)?bin\/)?sleep\s+30$/.test(cmd)) sleeps.push({ pid, ppid });
  }
  const self = String(process.pid);
  const ids = new Set<string>();
  for (const s of sleeps) {
    if (s.ppid === "1" || s.ppid === self || !live.has(s.ppid)) ids.add(s.pid);
  }
  return ids;
}

describe("shell hardening", () => {
  let workspace: string;
  let prevWorkspace: string | undefined;

  before(() => {
    workspace = mkdtempSync(join(tmpdir(), "mb-shell-"));
    prevWorkspace = process.env.MODELBOT_WORKSPACE;
    process.env.MODELBOT_WORKSPACE = workspace;
    process.env.MODELBOT_TEST_SHELL_HOOKS = "1";
  });

  after(() => {
    if (prevWorkspace === undefined) delete process.env.MODELBOT_WORKSPACE;
    else process.env.MODELBOT_WORKSPACE = prevWorkspace;
    delete process.env.MODELBOT_TEST_SHELL_HOOKS;
  });

  it("createStreamCollector stays <= 2x32 KiB while adding megabytes", () => {
    const c = createStreamCollector(SHELL_STREAM_CAP);
    c.add("x".repeat(500_000));
    assert.ok(c.bytesHeld <= CAP2);
    assert.ok(c.maxBytesHeld <= CAP2);
    assert.equal(c.dropped, true);
    const chunk = "y\n".repeat(8000);
    for (let i = 0; i < 40; i++) {
      c.add(chunk);
      assert.ok(c.bytesHeld <= CAP2);
    }
  });

  it("yes keeps collector <= 2x32 KiB during the run", async () => {
    const pending = shellExec({ command: "yes", cwd: null, timeout_ms: 400 });
    const peaks: number[] = [];
    const iv = setInterval(() => {
      const n = lastCollectors?.stdout.bytesHeld ?? 0;
      peaks.push(n);
      assert.ok(n <= CAP2, `stdout collector ${n} > ${CAP2}`);
    }, 5);
    await pending;
    clearInterval(iv);
    assert.ok(peaks.length > 0);
    assert.ok((lastCollectors?.stdout.maxBytesHeld ?? 0) <= CAP2);
  });

  it("yes >&2 keeps collector <= 2x32 KiB during the run", async () => {
    const pending = shellExec({ command: "yes >&2", cwd: null, timeout_ms: 400 });
    const iv = setInterval(() => {
      const n = lastCollectors?.stderr.bytesHeld ?? 0;
      assert.ok(n <= CAP2, `stderr collector ${n} > ${CAP2}`);
    }, 5);
    await pending;
    clearInterval(iv);
    assert.ok((lastCollectors?.stderr.maxBytesHeld ?? 0) <= CAP2);
  });

  it("bash -c 'sleep 30 & wait' leaves no orphan sleep after kill", async () => {
    const before = sleep30Pids();
    const r = await shellExec({
      command: "sleep 30 & wait",
      cwd: null,
      timeout_ms: 250,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "E_TIMEOUT");
    await new Promise((res) => setTimeout(res, 200));
    const after = sleep30Pids();
    const leftovers = [...after].filter((pid) => !before.has(pid));
    assert.deepEqual(leftovers, []);
  });

  it("COMPUTER_SHELL_ENV=AWS_ACCESS_KEY_ID yields no AWS key in child env", () => {
    const prevExtra = process.env.COMPUTER_SHELL_ENV;
    const prevAws = process.env.AWS_ACCESS_KEY_ID;
    process.env.COMPUTER_SHELL_ENV = "AWS_ACCESS_KEY_ID";
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    try {
      const built = environmentForCommand(process.env, workspace);
      assert.equal(built.AWS_ACCESS_KEY_ID, undefined);
    } finally {
      if (prevExtra === undefined) delete process.env.COMPUTER_SHELL_ENV;
      else process.env.COMPUTER_SHELL_ENV = prevExtra;
      if (prevAws === undefined) delete process.env.AWS_ACCESS_KEY_ID;
      else process.env.AWS_ACCESS_KEY_ID = prevAws;
    }
  });

  it("OPENAI_API_KEY absent in child env", async () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test-must-not-leak";
    try {
      const built = environmentForCommand(process.env, workspace);
      assert.equal(built.OPENAI_API_KEY, undefined);
      const r = await shellExec({
        command: "printenv OPENAI_API_KEY; echo done",
        cwd: null,
        timeout_ms: 5000,
      });
      assert.equal(r.ok, true);
      if (r.ok) {
        assert.doesNotMatch(r.data.stdout, /sk-test-must-not-leak/);
      }
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });

  it("BASH_ENV refused", async () => {
    const prev = process.env.BASH_ENV;
    const prevExtra = process.env.COMPUTER_SHELL_ENV;
    process.env.BASH_ENV = "/tmp/modelbot-should-not-source";
    process.env.COMPUTER_SHELL_ENV = "BASH_ENV";
    try {
      const built = environmentForCommand(process.env, workspace);
      assert.equal(built.BASH_ENV, undefined);
      const r = await shellExec({
        command: "printenv BASH_ENV; echo ok",
        cwd: null,
        timeout_ms: 5000,
      });
      assert.equal(r.ok, true);
      if (r.ok) {
        assert.doesNotMatch(r.data.stdout, /modelbot-should-not-source/);
      }
    } finally {
      if (prev === undefined) delete process.env.BASH_ENV;
      else process.env.BASH_ENV = prev;
      if (prevExtra === undefined) delete process.env.COMPUTER_SHELL_ENV;
      else process.env.COMPUTER_SHELL_ENV = prevExtra;
    }
  });

  it("HTTPS_PROXY present with userinfo stripped", async () => {
    const prev = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = "https://user:s3cret@proxy.example:8443";
    try {
      const built = environmentForCommand(process.env, workspace);
      assert.ok(built.HTTPS_PROXY);
      assert.doesNotMatch(built.HTTPS_PROXY, /user|s3cret/);
      assert.match(built.HTTPS_PROXY, /proxy\.example/);
      const r = await shellExec({
        command: 'printenv HTTPS_PROXY',
        cwd: null,
        timeout_ms: 5000,
      });
      assert.equal(r.ok, true);
      if (r.ok) {
        assert.doesNotMatch(r.data.stdout, /user|s3cret/);
        assert.match(r.data.stdout, /proxy\.example/);
      }
    } finally {
      if (prev === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = prev;
    }
  });

  it("invocation uses bash -c not bash -lc", async () => {
    const marker = "/modelbot-nologin-bin";
    const prevPath = process.env.PATH;
    process.env.PATH = `${marker}:/usr/bin:/bin`;
    try {
      const r = await shellExec({
        command: 'printf %s "$PATH"; echo; shopt -q login_shell; echo login:$?',
        cwd: null,
        timeout_ms: 5000,
      });
      assert.equal(r.ok, true);
      if (r.ok) {
        assert.match(r.data.stdout, /modelbot-nologin-bin/);
        assert.match(r.data.stdout, /login:1/);
      }
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  });

  it("does not retain collectors without MODELBOT_TEST_SHELL_HOOKS", async () => {
    const prev = process.env.MODELBOT_TEST_SHELL_HOOKS;
    delete process.env.MODELBOT_TEST_SHELL_HOOKS;
    try {
      const r = await shellExec({
        command: "echo gated",
        cwd: null,
        timeout_ms: 5000,
      });
      assert.equal(r.ok, true);
      assert.equal(lastCollectors, null);
    } finally {
      if (prev === undefined) delete process.env.MODELBOT_TEST_SHELL_HOOKS;
      else process.env.MODELBOT_TEST_SHELL_HOOKS = prev;
    }
  });
});
