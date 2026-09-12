import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakeSandbox } from "../../../src/computer-client/fake-sandbox.ts";
import { fakeComputerFor } from "../../../src/computer-client/fake.ts";
import { createCodexConnection, type CodexLoginOptions } from "../../../src/daemon/codex-connection.ts";
import { startDaemon, type DaemonHandle } from "../../../src/daemon/server.ts";
import { Store } from "../../../src/daemon/store.ts";
import { decodeLiveFrame } from "../../../src/protocol/live.ts";
import { bootstrapSession, type DaemonSession } from "../../helpers/daemon.ts";
import { fakeCli } from "../../helpers/fake-cli.ts";
import { until } from "../../helpers/until.ts";

process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";

async function fixture(opts?: { inspectStatus?: () => Promise<"running" | "paused" | "stopped" | undefined>; start?: (id: string) => Promise<void>; maxComputers?: number; codexLogin?: CodexLoginOptions }) {
  const root = mkdtempSync(join(tmpdir(), "mb-computer-recovery-"));
  const sandbox = createFakeSandbox({ workspaceRoot: root });
  const starts: string[] = [];
  const start = sandbox.start.bind(sandbox);
  sandbox.start = async (id) => {
    starts.push(id);
    if (opts?.start) return opts.start(id);
    return start(id);
  };
  if (opts?.inspectStatus) sandbox.inspectStatus = opts.inspectStatus;
  const daemon = await startDaemon({
    port: 0, workspaceRoot: root, sandbox, bootstrapToken: "recovery-boot", mcpToken: "recovery-mcp",
    nativeExecutionLocation: "computer",
    ...(opts?.maxComputers !== undefined ? { maxComputers: opts.maxComputers } : {}),
    ...(opts?.codexLogin ? { codexLogin: opts.codexLogin } : {}),
    agentLoop: { model: "synthetic", adapter: { kind: "openai_compat", complete: (request) => new Promise((_, reject) => {
      if (request.signal?.aborted) reject(new Error("cancelled"));
      else request.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }) } },
  });
  const { headers } = await bootstrapSession(daemon, "recovery-boot");
  const api = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`${daemon.baseUrl}${path}`, {
      headers, method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { daemon, api, starts, sandbox, async close() { await daemon.close(); } };
}

test("connection status starts a running computer before probing and never returns an empty error", async () => {
  const f = await fixture({ start: async () => { throw new Error("Cannot connect to the Docker daemon"); } });
  try {
    f.daemon.store.insertComputer({ id: "browser-held", name: "My browser", capabilities: ["browser"], persistent: true, status: "running" });
    const result = await f.api("/api/v1/connection");
    assert.equal(result.status, 200);
    assert.deepEqual(f.starts, ["browser-held"]);
    assert.equal(result.body.status, "error");
    assert.equal(result.body.message, "Docker is not reachable");
    assert.notEqual(result.body.message, "");
    assert.deepEqual(result.body.recovery, { action: "check_again", label: "Check again" });
  } finally { await f.close(); }
});

test("connection status does not start an intentionally stopped computer and offers Start computer", async () => {
  const f = await fixture();
  try {
    f.daemon.store.insertComputer({ id: "browser-off", name: "My browser", capabilities: ["browser"], persistent: true, status: "stopped" });
    const result = await f.api("/api/v1/connection");
    assert.equal(result.status, 200);
    assert.deepEqual(f.starts, []);
    assert.equal(result.body.status, "error");
    assert.equal(result.body.message, "The bot’s computer is not running");
    assert.deepEqual(result.body.recovery, { action: "start_computer", label: "Start computer" });
  } finally { await f.close(); }
});

test("computer list reports an exited container as not running", async () => {
  const f = await fixture({ inspectStatus: async () => "stopped" });
  try {
    f.daemon.store.insertComputer({ id: "browser-exited", name: "My browser", capabilities: ["browser"], persistent: true, status: "running" });
    const listed = await f.api("/api/v1/computers");
    assert.equal(listed.status, 200);
    const computers = listed.body.computers as Array<{ id: string; status: string }>;
    assert.equal(computers.find((c) => c.id === "browser-exited")?.status, "stopped");
    assert.equal(f.daemon.store.getComputer("browser-exited")?.status, "running");
  } finally { await f.close(); }
});

test("starting another task while a paused hold is open names the holding task", async () => {
  const f = await fixture();
  try {
    const created = await f.api("/api/v1/computers", { name: "Held", capabilities: ["browser"] });
    const computerId = (created.body.computer as { id: string }).id;
    const task = f.daemon.store.insertTask({ computer_id: computerId, goal: "Finish signing in to the airline", max_steps: 5 });
    f.daemon.store.pauseTask(task.id);
    const hold = f.daemon.store.insertTakeover({
      id: "tk_held", computer_id: computerId, task_id: task.id, state: "paused",
      expires_at: new Date(Date.now() - 23 * 3600_000).toISOString(),
    });
    const blocked = await f.api("/api/v1/tasks", { goal: "Something else", capabilities: ["browser"] });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "E_STATE");
    assert.equal(blocked.body.task_id, task.id);
    assert.equal(blocked.body.takeover_id, hold.id);
    assert.match(String(blocked.body.message), /Finish signing in to the airline/);
    assert.match(String(blocked.body.message), /Open it to resume, stop it, or return control/);
    const computers = blocked.body.computers as Array<{ id: string; name: string; state: string }>;
    assert.ok(Array.isArray(computers));
    assert.equal(computers.find((row) => row.id === computerId)?.state, "human-hold");
    assert.equal(blocked.body.max_computers, 2);
  } finally { await f.close(); }
});

