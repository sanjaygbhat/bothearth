/**
 * `/api/v1/runtime` over HTTP: it sits behind the same
 * session auth as every other UI route, `/runtime/prepare` is CSRF-protected,
 * and a fresh install (model configured, no credential) must NOT claim it can
 * start a task — the `server.ts` + `example.yaml` first-run lie.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createFakeSandbox } from "../../../src/computer-client/fake-sandbox.ts";
import { CSRF_HEADER } from "../../../src/daemon/auth.ts";
import { startDaemon, type DaemonHandle } from "../../../src/daemon/server.ts";
import { Store } from "../../../src/daemon/store.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";
import { until } from "../../helpers/until.ts";

process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";

const MCP = "test-mcp-token-runtime";
const BOOT = "test-boot-token-runtime";

const adapter = { kind: "openai_compat" as const, complete: async () => { throw new Error("adapter not used in these tests"); } };

async function daemonWith(credentialed: boolean | undefined): Promise<DaemonHandle> {
  return await startDaemon({
    host: "127.0.0.1",
    port: 0,
    mcpToken: MCP,
    bootstrapToken: BOOT,
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-runtime-")),
    dataDir: mkdtempSync(join(tmpdir(), "mb-runtime-data-")),
    agentLoop: { model: "gpt-5.6-sol", adapter, ...(credentialed === undefined ? {} : { credentialed }) },
  });
}

describe("/api/v1/runtime", () => {
  let daemon: DaemonHandle;
  let origin: string;
  let session: { cookie: string; csrf: string };

  before(async () => {
    daemon = await daemonWith(false);
    origin = `http://127.0.0.1:${daemon.port}`;
    session = await bootstrapSession(daemon, BOOT);
  });
  after(async () => { await daemon.close(); });

  const headers = (extra: Record<string, string> = {}) => ({
    Origin: origin,
    Host: `127.0.0.1:${daemon.port}`,
    ...extra,
  });

  it("refuses an unauthenticated read", async () => {
    const res = await fetch(`${daemon.baseUrl}/api/v1/runtime`, { headers: headers() });
    assert.equal(res.status, 401);
  });

  it("returns the full ladder to a signed-in operator and never leaks a secret", async () => {
    const res = await fetch(`${daemon.baseUrl}/api/v1/runtime`, {
      headers: headers({ cookie: session.cookie }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, any>;
    assert.deepEqual(Object.keys(body).sort(), ["ai", "blockers", "docker", "images", "licence", "node", "task_start_available"]);
    assert.equal(typeof body.node.ok, "boolean");
    assert.equal(typeof body.docker.installed, "boolean");
    for (const name of ["computer", "shell", "proxy"]) {
      assert.equal(typeof body.images[name].present, "boolean");
      assert.ok("created_at" in body.images[name]);
    }
    assert.equal(body.images.prepare.state, "idle");
    assert.ok(Array.isArray(body.blockers));
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, new RegExp(`${MCP}|${BOOT}`));
  });

  it("refuses prepare without CSRF", async () => {
    const res = await fetch(`${daemon.baseUrl}/api/v1/runtime/prepare`, {
      method: "POST",
      headers: headers({ cookie: session.cookie }),
    });
    assert.equal(res.status, 403);
  });

  it("refuses prepare without a session", async () => {
    const res = await fetch(`${daemon.baseUrl}/api/v1/runtime/prepare`, {
      method: "POST",
      headers: headers({ [CSRF_HEADER]: session.csrf }),
    });
    assert.equal(res.status, 401);
  });
});

describe("first-run must not claim it is connected", () => {
  it("a configured model with no credential cannot start a task and says why", async () => {
    const daemon = await daemonWith(false);
    try {
      const session = await bootstrapSession(daemon, BOOT);
      const res = await fetch(`${daemon.baseUrl}/api/v1/session`, {
        headers: { Origin: `http://127.0.0.1:${daemon.port}`, Host: `127.0.0.1:${daemon.port}`, cookie: session.cookie },
      });
      const body = await res.json() as { task_start_available: boolean; standalone_available: boolean; execution_mode: string | null };
      assert.equal(body.standalone_available, false);
      assert.equal(body.task_start_available, false);
      assert.equal(body.execution_mode, null);

      const runtime = await (await fetch(`${daemon.baseUrl}/api/v1/runtime`, {
        headers: { Origin: `http://127.0.0.1:${daemon.port}`, Host: `127.0.0.1:${daemon.port}`, cookie: session.cookie },
      })).json() as { task_start_available: boolean; blockers: Array<{ id: string }> };
      assert.equal(runtime.task_start_available, false);
      assert.ok(runtime.blockers.some((b) => b.id === "ai_not_connected"));
    } finally {
      await daemon.close();
    }
  });

  it("a credentialed model is connected, and an unspecified credential keeps in-process callers working", async () => {
    for (const credentialed of [true, undefined] as const) {
      const daemon = await daemonWith(credentialed);
      try {
        const session = await bootstrapSession(daemon, BOOT);
        const body = await (await fetch(`${daemon.baseUrl}/api/v1/session`, {
          headers: { Origin: `http://127.0.0.1:${daemon.port}`, Host: `127.0.0.1:${daemon.port}`, cookie: session.cookie },
        })).json() as { task_start_available: boolean; execution_mode: string | null };
        assert.equal(body.task_start_available, true);
        assert.equal(body.execution_mode, "standalone");
      } finally {
        await daemon.close();
      }
    }
  });
});

describe("first-run CLI adoption over HTTP", () => {
  let daemon: DaemonHandle;
  let origin: string;
  let session: { cookie: string; csrf: string };
  let cliDir: string;
  const previousToolPath = process.env.MODELBOT_TOOL_PATH;

  /** A fake CLI that records every invocation and reports "not signed in". */
  function fakeLoginCli(dir: string, name: string): string {
    const path = join(dir, name);
    writeFileSync(path, [`#!/bin/sh`, `echo "$@" >> "${join(dir, `${name}.calls`)}"`, `exit 1`, ``].join("\n"));
    chmodSync(path, 0o755);
    return path;
  }

  before(async () => {
    cliDir = mkdtempSync(join(tmpdir(), "mb-adoption-cli-"));
    fakeLoginCli(cliDir, "docker");
    process.env.MODELBOT_TOOL_PATH = cliDir;
    daemon = await startDaemon({
      host: "127.0.0.1",
      port: 0,
      mcpToken: MCP,
      bootstrapToken: BOOT,
      workspaceRoot: mkdtempSync(join(tmpdir(), "mb-adoption-")),
      dataDir: mkdtempSync(join(tmpdir(), "mb-adoption-data-")),
      autoConnectProvider: true,
      claudeLogin: { binary: fakeLoginCli(cliDir, "claude") },
      codexLogin: { binary: fakeLoginCli(cliDir, "codex") },
      agentLoop: { model: "gpt-5.6-sol", adapter },
    });
    origin = `http://127.0.0.1:${daemon.port}`;
    session = await bootstrapSession(daemon, BOOT);
  });
  after(async () => {
    await daemon.close();
    if (previousToolPath === undefined) delete process.env.MODELBOT_TOOL_PATH;
    else process.env.MODELBOT_TOOL_PATH = previousToolPath;
  });

  const headers = (extra: Record<string, string> = {}) => ({
    Origin: origin, Host: `127.0.0.1:${daemon.port}`, cookie: session.cookie, ...extra,
  });

