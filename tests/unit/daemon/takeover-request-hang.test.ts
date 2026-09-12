/**
 * Operator Take control must mint a durable row even when the computer never
 * answers. The HTTP handler used to await takeover.request with no timeout.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeComputer, fakeComputerFor } from "../../../src/computer-client/fake.ts";
import { takeoverNeedsComputerSync } from "../../../src/daemon/dispatcher.ts";
import { startDaemon } from "../../../src/daemon/server.ts";
import { toolError } from "../../../src/protocol/errors.ts";
import type { ToolResult } from "../../../src/types/contracts.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("takeover request returns within 2s when the computer call hangs", {
  timeout: 8_000,
}, async () => {
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const orig = FakeComputer.prototype.call;
  const hang = Promise.withResolvers<ToolResult>();
  let first = true;
  FakeComputer.prototype.call = async function (method, params) {
    if (method === "takeover.request" && first) {
      first = false;
      return hang.promise;
    }
    return orig.call(this, method, params);
  };
  const daemon = await startDaemon({
    host: "127.0.0.1",
    port: 0,
    mcpToken: "hang-mcp",
    bootstrapToken: "hang-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-tk-hang-")),
  });
  try {
    const { headers } = await bootstrapSession(daemon, "hang-boot");
    daemon.store.insertComputer({
      id: "hung",
      name: "hung",
      capabilities: ["browser"],
      persistent: false,
      status: "running",
    });

    const started = Date.now();
    const res = await fetch(`${daemon.baseUrl}/api/v1/takeover/request`, {
      method: "POST",
      headers,
      body: JSON.stringify({ computer_id: "hung", reason: "ui" }),
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2_500, `takeover request took ${elapsed}ms while the computer hung`);
    assert.equal(res.status, 200);
    const { takeover } = (await res.json()) as {
      takeover: { takeover_id: string; state: string };
    };
    assert.equal(takeover.state, "requested");
    const id = takeover.takeover_id;
    const row = daemon.store.getTakeover(id);
    assert.ok(row, "minted a durable takeover row while the computer was silent");
    assert.equal(row.state, "takeover_requested");
    assert.equal(row.expires_at, null);
    assert.equal(takeoverNeedsComputerSync(id), true);
    assert.ok(
      daemon.store.listAuditRefs().some((entry) => entry.type === "takeover.requested"),
      "a hang must still announce the human ask after the 2s bound",
    );

    const again = await fetch(`${daemon.baseUrl}/api/v1/takeover/request`, {
      method: "POST",
      headers,
      body: JSON.stringify({ computer_id: "hung", reason: "ui" }),
    });
    assert.equal(again.status, 200);
    const second = (await again.json()) as { takeover: { takeover_id: string } };
    assert.equal(second.takeover.takeover_id, id, "a second ask must reuse the minted row");
    assert.equal(
      daemon.store.listTakeovers().filter((entry) => entry.computer_id === "hung").length,
      1,
      "hanging computer must not mint a second takeover row",
    );

    const computer = fakeComputerFor("hung");
    assert.ok(computer);
    hang.resolve(await orig.call(computer, "takeover.request", { reason: "ui", takeover_id: id }));
    await sleep(40);
    const after = daemon.store.getTakeover(id)!;
    assert.equal(after.id, id);
    assert.ok(after.epoch > 0, "late computer reply must stamp the existing row's epoch");
    assert.equal(takeoverNeedsComputerSync(id), false);
    assert.equal(
      daemon.store.listTakeovers().filter((entry) => entry.computer_id === "hung").length,
      1,
    );
  } finally {
    FakeComputer.prototype.call = orig;
    await daemon.close();
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
  }
});

test("a takeover request that never hears back still leaves one valid row", {
  timeout: 8_000,
}, async () => {
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const orig = FakeComputer.prototype.call;
  FakeComputer.prototype.call = async function (method, params) {
    if (method === "takeover.request") return new Promise<ToolResult>(() => {});
    return orig.call(this, method, params);
  };
  const daemon = await startDaemon({
    host: "127.0.0.1",
    port: 0,
    mcpToken: "hang2-mcp",
    bootstrapToken: "hang2-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-tk-hang2-")),
  });
  try {
    const { headers } = await bootstrapSession(daemon, "hang2-boot");
    daemon.store.insertComputer({
      id: "silent",
      name: "silent",
      capabilities: ["browser"],
      persistent: false,
      status: "running",
    });
    const started = Date.now();
    const res = await fetch(`${daemon.baseUrl}/api/v1/takeover/request`, {
      method: "POST",
      headers,
      body: JSON.stringify({ computer_id: "silent" }),
    });
    assert.ok(Date.now() - started < 2_500);
    assert.equal(res.status, 200);
    const { takeover } = (await res.json()) as { takeover: { takeover_id: string; state: string } };
    assert.equal(takeover.state, "requested");
    const row = daemon.store.getTakeover(takeover.takeover_id);
    assert.ok(row);
    assert.equal(row.state, "takeover_requested");
    assert.equal(takeoverNeedsComputerSync(row.id), true);
    assert.equal(
      daemon.store.listTakeovers().filter((entry) => entry.computer_id === "silent").length,
      1,
    );
    assert.ok(daemon.store.listAuditRefs().some((entry) => entry.type === "takeover.requested"));
  } finally {
    FakeComputer.prototype.call = orig;
    await daemon.close();
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
  }
});

test("a fast computer refusal returns 409 and does not keep the mint", {
  timeout: 8_000,
}, async () => {
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const orig = FakeComputer.prototype.call;
  let asks = 0;
  FakeComputer.prototype.call = async function (method, params) {
    if (method === "takeover.request") {
      asks += 1;
      if (asks === 1) return toolError("E_POLICY", "cannot request takeover");
    }
    return orig.call(this, method, params);
  };
  const daemon = await startDaemon({
    host: "127.0.0.1",
    port: 0,
    mcpToken: "refuse-mcp",
    bootstrapToken: "refuse-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-tk-refuse-")),
  });
  try {
    const { headers } = await bootstrapSession(daemon, "refuse-boot");
    daemon.store.insertComputer({
      id: "refused",
      name: "refused",
      capabilities: ["browser"],
      persistent: false,
      status: "running",
    });
    const started = Date.now();
    const res = await fetch(`${daemon.baseUrl}/api/v1/takeover/request`, {
      method: "POST",
      headers,
      body: JSON.stringify({ computer_id: "refused" }),
    });
    assert.ok(Date.now() - started < 2_500);
    assert.equal(res.status, 409);
    const refused = (await res.json()) as {
      ok?: boolean;
      error?: { code?: string; message?: string };
    };
    assert.equal(refused.ok, false);
    assert.equal(refused.error?.code, "E_POLICY");
    assert.equal(daemon.store.activeTakeoverForComputer("refused"), undefined);
    assert.equal(
      daemon.store
        .listTakeovers()
        .filter((entry) => entry.computer_id === "refused" && entry.state === "takeover_requested")
        .length,
      0,
      "computer !ok must not leave a sticky takeover_requested row",
    );
    assert.equal(
      daemon.store.listAuditRefs().filter((entry) => entry.type === "takeover.requested").length,
      0,
      "a refused ask must not emit takeover.requested",
    );

    const retry = await fetch(`${daemon.baseUrl}/api/v1/takeover/request`, {
      method: "POST",
      headers,
      body: JSON.stringify({ computer_id: "refused" }),
    });
    assert.equal(retry.status, 200);
    const { takeover } = (await retry.json()) as {
      takeover: { takeover_id: string; state: string };
    };
    assert.equal(takeover.state, "requested");
    assert.equal(asks, 2, "a leftover requested row would reuse and skip the computer");
    const kept = daemon.store.getTakeover(takeover.takeover_id);
    assert.ok(kept);
    assert.equal(kept.state, "takeover_requested");
    assert.ok(daemon.store.listAuditRefs().some((entry) => entry.type === "takeover.requested"));
  } finally {
    FakeComputer.prototype.call = orig;
    await daemon.close();
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
  }
});

test("a fast computer refusal leaves a paused granted lease", {
  timeout: 8_000,
}, async () => {
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const orig = FakeComputer.prototype.call;
  FakeComputer.prototype.call = async function (method, params) {
    if (method === "takeover.request") return toolError("E_POLICY", "cannot request takeover");
    return orig.call(this, method, params);
  };
  const daemon = await startDaemon({
    host: "127.0.0.1",
    port: 0,
    mcpToken: "refuse-paused-mcp",
    bootstrapToken: "refuse-paused-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-tk-refuse-paused-")),
  });
  try {
    const { headers } = await bootstrapSession(daemon, "refuse-paused-boot");
    daemon.store.insertComputer({
      id: "held",
      name: "held",
      capabilities: ["browser"],
      persistent: false,
      status: "running",
    });
    const priorId = "tk_paused_holder";
    daemon.store.insertTakeover({
      id: priorId,
      computer_id: "held",
      state: "paused",
      expires_at: null,
      epoch: 4,
    });
    daemon.store.grantTakeoverTo(priorId, "dev_holder");
    daemon.store.updateTakeoverState(priorId, "paused");
    const before = daemon.store.getTakeover(priorId)!;
    assert.equal(before.state, "paused");
    assert.equal(before.granted_to, "dev_holder");
    assert.equal(before.epoch, 4);

    const started = Date.now();
    const res = await fetch(`${daemon.baseUrl}/api/v1/takeover/request`, {
      method: "POST",
      headers,
      body: JSON.stringify({ computer_id: "held" }),
    });
    assert.ok(Date.now() - started < 2_500);
    assert.equal(res.status, 409);
    const refused = (await res.json()) as {
      ok?: boolean;
      error?: { code?: string };
    };
    assert.equal(refused.ok, false);
    assert.equal(refused.error?.code, "E_POLICY");

    const active = daemon.store.activeTakeoverForComputer("held");
    assert.ok(active);
    assert.equal(active.id, priorId);
    assert.equal(active.state, "paused");
    assert.equal(active.granted_to, "dev_holder");
    assert.equal(active.epoch, 4);
    assert.equal(
      daemon.store.listAuditRefs().filter((entry) => entry.type === "takeover.requested").length,
      0,
      "a refused ask must not emit takeover.requested",
    );
  } finally {
    FakeComputer.prototype.call = orig;
    await daemon.close();
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
  }
});