test("a paused human task on one computer does not block a new task on an idle computer", async () => {
  const f = await fixture();
  try {
    const held = await f.api("/api/v1/computers", { name: "Held", capabilities: ["browser"] });
    const idle = await f.api("/api/v1/computers", { name: "Idle", capabilities: ["browser"] });
    const heldId = (held.body.computer as { id: string }).id;
    const idleId = (idle.body.computer as { id: string }).id;
    const task = f.daemon.store.insertTask({ computer_id: heldId, goal: "Finish signing in", max_steps: 5 });
    f.daemon.store.pauseTask(task.id);
    f.daemon.store.insertTakeover({
      id: "tk_held_a", computer_id: heldId, task_id: task.id, state: "paused",
      expires_at: new Date(Date.now() - 23 * 3600_000).toISOString(),
    });
    const started = await f.api("/api/v1/tasks", { computer_id: idleId, goal: "Something else", capabilities: ["browser"] });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    assert.equal((started.body.task as { computer_id: string }).computer_id, idleId);
    assert.equal((await f.api(`/api/v1/computers/${heldId}/default`, {})).status, 200);
    const again = await f.api("/api/v1/tasks", { goal: "Another on the busy one", capabilities: ["browser"] });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "E_STATE");
    const computers = again.body.computers as Array<{ id: string; state: string }>;
    assert.equal(computers.find((row) => row.id === heldId)?.state, "human-hold");
    assert.equal(computers.find((row) => row.id === idleId)?.state, "running");
  } finally { await f.close(); }
});

test("a second task on the same busy computer is refused and lists every computer", async () => {
  const f = await fixture();
  try {
    const created = await f.api("/api/v1/computers", { name: "Busy", capabilities: ["browser"] });
    const computerId = (created.body.computer as { id: string }).id;
    const first = await f.api("/api/v1/tasks", { goal: "First job", capabilities: ["browser"] });
    assert.equal(first.status, 201);
    const blocked = await f.api("/api/v1/tasks", { goal: "Second job", capabilities: ["browser"] });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "E_TASK_ACTIVE");
    assert.equal(blocked.body.task_id, (first.body.task as { id: string }).id);
    const computers = blocked.body.computers as Array<{ id: string; state: string }>;
    assert.equal(computers.find((row) => row.id === computerId)?.state, "running");
  } finally { await f.close(); }
});

test("creating a computer is refused at the configured maximum", async () => {
  const f = await fixture({ maxComputers: 2 });
  try {
    assert.equal((await f.api("/api/v1/computers", { name: "One", capabilities: ["browser"] })).status, 201);
    assert.equal((await f.api("/api/v1/computers", { name: "Two", capabilities: ["browser"] })).status, 201);
    const listed = await f.api("/api/v1/computers");
    assert.equal(listed.body.max_computers, 2);
    const refused = await f.api("/api/v1/computers", { name: "Three", capabilities: ["browser"] });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, "E_LIMIT");
    assert.equal(refused.body.max_computers, 2);
    assert.match(String(refused.body.message), /2 computers, the maximum/);
  } finally { await f.close(); }
});

