import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startDaemon } from "../../../src/daemon/server.ts";
import { createFakeSandbox } from "../../../src/computer-client/fake-sandbox.ts";
import { Store } from "../../../src/daemon/store.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mb-default-workspace-"));
  const sqlitePath = join(root, "state.sqlite"), sandbox = createFakeSandbox({ workspaceRoot: root });
  let creates = 0, starts = 0;
  const create = sandbox.create.bind(sandbox), start = sandbox.start.bind(sandbox);
  sandbox.create = async (body) => { creates++; await new Promise((r) => setTimeout(r, 20)); return create(body); };
  sandbox.start = async (id) => { starts++; await new Promise((r) => setTimeout(r, 20)); return start(id); };
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER; process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const daemon = await startDaemon({ port: 0, workspaceRoot: root, sqlitePath, sandbox, bootstrapToken: "synthetic-bootstrap",
    agentLoop: { model: "synthetic", adapter: { kind: "openai_compat", complete: (request) => new Promise((_, reject) => {
      if (request.signal?.aborted) reject(new Error("cancelled"));
      else request.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }) } } });
  const { headers } = await bootstrapSession(daemon, "synthetic-bootstrap");
  const api = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`${daemon.baseUrl}/api/v1/${path}`, { headers, method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const computer = async (name: string, capabilities = ["browser"]) => (await api("computers", { name, capabilities, persistent: true })).body.computer;
  return { daemon, api, computer, sqlitePath, creates: () => creates, starts: () => starts, async close() {
    await daemon.close(); if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER; else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
  } };
}

test("goal-only first use provisions one persistent browser only when submitted", async () => {
  const f = await fixture();
  try {
    const before = await f.api("computers");
    assert.equal(before.body.default_computer_id, null); assert.equal(before.body.will_create_default, true); assert.equal(f.creates(), 0);
    for (const body of [{ goal: " " }, { goal: "example", max_steps: 0 }, { goal: "example", capabilities: ["shell"] }, { goal: "example", capabilities: { length: 1, 0: "browser" } }])
      assert.equal((await f.api("tasks", body)).status, 400);
    assert.equal(f.creates(), 0);
    const response = await f.api("tasks", { goal: "Synthetic task" });
    assert.equal(response.status, 201); assert.equal(f.creates(), 1);
    const selected = f.daemon.store.getComputer(response.body.task.computer_id)!;
    assert.equal(selected.persistent, 1); assert.deepEqual(JSON.parse(selected.capabilities), ["browser"]);
    assert.deepEqual(JSON.parse(response.body.task.capabilities), ["browser"]);
    assert.equal((await f.api("computers")).body.default_computer_id, selected.id);
  } finally { await f.close(); }
});

test("simultaneous first submissions share provisioning and preserve the busy default", async () => {
  const f = await fixture();
  try {
    const responses = await Promise.all([f.api("tasks", { goal: "First" }), f.api("tasks", { goal: "Second" })]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
    assert.equal(f.creates(), 1); assert.equal(f.daemon.store.listTasks().length, 1);
    assert.equal(responses.find((r) => r.status === 409)!.body.task_id, f.daemon.store.listTasks()[0]!.id);
  } finally { await f.close(); }
});

test("a sole existing browser is reused without opting into its shell capability", async () => {
  const f = await fixture();
  try {
    const existing = await f.computer("Existing signed-in workspace", ["browser", "shell"]);
    assert.equal((await f.api("computers")).body.default_computer_id, existing.id);
    const task = (await f.api("tasks", { goal: "Synthetic task" })).body.task;
    assert.equal(task.computer_id, existing.id); assert.equal(f.creates(), 1);
    assert.deepEqual(JSON.parse(task.capabilities), ["browser"]);
  } finally { await f.close(); }
});

test("multiple unrelated profiles get a fresh default; Advanced overrides are one-off", async () => {
  const f = await fixture();
  try {
    const a = await f.computer("Profile A"), b = await f.computer("Profile B");
    assert.equal((await f.api("computers")).body.default_computer_id, null);
    const initial = (await f.api("tasks", { goal: "Default task" })).body.task;
    assert.ok(![a.id, b.id].includes(initial.computer_id)); assert.equal(f.creates(), 3);
    const override = await f.api("tasks", { computer_id: a.id, goal: "Explicit task", capabilities: ["browser"] });
    assert.equal(override.status, 201); assert.equal(override.body.task.computer_id, a.id);
    assert.equal((await f.api("computers")).body.default_computer_id, initial.computer_id);
    assert.equal((await f.api(`computers/${b.id}/default`, {})).status, 200);
    const next = await f.api("tasks", { goal: "Remembered default" });
    assert.equal(next.status, 201); assert.equal(next.body.task.computer_id, b.id); assert.equal(f.creates(), 3);
    const reopened = new Store(f.sqlitePath);
    try { assert.equal(reopened.getDefaultComputerId(), b.id); } finally { reopened.close(); }
  } finally { await f.close(); }
});

test("a stopped default restarts through the existing lifecycle without duplicate tasks", async () => {
  const f = await fixture();
  try {
    const existing = await f.computer("Remembered workspace");
    await f.api(`computers/${existing.id}/default`, {});
    await f.api(`computers/${existing.id}/stop`, {});
    const responses = await Promise.all([f.api("tasks", { goal: "Restart" }), f.api("tasks", { goal: "Competing restart" })]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
    assert.equal(f.creates(), 1); assert.ok(f.starts() >= 1);
    assert.equal(f.daemon.store.getComputer(existing.id)?.status, "running");
    assert.equal(f.daemon.store.listTasks().length, 1);
  } finally { await f.close(); }
});


test("deleting a remembered default never silently inherits another private profile", async () => {
  const f = await fixture();
  try {
    const a = await f.computer("Saved profile"), b = await f.computer("Unrelated profile");
    await f.api(`computers/${a.id}/default`, {});
    assert.equal((await f.api(`computers/${a.id}`, undefined, "DELETE")).status, 200);
    assert.equal((await f.api("computers")).body.default_computer_id, null);
    const next = await f.api("tasks", { goal: "Fresh workspace" });
    assert.equal(next.status, 201); assert.notEqual(next.body.task.computer_id, b.id);
    assert.equal(f.creates(), 3);
  } finally { await f.close(); }
});
