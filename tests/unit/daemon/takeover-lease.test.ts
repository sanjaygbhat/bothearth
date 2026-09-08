import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startDaemon } from "../../../src/daemon/server.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";

const TTL_SEC = 0.6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The lease is short so the test runs in seconds; the clock arithmetic is the
// same one a 10-minute grant uses.
test("the takeover lease starts at the grant and every relayed input renews it", async () => {
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const daemon = await startDaemon({
    host: "127.0.0.1", port: 0, mcpToken: "lease-mcp", bootstrapToken: "lease-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-lease-")),
    takeoverTtlSec: TTL_SEC,
  });
  const sockets: WebSocket[] = [];
  try {
    const { cookie, headers } = await bootstrapSession(daemon, "lease-boot");
    const post = async (path: string, body: unknown = {}) => {
      const res = await fetch(`${daemon.baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
      assert.ok(res.ok, `${path} -> ${res.status} ${await res.clone().text()}`);
      return (await res.json()) as Record<string, any>;
    };
    daemon.store.insertComputer({ id: "lease", name: "lease", capabilities: ["browser"], persistent: false, status: "running" });

    const requested = await post("/api/v1/takeover/request", { computer_id: "lease" });
    const id = requested.takeover.takeover_id as string;
    await sleep(200);
    const beforeGrant = Date.now();
    await post(`/api/v1/takeover/${id}/grant`);
    const deadline = Date.parse(daemon.store.getTakeover(id)!.expires_at);
    assert.ok(deadline >= beforeGrant + TTL_SEC * 1000 && deadline <= Date.now() + TTL_SEC * 1000,
      "the lease deadline is not measured from the grant");

    const ws = new WebSocket(`${daemon.baseUrl.replace("http", "ws")}/api/v1/live/lease`,
      { headers: { origin: daemon.baseUrl, cookie } } as never);
    sockets.push(ws);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });

    await sleep(400);
    ws.send(JSON.stringify({ v: 1, t: "key", type: "live.key", key: "a",
      epoch: daemon.store.getTakeover(id)!.epoch }));
    await sleep(400);
    assert.equal(daemon.store.getTakeover(id)?.state, "human",
      "one relayed keystroke did not renew the lease");

    await sleep(TTL_SEC * 1000 + 400);
    assert.equal(daemon.store.getTakeover(id)?.state, "paused",
      "the lease outlived its TTL with no human input");
  } finally {
    for (const ws of sockets) ws.close();
    await daemon.close();
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
  }
});