it("raw docker build output never crosses the wire", async () => {
    const res = await fetch(`${daemon.baseUrl}/api/v1/runtime`, { headers: headers() });
    assert.equal(res.status, 200);
    const body = await res.json() as { images: { prepare: PrepareState } };
    assert.deepEqual(body.images.prepare.log_tail, [],
      "the tail stays in the build log the failure message points at");
  });

it("prepare is rate limited, not only guarded while running", async () => {
    const post = () => fetch(`${daemon.baseUrl}/api/v1/runtime/prepare`, {
      method: "POST", headers: headers({ [CSRF_HEADER]: session.csrf }),
    });
    const first = await post();
    assert.ok([202, 409].includes(first.status), `unexpected ${first.status}`);
    const second = await post();
    assert.equal(second.status, 429, "a second attempt inside the cooldown is refused");
    assert.ok(Number(second.headers.get("retry-after")) > 0);
    assert.equal((await second.json() as { error: string }).error, "E_BUSY");
  });

it("polling the first-run screen does not respawn the CLI probes forever", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const calls = () => ["claude", "codex"].reduce((n, name) => {
      const path = join(cliDir, `${name}.calls`);
      return n + (existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length : 0);
    }, 0);
    const before = calls();
    for (let i = 0; i < 30; i++) {
      await fetch(`${daemon.baseUrl}/api/v1/runtime`, { headers: headers() });
    }
    // The readiness cache TTL is 2 s and adoption backs off from 2 s to 60 s,
    // so a burst of polls must not become a burst of processes.
    assert.ok(calls() - before <= 4, `adoption spawned ${calls() - before} CLI probes across 30 polls`);
  });
});