test("release of an already-returned hold is idempotent; a requested hold explains why it is invalid", async () => {
  const f = await fixture();
  try {
    const created = await f.api("/api/v1/computers", { name: "Control", capabilities: ["browser"] });
    const computerId = (created.body.computer as { id: string }).id;
    const requested = await f.api("/api/v1/takeover/request", { computer_id: computerId, reason: "ui" });
    const id = (requested.body.takeover as { takeover_id: string }).takeover_id;
    const invalid = await f.api(`/api/v1/takeover/${id}/release`, {});
    assert.equal(invalid.status, 409);
    assert.equal(invalid.body.error, "E_POLICY");
    assert.match(String(invalid.body.message), /not been taken yet/i);

    const granted = await f.api(`/api/v1/takeover/${id}/acquire`, {});
    assert.equal(granted.status, 200);
    assert.equal((await f.api(`/api/v1/takeover/${id}/release`, {})).status, 200);
    const again = await f.api(`/api/v1/takeover/${id}/release`, {});
    assert.equal(again.status, 200);
    assert.equal((again.body.takeover as { state: string }).state, "agent");
  } finally { await f.close(); }
});

test("release of a paused hold checks the screen then returns control", async () => {
  const f = await fixture();
  try {
    const created = await f.api("/api/v1/computers", { name: "Paused hold", capabilities: ["browser"] });
    const computerId = (created.body.computer as { id: string }).id;
    const requested = await f.api("/api/v1/takeover/request", { computer_id: computerId, reason: "ui" });
    const id = (requested.body.takeover as { takeover_id: string }).takeover_id;
    f.daemon.store.updateTakeoverState(id, "paused");
    const returned = await f.api(`/api/v1/takeover/${id}/release`, {});
    assert.equal(returned.status, 200, JSON.stringify(returned.body));
    assert.equal(f.daemon.store.getTakeover(id)?.state, "agent");
    const again = await f.api(`/api/v1/takeover/${id}/release`, {});
    assert.equal(again.status, 200);
    assert.equal((again.body.takeover as { state: string }).state, "agent");
  } finally { await f.close(); }
});

test("a paused fake computer reports inspectStatus paused", async () => {
  const sandbox = createFakeSandbox({ workspaceRoot: mkdtempSync(join(tmpdir(), "mb-fake-paused-")) });
  const handle = await sandbox.create({ name: "held", capabilities: ["browser"] });
  assert.equal(await sandbox.inspectStatus(handle.computer_id), "running");
  sandbox.get(handle.computer_id)!.status = "paused";
  assert.equal(await sandbox.inspectStatus(handle.computer_id), "paused");
  await assert.rejects(sandbox.start(handle.computer_id), /Cannot start a paused container/);
  assert.equal(await sandbox.inspectStatus(handle.computer_id), "paused");
});

test("connection status does not start a computer that still has a hold", async () => {
  const f = await fixture();
  try {
    f.daemon.store.insertComputer({ id: "browser-held", name: "My browser", capabilities: ["browser"], persistent: true, status: "running" });
    const task = f.daemon.store.insertTask({ computer_id: "browser-held", goal: "Finish signing in", max_steps: 5 });
    f.daemon.store.pauseTask(task.id);
    f.daemon.store.insertTakeover({
      id: "tk_probe_hold", computer_id: "browser-held", task_id: task.id, state: "paused",
      expires_at: new Date(Date.now() - 23 * 3600_000).toISOString(),
    });
    const result = await f.api("/api/v1/connection");
    assert.equal(result.status, 200);
    assert.deepEqual(f.starts, []);
  } finally { await f.close(); }
});

test("connection status does not start a computer Docker has paused", async () => {
  const f = await fixture({ inspectStatus: async () => "paused" });
  try {
    f.daemon.store.insertComputer({ id: "browser-idle", name: "My browser", capabilities: ["browser"], persistent: true, status: "running" });
    const result = await f.api("/api/v1/connection");
    assert.equal(result.status, 200);
    assert.deepEqual(f.starts, []);
    const runtime = await f.api("/api/v1/runtime");
    assert.equal(runtime.status, 200);
    assert.deepEqual(f.starts, []);
  } finally { await f.close(); }
});

test("connection status starts a store-running computer whose container has exited", async () => {
  const f = await fixture({ inspectStatus: async () => "stopped" });
  try {
    f.daemon.store.insertComputer({ id: "browser-restarted", name: "My browser", capabilities: ["browser"], persistent: true, status: "running" });
    const result = await f.api("/api/v1/connection");
    assert.equal(result.status, 200);
    assert.deepEqual(f.starts, ["browser-restarted"]);
  } finally { await f.close(); }
});

