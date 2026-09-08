import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, statSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduler } from "node:timers/promises";
import { describe, it } from "node:test";
import {
  awaitFreeDaemonSlot,
  clearOwnPid,
  daemonAddress,
  filterDaemonExecArgv,
  runStop,
  spawnDaemon,
} from "../../../src/cli/daemon-ctl.ts";

describe("spawnDaemon execArgv", () => {
  it("drops --inspect so spawnDaemon child argv cannot open a debugger", () => {
    const argv = filterDaemonExecArgv([
      "--inspect=9229",
      "--inspect-brk",
      "--experimental-strip-types",
      "--no-warnings",
      "--conditions=node",
    ]);
    assert.ok(!argv.some((a) => /^--inspect/.test(a)));
    assert.deepEqual(argv, [
      "--experimental-strip-types",
      "--no-warnings",
      "--conditions=node",
    ]);
  });
});

// No config: the child must report startup failure, never a running PID.
it("daemon startup failure rejects, keeps its log private and leaves no pid", async () => {
  const home = mkdtempSync(join(tmpdir(), "modelbot-start-failure-"));
  const log = join(home, "daemon.log");
  writeFileSync(log, "prior bootstrap output\n", { mode: 0o644 });
  await assert.rejects(spawnDaemon([], home, []), /exited before ready/);
  assert.equal(statSync(log).mode & 0o777, 0o600);
  assert.equal(existsSync(join(home, "daemon.pid")), false);
});

/**
 * A pid file is not a running daemon. It survives a crash, and it survives the
 * seconds a graceful shutdown takes — during which the port is already closed.
 * Treating it as proof made `start --daemon` a no-op that left nothing serving.
 */
describe("stale and shutting-down pid files", () => {
  const alivePid = (home: string, seconds = 30): ChildProcess => {
    const child = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${seconds * 1000})`], {
      stdio: "ignore",
    });
    writeFileSync(join(home, "daemon.pid"), `${child.pid}\n`);
    return child;
  };

  it("clears a pid file whose process is dead and lets the daemon start", async () => {
    const home = mkdtempSync(join(tmpdir(), "modelbot-stale-pid-"));
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(dead, "exit");
    writeFileSync(join(home, "daemon.pid"), `${dead.pid}\n`);
    const lines: string[] = [];
    await awaitFreeDaemonSlot([], home, (l) => lines.push(l));
    assert.equal(existsSync(join(home, "daemon.pid")), false);
    assert.deepEqual(lines, []);
  });

  it("waits for a live process that is not listening, then clears its pid file", async () => {
    const home = mkdtempSync(join(tmpdir(), "modelbot-shutting-down-"));
    const child = alivePid(home);
    const lines: string[] = [];
    const waited = awaitFreeDaemonSlot(["--port", "1"], home, (l) => lines.push(l));
    await scheduler.wait(150);
    assert.equal(existsSync(join(home, "daemon.pid")), true, "waits instead of racing the exit");
    child.kill("SIGKILL");
    await waited;
    assert.equal(existsSync(join(home, "daemon.pid")), false);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /shutting down; waiting up to 10s/);
  });

  it("gives up once the shutdown runs past the wait", async () => {
    const home = mkdtempSync(join(tmpdir(), "modelbot-stuck-shutdown-"));
    const child = alivePid(home);
    try {
      await assert.rejects(
        awaitFreeDaemonSlot(["--port", "1"], home, () => {}, 1_200),
        /still shutting down after 1s/,
      );
      assert.equal(existsSync(join(home, "daemon.pid")), true);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("refuses to start beside a process that is actually listening", async () => {
    const home = mkdtempSync(join(tmpdir(), "modelbot-listening-"));
    const child = alivePid(home);
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await assert.rejects(
        awaitFreeDaemonSlot(["--port", String(port)], home, () => {}),
        new RegExp(`daemon already running pid=${child.pid}`),
      );
      assert.equal(existsSync(join(home, "daemon.pid")), true);
    } finally {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("daemonAddress", () => {
  it("prefers flags over the config file, and falls back when there is none", () => {
    const saved = { ...process.env };
    delete process.env.MODELBOT_HOST;
    delete process.env.MODELBOT_BIND;
    delete process.env.MODELBOT_PORT;
    try {
      const home = mkdtempSync(join(tmpdir(), "modelbot-address-"));
      writeFileSync(join(home, "modelbot.yaml"), "bind: ::1\nport: 9200\n");
      assert.deepEqual(daemonAddress([], home), { host: "::1", port: 9200 });
      assert.deepEqual(daemonAddress(["--port", "9100"], home), { host: "::1", port: 9100 });
      assert.deepEqual(daemonAddress([], join(home, "none")), { host: "127.0.0.1", port: 7777 });
    } finally {
      process.env = saved;
    }
  });
});

describe("clearOwnPid", () => {
  it("removes only a pid file that still names this process", () => {
    const home = mkdtempSync(join(tmpdir(), "modelbot-own-pid-"));
    const pidFile = join(home, "daemon.pid");
    writeFileSync(pidFile, `${process.pid + 1}\n`);
    clearOwnPid(home);
    assert.equal(existsSync(pidFile), true, "a successor daemon's pid file is not ours to delete");
    writeFileSync(pidFile, `${process.pid}\n`);
    clearOwnPid(home);
    assert.equal(existsSync(pidFile), false);
  });
});

/** SIGTERM returns before the process is gone; `stop` must outlive the exit. */
describe("runStop", () => {
  it("waits for the process to exit and removes the pid file", async () => {
    const home = mkdtempSync(join(tmpdir(), "modelbot-stop-"));
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    writeFileSync(join(home, "daemon.pid"), `${child.pid}\n`);
    await runStop(["--home", home]);
    assert.equal(existsSync(join(home, "daemon.pid")), false);
    assert.equal(child.killed || child.exitCode !== null || child.signalCode !== null, true);
  });

  it("clears a stale pid file without killing anything", async () => {
    const home = mkdtempSync(join(tmpdir(), "modelbot-stop-stale-"));
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(dead, "exit");
    writeFileSync(join(home, "daemon.pid"), `${dead.pid}\n`);
    await runStop(["--home", home]);
    assert.equal(existsSync(join(home, "daemon.pid")), false);
  });
});