describe("boot reconcile lifetime", () => {
  function seedComputers(root: string, ids: string[]): string {
    const sqlitePath = join(root, "state.sqlite");
    const seed = new Store(sqlitePath);
    for (const [i, id] of ids.entries()) {
      seed.insertComputer({
        id,
        name: `Idle ${i + 1}`,
        capabilities: ["browser"],
        persistent: true,
        status: "running",
      });
    }
    seed.close();
    return sqlitePath;
  }

  function spyStoreAfterClose(store: Store): { afterClose: string[]; closed: () => boolean } {
    let closed = false;
    const afterClose: string[] = [];
    const target = store as Store & Record<string, unknown>;
    const origClose = store.close.bind(store);
    target.close = () => {
      closed = true;
      origClose();
    };
    for (const name of ["listComputers", "listTasks", "activeTakeoverForComputer"] as const) {
      const orig = (store[name] as (...args: never[]) => unknown).bind(store);
      target[name] = (...args: never[]) => {
        if (closed) afterClose.push(name);
        return orig(...args);
      };
    }
    return { afterClose, closed: () => closed };
  }

  it("close immediately after start does not reject", async () => {
    const root = mkdtempSync(join(tmpdir(), "mb-reconcile-life-"));
    const sqlitePath = seedComputers(root, ["idle-a", "idle-b"]);
    let releaseLimits = () => {};
    const limitsHeld = new Promise<void>((resolve) => {
      releaseLimits = resolve;
    });
    const sandbox = createFakeSandbox({ workspaceRoot: root }) as ReturnType<typeof createFakeSandbox> & {
      reconcileLimits: (
        computerId: string,
        capabilities: string[],
        opts: { allowRecreate: boolean },
      ) => Promise<"updated" | "recreated" | false>;
      refreshImage: (computerId: string, capabilities: string[]) => Promise<boolean>;
    };
    let enteredLimits = 0;
    let daemon: DaemonHandle;
    sandbox.reconcileLimits = async () => {
      enteredLimits++;
      await new Promise((resolve) => setImmediate(resolve));
      await limitsHeld;
      daemon.store.listComputers();
      return "updated";
    };
    sandbox.refreshImage = async () => {
      daemon.store.listTasks();
      return false;
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    daemon = await startDaemon({
      host: "127.0.0.1",
      port: 0,
      mcpToken: MCP,
      bootstrapToken: BOOT,
      workspaceRoot: root,
      sqlitePath,
      sandbox,
      agentLoop: { model: "gpt-5.6-sol", adapter },
    });
    const spy = spyStoreAfterClose(daemon.store);
    try {
      await until(() => enteredLimits > 0, "boot reconcile never entered limits");
      let closeDone = false;
      const closed = daemon.close().then(() => {
        closeDone = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(closeDone, false, "close() must wait for in-flight reconcile");
      assert.equal(spy.closed(), false, "store must stay open until reconcile finishes");
      releaseLimits();
      await closed;
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(unhandled.length, 0);
      assert.deepEqual(spy.afterClose, []);
    } finally {
      releaseLimits();
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("close waits for post-prepare reconcile", async () => {
    const root = mkdtempSync(join(tmpdir(), "mb-reconcile-prepare-"));
    const sqlitePath = seedComputers(root, ["idle-a", "idle-b"]);
    let holdPrepare = false;
    let inHold = 0;
    let releaseLimits = () => {};
    const limitsHeld = new Promise<void>((resolve) => {
      releaseLimits = resolve;
    });
    let limitCalls = 0;
    const sandbox = createFakeSandbox({ workspaceRoot: root }) as ReturnType<typeof createFakeSandbox> & {
      reconcileLimits: (
        computerId: string,
        capabilities: string[],
        opts: { allowRecreate: boolean },
      ) => Promise<"updated" | "recreated" | false>;
    };
    let daemon: DaemonHandle;
    sandbox.reconcileLimits = async () => {
      limitCalls++;
      if (holdPrepare) {
        inHold++;
        await limitsHeld;
        daemon.store.listComputers();
      }
      await new Promise((resolve) => setImmediate(resolve));
      return "updated";
    };
    daemon = await startDaemon({
      host: "127.0.0.1",
      port: 0,
      mcpToken: MCP,
      bootstrapToken: BOOT,
      workspaceRoot: root,
      sqlitePath,
      sandbox,
      agentLoop: { model: "gpt-5.6-sol", adapter },
      runBuild: async () => 0,
    });
    const spy = spyStoreAfterClose(daemon.store);
    try {
      await until(() => limitCalls >= 2, "boot reconcile never finished");
      holdPrepare = true;
      const session = await bootstrapSession(daemon, BOOT);
      const origin = `http://127.0.0.1:${daemon.port}`;
      const headers = {
        Origin: origin,
        Host: `127.0.0.1:${daemon.port}`,
        cookie: session.cookie,
        [CSRF_HEADER]: session.csrf,
      };
      const posted = await fetch(`${daemon.baseUrl}/api/v1/runtime/prepare`, {
        method: "POST",
        headers,
      });
      assert.equal(posted.status, 202);
      await until(() => inHold > 0, "prepare reconcile never entered limits");
      let closeDone = false;
      const closed = daemon.close().then(() => {
        closeDone = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(closeDone, false, "close() must wait for post-prepare reconcile");
      assert.equal(spy.closed(), false);
      releaseLimits();
      await closed;
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(spy.afterClose, []);
    } finally {
      releaseLimits();
      if (!spy.closed()) await daemon.close().catch(() => undefined);
    }
  });
});
