/**
 * A takeover nobody has answered waits for the person. It used to be written
 * with `expires_at = now`, so the expiry timer fired on the next tick, the row
 * went to `paused` and the "Take control" button answered 409 — the question
 * expired before it was read.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startDaemon } from "../../../src/daemon/server.ts";
import type { UiEvent } from "../../../src/types/contracts.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";

const TTL_SEC = 0.5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("an unanswered takeover has no deadline, and acquiring it starts one", async () => {
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const daemon = await startDaemon({
    host: "127.0.0.1", port: 0, mcpToken: "pending-mcp", bootstrapToken: "pending-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-pending-")),
    takeoverTtlSec: TTL_SEC,
  });
  try {
    const { headers } = await bootstrapSession(daemon, "pending-boot");
    daemon.store.insertComputer({ id: "pending", name: "pending", capabilities: ["browser"], persistent: false, status: "running" });
    const events: UiEvent[] = [];
    const unsubscribe = daemon.events.subscribe((event) => events.push(event));

    const res = await fetch(`${daemon.baseUrl}/api/v1/takeover/request`, { method: "POST", headers,
      body: JSON.stringify({ computer_id: "pending", reason: "Review the draft. Bearer PRIVATE_CANARY" + " ".repeat(2100) }) });
    unsubscribe();
    assert.equal(res.status, 200);
    const { takeover } = (await res.json()) as { takeover: { takeover_id: string; state: string; expires_at: string | null } };
    assert.equal(takeover.state, "requested");
    assert.equal(takeover.expires_at, null, "the question the bot asked came back with a deadline");
    const id = takeover.takeover_id;
    const requestedEvent = events.find((event) => event.type === "takeover.requested");
    assert.equal(requestedEvent?.body.reason, "Review the draft. [redacted]");
    assert.equal(requestedEvent?.body.takeover_id, id);
    assert.doesNotMatch(JSON.stringify(requestedEvent), /PRIVATE_CANARY/);
    assert.equal(daemon.store.getTakeover(id)?.expires_at, null, "the takeover row was born with a deadline");

    // Four TTLs of silence. Nothing may expire a question nobody was asked yet.
    await sleep(TTL_SEC * 4 * 1000);
    assert.equal(daemon.store.getTakeover(id)?.state, "takeover_requested",
      "the pending takeover expired while it was still waiting for a person");
    const expiries = daemon.store.db
      .prepare("SELECT COUNT(*) AS n FROM audit_refs WHERE type = 'takeover.expired'").get() as { n: number };
    assert.equal(Number(expiries.n), 0, "a pending takeover was announced as expired");

    const beforeGrant = Date.now();
    const acquired = await fetch(`${daemon.baseUrl}/api/v1/takeover/${id}/acquire`, { method: "POST", headers });
    assert.equal(acquired.status, 200, await acquired.clone().text());
    const row = daemon.store.getTakeover(id)!;
    assert.equal(row.state, "human");
    const deadline = Date.parse(row.expires_at ?? "");
    assert.ok(deadline >= beforeGrant + TTL_SEC * 1000 && deadline <= Date.now() + TTL_SEC * 1000,
      `the lease deadline ${row.expires_at} is not one TTL from the grant`);
  } finally {
    await daemon.close();
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
  }
});