test("boot image refresh recreates an idle-paused computer without a task", async () => {
  const root = mkdtempSync(join(tmpdir(), "mb-boot-paused-"));
  const sqlitePath = join(root, "state.sqlite");
  const seed = new Store(sqlitePath);
  seed.insertComputer({ id: "browser-idle", name: "Idle", capabilities: ["browser"], persistent: true, status: "running" });
  seed.close();
  const sandbox = createFakeSandbox({ workspaceRoot: root }) as ReturnType<typeof createFakeSandbox> & {
    refreshImage: (computerId: string) => Promise<boolean>;
  };
  const refreshed: string[] = [];
  sandbox.refreshImage = async (id) => { refreshed.push(id); return true; };
  sandbox.inspectStatus = async () => "paused";
  const daemon = await startDaemon({
    port: 0, sqlitePath, workspaceRoot: root, sandbox, bootstrapToken: "boot-paused", mcpToken: "boot-paused-mcp",
    nativeExecutionLocation: "computer",
  });
  try {
    await until(() => refreshed.includes("browser-idle"), "boot never refreshed the idle-paused computer");
  } finally { await daemon.close(); }
});

test("boot image refresh skips a computer with an active human hold", async () => {
  const root = mkdtempSync(join(tmpdir(), "mb-boot-hold-"));
  const sqlitePath = join(root, "state.sqlite");
  const seed = new Store(sqlitePath);
  seed.insertComputer({ id: "browser-held", name: "Held", capabilities: ["browser"], persistent: true, status: "running" });
  seed.insertComputer({ id: "browser-idle", name: "Idle", capabilities: ["browser"], persistent: true, status: "running" });
  const task = seed.insertTask({ computer_id: "browser-held", goal: "Sign in", max_steps: 5 });
  seed.pauseTask(task.id);
  seed.insertTakeover({
    id: "tk_hold", computer_id: "browser-held", task_id: task.id, state: "human",
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  });
  seed.close();
  const sandbox = createFakeSandbox({ workspaceRoot: root }) as ReturnType<typeof createFakeSandbox> & {
    refreshImage: (computerId: string) => Promise<boolean>;
  };
  const refreshed: string[] = [];
  sandbox.refreshImage = async (id) => { refreshed.push(id); return true; };
  const daemon = await startDaemon({
    port: 0, sqlitePath, workspaceRoot: root, sandbox, bootstrapToken: "boot-hold", mcpToken: "boot-hold-mcp",
    nativeExecutionLocation: "computer",
  });
  try {
    await until(() => refreshed.includes("browser-idle"), "boot never refreshed the idle computer");
    assert.equal(refreshed.includes("browser-held"), false);
  } finally { await daemon.close(); }
});

test("boot image refresh skips a computer with a running task", async () => {
  const root = mkdtempSync(join(tmpdir(), "mb-boot-running-"));
  const sqlitePath = join(root, "state.sqlite");
  const seed = new Store(sqlitePath);
  seed.insertComputer({ id: "browser-busy", name: "Busy", capabilities: ["browser"], persistent: true, status: "running" });
  seed.insertComputer({ id: "browser-idle", name: "Idle", capabilities: ["browser"], persistent: true, status: "running" });
  seed.insertTask({ computer_id: "browser-busy", goal: "Keep going", max_steps: 5 });
  seed.close();
  const sandbox = createFakeSandbox({ workspaceRoot: root }) as ReturnType<typeof createFakeSandbox> & {
    refreshImage: (computerId: string) => Promise<boolean>;
  };
  const refreshed: string[] = [];
  sandbox.refreshImage = async (id) => { refreshed.push(id); return true; };
  const daemon = await startDaemon({
    port: 0, sqlitePath, workspaceRoot: root, sandbox, bootstrapToken: "boot-running", mcpToken: "boot-running-mcp",
    nativeExecutionLocation: "computer",
  });
  try {
    await until(() => refreshed.includes("browser-idle"), "boot never refreshed the idle computer");
    assert.equal(refreshed.includes("browser-busy"), false);
  } finally { await daemon.close(); }
});

