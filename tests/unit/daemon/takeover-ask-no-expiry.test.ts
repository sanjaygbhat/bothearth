/**
 * The model can ask for a person too, through the tool dispatcher rather than
 * the UI route. That question carries no deadline — the lease clock starts when
 * someone takes control — so the deadline the computer reports with its answer
 * must not become the row's expiry, or the ask dies before it is read.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startDaemon } from "../../../src/daemon/server.ts";
import type { ToolResult } from "../../../src/types/contracts.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";

const TTL_SEC = 0.5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a takeover the model asked for waits without a deadline, and is still grantable", async () => {
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const daemon = await startDaemon({
    host: "127.0.0.1", port: 0, mcpToken: "ask-mcp", bootstrapToken: "ask-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-ask-")),
    takeoverTtlSec: TTL_SEC,
  });
  try {
    const { headers } = await bootstrapSession(daemon, "ask-boot");
    daemon.store.insertComputer({
      id: "ask", name: "ask", capabilities: ["browser"], persistent: false, status: "running",
    });

    const result = await daemon.callTool("ask", "request_takeover", {
      reason: "the checkout wants a card",
    }) as ToolResult;
    assert.equal(result.ok, true, JSON.stringify(result));
    const data = result.data as { takeover_id: string; expires_at?: string | null };
    const id = data.takeover_id;
    assert.notEqual(data.expires_at ?? null, null,
      "the fixture computer no longer reports a deadline, so this proves nothing");
    assert.equal(daemon.store.getTakeover(id)?.expires_at, null,
      "the computer's deadline became the ask's deadline");

    // Two TTLs of silence: a question nobody has answered cannot lapse.
    await sleep(TTL_SEC * 2 * 1000);
    assert.equal(daemon.store.getTakeover(id)?.state, "takeover_requested",
      "the ask expired while it was still waiting for a person");

    const beforeGrant = Date.now();
    const acquired = await fetch(`${daemon.baseUrl}/api/v1/takeover/${id}/acquire`,
      { method: "POST", headers });
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
