import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fakeComputerFor } from "../../../src/computer-client/fake.ts";
import { startDaemon } from "../../../src/daemon/server.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";

process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";

async function fixture() {
  const daemon = await startDaemon({
    host: "127.0.0.1",
    port: 0,
    mcpToken: "release-mcp",
    bootstrapToken: "release-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-takeover-release-")),
  });
  const { headers } = await bootstrapSession(daemon, "release-boot");
  const api = async (path: string, body: unknown = {}) => {
    const response = await fetch(`${daemon.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  daemon.store.insertComputer({
    id: "handback",
    name: "handback",
    capabilities: ["browser"],
    persistent: false,
    status: "running",
  });
  const task = daemon.store.insertTask({ computer_id: "handback", goal: "sign in", max_steps: 5 });
  const requested = await api("/api/v1/takeover/request", {
    computer_id: "handback",
    task_id: task.id,
    reason: "ui",
  });
  const id = (requested.body.takeover as { takeover_id: string }).takeover_id;
  assert.equal((await api(`/api/v1/takeover/${id}/acquire`)).status, 200);
  return {
    daemon,
    api,
    id,
    taskId: task.id,
    async close() {
      await daemon.close();
    },
  };
}

function watchSensitive(computer: NonNullable<ReturnType<typeof fakeComputerFor>>) {
  const seen: unknown[] = [];
  let field = computer.sensitiveField;
  Object.defineProperty(computer, "sensitiveField", {
    configurable: true,
    get() {
      seen.push(field);
      return field;
    },
    set(value) {
      field = value;
      seen.push(["blank", value]);
    },
  });
  return seen;
}

test("release with a visible password field blanks then returns control", async () => {
  const f = await fixture();
  try {
    const computer = fakeComputerFor("handback")!;
    computer.sensitiveField = { kind: "password", label: "password" };
    const seen = watchSensitive(computer);
    const released = await f.api(`/api/v1/takeover/${f.id}/release`);
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal((released.body.takeover as { state: string }).state, "agent");
    assert.deepEqual(released.body.cleared, { reason: "password" });
    assert.equal(released.body.blocked_by, undefined);
    assert.equal(f.daemon.store.getTakeover(f.id)?.state, "agent");
    const blankedAt = seen.findIndex(
      (entry) => Array.isArray(entry) && entry[0] === "blank" && entry[1] === null,
    );
    assert.ok(blankedAt >= 0, "the page was not blanked");
    const releasedAt = seen.findIndex((entry, i) => i > blankedAt && entry === null);
    assert.ok(releasedAt > blankedAt, "release ran before the page was blanked");
    const row = f.daemon.store.listAuditRefs().find((entry) => entry.type === "takeover.released");
    assert.ok(row, "no takeover.released event");
    assert.equal(row.task_id, f.taskId);
    assert.equal(
      (JSON.parse(row.body_json) as { cleared?: { reason: string } }).cleared?.reason,
      "password",
    );
  } finally {
    await f.close();
  }
});

test("release with no sensitive field is unchanged", async () => {
  const f = await fixture();
  try {
    const computer = fakeComputerFor("handback")!;
    const seen = watchSensitive(computer);
    const released = await f.api(`/api/v1/takeover/${f.id}/release`);
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal((released.body.takeover as { state: string }).state, "agent");
    assert.equal(released.body.cleared, undefined);
    assert.equal(released.body.blocked_by, undefined);
    assert.equal(f.daemon.store.getTakeover(f.id)?.state, "agent");
    assert.equal(
      seen.some((entry) => Array.isArray(entry) && entry[0] === "blank"),
      false,
    );
    const row = f.daemon.store.listAuditRefs().find((entry) => entry.type === "takeover.released");
    assert.ok(row, "no takeover.released event");
    assert.equal((JSON.parse(row.body_json) as { cleared?: unknown }).cleared, undefined);
  } finally {
    await f.close();
  }
});

test("a second release on an already-returned hold stays agent", async () => {
  const f = await fixture();
  try {
    fakeComputerFor("handback")!.sensitiveField = { kind: "password", label: "password" };
    const first = await f.api(`/api/v1/takeover/${f.id}/release`);
    assert.equal(first.status, 200);
    assert.equal((first.body.takeover as { state: string }).state, "agent");
    const again = await f.api(`/api/v1/takeover/${f.id}/release`);
    assert.equal(again.status, 200);
    assert.equal((again.body.takeover as { state: string }).state, "agent");
    assert.equal(again.body.cleared, undefined);
    assert.equal(f.daemon.store.getTakeover(f.id)?.state, "agent");
  } finally {
    await f.close();
  }
});