test("boot image refresh skips a paused task and reports image_drifted", async () => {
  const root = mkdtempSync(join(tmpdir(), "mb-boot-task-paused-"));
  const sqlitePath = join(root, "state.sqlite");
  const seed = new Store(sqlitePath);
  seed.insertComputer({ id: "browser-paused", name: "Paused", capabilities: ["browser"], persistent: true, status: "running" });
  seed.insertComputer({ id: "browser-idle", name: "Idle", capabilities: ["browser"], persistent: true, status: "running" });
  const task = seed.insertTask({ computer_id: "browser-paused", goal: "Resume later", max_steps: 5, adapter: "codex" });
  seed.pauseTask(task.id);
  seed.close();
  const sandbox = createFakeSandbox({ workspaceRoot: root }) as ReturnType<typeof createFakeSandbox> & {
    refreshImage: (computerId: string) => Promise<boolean>;
    imageDrifted: (computerId: string) => Promise<boolean>;
  };
  const refreshed: string[] = [];
  sandbox.refreshImage = async (id) => { refreshed.push(id); return true; };
  sandbox.imageDrifted = async (id) => id === "browser-paused";
  sandbox.inspectStatus = async () => "paused";
  const daemon = await startDaemon({
    port: 0, sqlitePath, workspaceRoot: root, sandbox, bootstrapToken: "boot-task-paused", mcpToken: "boot-task-paused-mcp",
    nativeExecutionLocation: "computer",
  });
  try {
    await until(() => refreshed.includes("browser-idle"), "boot never refreshed the idle-paused computer");
    assert.equal(refreshed.includes("browser-paused"), false);
    assert.equal(daemon.store.getTask(task.id)?.status, "paused");
    const { headers } = await bootstrapSession(daemon, "boot-task-paused");
    const listed = await fetch(`${daemon.baseUrl}/api/v1/computers`, { headers });
    assert.equal(listed.status, 200);
    const body = await listed.json() as { computers: Array<{ id: string; image_drifted: boolean }> };
    assert.equal(body.computers.find((c) => c.id === "browser-paused")?.image_drifted, true);
  } finally { await daemon.close(); }
});

test("computer list reports image_drifted per computer", async () => {
  const f = await fixture();
  try {
    f.daemon.store.insertComputer({ id: "browser-stale", name: "Stale", capabilities: ["browser"], persistent: true, status: "running" });
    f.daemon.store.insertComputer({ id: "browser-fresh", name: "Fresh", capabilities: ["browser"], persistent: true, status: "running" });
    (f.sandbox as { imageDrifted?: (id: string) => Promise<boolean> }).imageDrifted = async (id) => id === "browser-stale";
    const listed = await f.api("/api/v1/computers");
    assert.equal(listed.status, 200);
    const computers = listed.body.computers as Array<{ id: string; image_drifted: boolean }>;
    assert.equal(computers.find((c) => c.id === "browser-stale")?.image_drifted, true);
    assert.equal(computers.find((c) => c.id === "browser-fresh")?.image_drifted, false);
  } finally { await f.close(); }
});

test("connection status during a human hold is not signed out", async () => {
  const f = await fixture();
  try {
    f.daemon.store.insertComputer({ id: "browser-held", name: "My browser", capabilities: ["browser"], persistent: true, status: "running" });
    const task = f.daemon.store.insertTask({ computer_id: "browser-held", goal: "Sign in to GitHub", max_steps: 5 });
    f.daemon.store.insertTakeover({
      id: "tk_human", computer_id: "browser-held", task_id: task.id, state: "human",
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    const held = await f.api("/api/v1/connection");
    assert.equal(held.status, 200);
    assert.notEqual(held.body.status, "signed_out");
    assert.equal(held.body.status, "unknown");
    assert.match(String(held.body.message), /check while you have control/i);
    assert.notEqual(held.body.message, "");
    assert.deepEqual(f.starts, [], "a human hold must not launch a guest status probe");
    f.daemon.store.updateTakeoverState("tk_human", "agent");
    const after = await f.api("/api/v1/connection");
    assert.equal(after.status, 200);
    assert.notEqual(after.body.status, "unknown");
    assert.ok(f.starts.includes("browser-held"), "returning control must re-check the CLI");
  } finally { await f.close(); }
});

test("cancelling a task during a human hold does not destroy the computer", async () => {
  const f = await fixture();
  try {
    const created = await f.api("/api/v1/computers", { name: "Kept", capabilities: ["browser"] });
    const computerId = (created.body.computer as { id: string }).id;
    const task = f.daemon.store.insertTask({ computer_id: computerId, goal: "Sign in to GitHub", max_steps: 5 });
    f.daemon.store.insertTakeover({
      id: "tk_keep_home", computer_id: computerId, task_id: task.id, state: "human",
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    assert.equal((await f.api(`/api/v1/tasks/${task.id}/cancel`, {})).status, 200);
    assert.equal(f.daemon.store.getTask(task.id)?.status, "cancelled");
    assert.equal(f.daemon.store.getComputer(computerId)?.status, "running");
    assert.equal(f.sandbox.get(computerId)?.status, "running");
  } finally { await f.close(); }
});

test("release with a password field on screen blanks then returns control", async () => {
  const f = await fixture();
  try {
    const created = await f.api("/api/v1/computers", { name: "Secret", capabilities: ["browser"] });
    const computerId = (created.body.computer as { id: string }).id;
    const requested = await f.api("/api/v1/takeover/request", { computer_id: computerId, reason: "ui" });
    const id = (requested.body.takeover as { takeover_id: string }).takeover_id;
    assert.equal((await f.api(`/api/v1/takeover/${id}/acquire`, {})).status, 200);
    fakeComputerFor(computerId)!.sensitiveField = { kind: "password", label: "password" };
    const released = await f.api(`/api/v1/takeover/${id}/release`, {});
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal((released.body.takeover as { state: string }).state, "agent");
    assert.deepEqual(released.body.cleared, { reason: "password" });
    assert.equal(f.daemon.store.getTakeover(id)?.state, "agent");
    assert.equal(fakeComputerFor(computerId)?.sensitiveField, null);
  } finally { await f.close(); }
});

test("clearing the screen then returning control ends a password hold", async () => {
  const f = await fixture();
  try {
    const created = await f.api("/api/v1/computers", { name: "Clear", capabilities: ["browser"] });
    const computerId = (created.body.computer as { id: string }).id;
    const requested = await f.api("/api/v1/takeover/request", { computer_id: computerId, reason: "ui" });
    const id = (requested.body.takeover as { takeover_id: string }).takeover_id;
    assert.equal((await f.api(`/api/v1/takeover/${id}/acquire`, {})).status, 200);
    fakeComputerFor(computerId)!.sensitiveField = { kind: "password", label: "password" };
    const cleared = await f.api(`/api/v1/takeover/${id}/clear`, {});
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal((cleared.body.takeover as { state: string }).state, "agent");
    assert.equal(f.daemon.store.getTakeover(id)?.state, "agent");
    assert.equal(fakeComputerFor(computerId)?.sensitiveField, null);
  } finally { await f.close(); }
});

test("decline of a human hold from the holder names Give control back", async () => {
  const f = await fixture();
  try {
    const created = await f.api("/api/v1/computers", { name: "Decline", capabilities: ["browser"] });
    const computerId = (created.body.computer as { id: string }).id;
    const requested = await f.api("/api/v1/takeover/request", { computer_id: computerId, reason: "ui" });
    const id = (requested.body.takeover as { takeover_id: string }).takeover_id;
    assert.equal((await f.api(`/api/v1/takeover/${id}/acquire`, {})).status, 200);
    const declined = await f.api(`/api/v1/takeover/${id}/decline`, {});
    assert.equal(declined.status, 409);
    assert.equal(declined.body.error, "E_POLICY");
    assert.match(String(declined.body.message), /You already have control/);
    assert.doesNotMatch(String(declined.body.message), /invalid takeover decline/);
    assert.equal(f.daemon.store.getTakeover(id)?.state, "human");
  } finally { await f.close(); }
});

test("connection and task start agree for the same computer and never treat a transport probe as signed out", async () => {
  const cli = fakeCli("guest-wake-probe", home => `
import {existsSync,writeFileSync,readFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
const p=(name)=>join(${JSON.stringify(home)},name);
if(process.argv[2]==='login'||process.argv[2]==='auth') {
  if(process.argv[3]==='status') {
    const n=existsSync(p('probes'))?Number(readFileSync(p('probes'),'utf8'))+1:1;
    writeFileSync(p('probes'),String(n));
    if(existsSync(p('fail-once'))) { unlinkSync(p('fail-once')); process.stderr.write('cannot exec: container is not running\\n'); process.exit(1); }
    process.exit(existsSync(p('authenticated'))?0:1);
  }
  process.exit(0);
}
for await (const chunk of process.stdin) {}
`);
  writeFileSync(cli.path("authenticated"), "SYNTHETIC_CREDENTIAL");
  writeFileSync(cli.path("fail-once"), "1");
  const f = await fixture({
    codexLogin: {
      codexHome: cli.home,
      binary: cli.binary,
      spawn: async (args) => {
        const child = spawn(cli.binary, args, {
          env: { HOME: homedir(), PATH: process.env.PATH, CODEX_HOME: cli.home },
          stdio: ["ignore", "ignore", "pipe"],
        });
        return { child, async stop() { if (child.pid) try { process.kill(child.pid, "SIGKILL"); } catch { /* Test-owned. */ } } };
      },
    },
  });
  try {
    const created = await f.api("/api/v1/computers", { name: "Ready", capabilities: ["browser"] });
    const computerId = (created.body.computer as { id: string }).id;
    let inspects = 0;
    const original = f.sandbox.inspectStatus.bind(f.sandbox);
    f.sandbox.inspectStatus = async (id: string) => {
      inspects++;
      if (id === computerId && inspects < 3) return "paused";
      return original(id);
    };
    const started = await f.api("/api/v1/tasks", { goal: "Start after wake", adapter: "codex", computer_id: computerId });
    assert.ok(inspects >= 3, `start must wait for running after wake, inspects=${inspects}`);
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const task = started.body.task as { id: string };
    assert.equal((await f.api(`/api/v1/tasks/${task.id}/cancel`, {})).status, 200);
    const connection = await f.api(`/api/v1/connection?computer_id=${encodeURIComponent(computerId)}`);
    assert.equal(connection.status, 200);
    assert.notEqual(connection.body.status, "signed_out");
    assert.ok(connection.body.status === "signed_in" || connection.body.status === "connected");
    assert.equal(connection.body.computer_id, computerId);
  } finally { await f.close(); }
});

test("a failed status probe never reports an empty error message", async () => {
  const thrown = createCodexConnection({
    codexHome: "/tmp/synthetic-codex", binary: "/tmp/missing-codex-binary",
    model: () => "gpt-6-astra", configured: () => false, connected: () => {},
    spawn: async () => { throw Object.assign(new Error("container is not running"), { code: "EIO" }); },
  });
  try {
    const status = await thrown.status();
    assert.equal(status.status, "error");
    assert.ok(status.message.length > 0);
    assert.equal(status.message, "The bot’s computer is not running");
  } finally { await thrown.close(); }
});

async function humanHoldAcrossRestart(opts?: { destroy?: boolean }) {
  const prior = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const root = mkdtempSync(join(tmpdir(), "mb-hold-restart-"));
  const sqlitePath = join(root, "state.sqlite");
  const sandbox = createFakeSandbox({ workspaceRoot: root });
  const start = (token: string, port: number) => startDaemon({
    host: "127.0.0.1", port, sqlitePath, workspaceRoot: root, sandbox,
    bootstrapToken: token, mcpToken: `${token}-mcp`,
  });
  let daemon = await start("hold-restart", 0);
  const port = daemon.port;
  const session = await bootstrapSession(daemon, "hold-restart");
  const api = (handle: DaemonHandle, headers: DaemonSession["headers"]) =>
    async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
      const response = await fetch(`${handle.baseUrl}${path}`, {
        headers, method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
  const created = await api(daemon, session.headers)("/api/v1/computers", { name: "Drive", capabilities: ["browser"] });
  const computerId = (created.body.computer as { id: string }).id;
  const requested = await api(daemon, session.headers)("/api/v1/takeover/request", { computer_id: computerId, reason: "ui" });
  const id = (requested.body.takeover as { takeover_id: string }).takeover_id;
  assert.equal((await api(daemon, session.headers)(`/api/v1/takeover/${id}/acquire`, {})).status, 200);
  const before = daemon.store.getTakeover(id)!;
  await daemon.close();
  if (opts?.destroy) await sandbox.destroy(computerId);
  daemon = await start("hold-restart-2", port);
  return {
    daemon, session, sandbox, computerId, id, before, api: api(daemon, session.headers),
    async close() {
      await daemon.close();
      if (prior === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
      else process.env.MODELBOT_TEST_FAKE_COMPUTER = prior;
    },
  };
}

test("the same holder re-acquires frames and input after a daemon restart", async () => {
  const f = await humanHoldAcrossRestart();
  const sockets: WebSocket[] = [];
  try {
    const hold = f.daemon.store.getTakeover(f.id)!;
    assert.equal(hold.state, "human");
    assert.equal(hold.epoch, f.before.epoch);
    assert.equal(hold.granted_to, f.before.granted_to);
    assert.equal(fakeComputerFor(f.computerId)?.getTakeoverState(), "human");

    const busy = await f.daemon.callTool(f.computerId, "browser_snapshot", {});
    assert.equal((busy as { ok: boolean }).ok, false);
    assert.equal((busy as { error: { code: string } }).error.code, "E_TAKEOVER_BUSY");

    const messages: unknown[] = [];
    const ws = new WebSocket(`${f.daemon.baseUrl.replace("http", "ws")}/api/v1/live/${f.computerId}`, {
      headers: { Origin: f.daemon.baseUrl, Cookie: f.session.cookie },
    });
    sockets.push(ws);
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (event) => messages.push(event.data));
    await until(() => ws.readyState === WebSocket.OPEN);
    await until(() => messages.some((m) => typeof m === "string" && JSON.parse(m as string).t === "mode"
      && JSON.parse(m as string).mode === "human" && JSON.parse(m as string).epoch === f.before.epoch),
      "holder never received the same-epoch human mode");
    await until(() => messages.some((m) => typeof m !== "string"), "holder never received a frame");
    const frame = decodeLiveFrame(new Uint8Array(messages.find((m) => typeof m !== "string") as ArrayBuffer));
    assert.equal(frame.header.mode, "human");
    assert.equal(frame.header.epoch, f.before.epoch);

    const computer = fakeComputerFor(f.computerId)!;
    const relayed = computer.relayed.length;
    ws.send(JSON.stringify({ v: 1, t: "key", epoch: f.before.epoch, kind: "keyDown", key: "a", code: "KeyA" }));
    await until(() => computer.relayed.length > relayed, "holder input was not relayed after restart");

    const other = await bootstrapSession(f.daemon, "hold-restart-2");
    const outsider = new WebSocket(`${f.daemon.baseUrl.replace("http", "ws")}/api/v1/live/${f.computerId}`, {
      headers: { Origin: f.daemon.baseUrl, Cookie: other.cookie },
    });
    sockets.push(outsider);
    await until(() => outsider.readyState === WebSocket.OPEN);
    const beforeOutsider = computer.relayed.length;
    outsider.send(JSON.stringify({ v: 1, t: "key", epoch: f.before.epoch, kind: "keyDown", key: "x", code: "KeyX" }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(computer.relayed.length, beforeOutsider, "a non-holder must not relay input");

    const released = await f.api(`/api/v1/takeover/${f.id}/release`, {});
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal((released.body.takeover as { state: string }).state, "agent");
    assert.equal(f.daemon.store.getTakeover(f.id)?.state, "agent");
  } finally {
    for (const ws of sockets) ws.close();
    await f.close();
  }
});

test("an unrecoverable human hold becomes paused with return-control recovery", async () => {
  const f = await humanHoldAcrossRestart({ destroy: true });
  const sockets: WebSocket[] = [];
  try {
    const hold = f.daemon.store.getTakeover(f.id)!;
    assert.equal(hold.state, "paused");
    assert.equal(hold.granted_to, f.before.granted_to);
    assert.equal(fakeComputerFor(f.computerId), undefined);

    const listed = await f.api("/api/v1/takeovers");
    assert.equal(listed.status, 200);
    const rows = listed.body.takeovers as Array<{ id: string; state: string }>;
    assert.equal(rows.find((row) => row.id === f.id)?.state, "paused");

    const messages: unknown[] = [];
    const ws = new WebSocket(`${f.daemon.baseUrl.replace("http", "ws")}/api/v1/live/${f.computerId}`, {
      headers: { Origin: f.daemon.baseUrl, Cookie: f.session.cookie },
    });
    sockets.push(ws);
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (event) => messages.push(event.data));
    await until(() => ws.readyState === WebSocket.OPEN);
    await until(() => messages.some((m) => typeof m === "string" && JSON.parse(m as string).mode === "validating"),
      "paused hold never advertised validating live mode");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(messages.some((m) => typeof m !== "string"), false, "a paused hold must not send operator frames");

    const returned = await f.api(`/api/v1/takeover/${f.id}/release`, {});
    assert.equal(returned.status, 200, JSON.stringify(returned.body));
    assert.equal(f.daemon.store.getTakeover(f.id)?.state, "agent");
  } finally {
    for (const ws of sockets) ws.close();
    await f.close();
  }
});
