import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createState, dispatch } from "../../../computer-server/src/dispatch.ts";
import {
  createTakeoverSession,
  gateMethod,
  transition,
} from "../../../computer-server/src/takeover-gate.ts";
import { startDaemon } from "../../../src/daemon/server.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";

process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";

const CHOOSER = "https://accounts.google.com/AccountChooser";

async function fixture() {
  const daemon = await startDaemon({
    host: "127.0.0.1",
    port: 0,
    mcpToken: "google-mcp",
    bootstrapToken: "google-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-takeover-google-")),
  });
  const { headers } = await bootstrapSession(daemon, "google-boot");
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(`${daemon.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  daemon.store.insertComputer({
    id: "google-cmp",
    name: "google-cmp",
    capabilities: ["browser"],
    persistent: false,
    status: "running",
  });
  const task = daemon.store.insertTask({
    computer_id: "google-cmp",
    goal: "sign in",
    max_steps: 5,
  });
  const requested = await api("/api/v1/takeover/request", {
    computer_id: "google-cmp",
    task_id: task.id,
    reason: "ui",
  });
  const id = (requested.body.takeover as { takeover_id: string }).takeover_id;
  return {
    daemon,
    api,
    id,
    async close() {
      await daemon.close();
    },
  };
}

describe("POST /api/v1/takeover/:id/google-account", () => {
  it("rejects when this session does not hold a human lease", async () => {
    const f = await fixture();
    try {
      const asked = await f.api(`/api/v1/takeover/${f.id}/google-account`);
      assert.equal(asked.status, 409);
      assert.equal(asked.body.error, "E_POLICY");

      assert.equal((await f.api(`/api/v1/takeover/${f.id}/acquire`)).status, 200);
      f.daemon.store.grantTakeoverTo(f.id, "other-device");
      const other = await f.api(`/api/v1/takeover/${f.id}/google-account`);
      assert.equal(other.status, 409);
      assert.equal(other.body.error, "E_POLICY");
    } finally {
      await f.close();
    }
  });

  it("rejects when the model or agent calls it, and only opens the chooser URL", async () => {
    const f = await fixture();
    try {
      assert.equal((await f.api(`/api/v1/takeover/${f.id}/acquire`)).status, 200);

      const agent = await f.daemon.callTool("google-cmp", "takeover.goto", { url: CHOOSER });
      assert.equal((agent as { ok?: boolean }).ok, false);
      assert.equal((agent as { error?: { code?: string } }).error?.code, "E_CAPABILITY");

      const wrong = await f.api(`/api/v1/takeover/${f.id}/google-account`, {
        url: "https://example.com/",
      });
      assert.equal(wrong.status, 409);
      assert.equal(wrong.body.error, "E_POLICY");

      const ok = await f.api(`/api/v1/takeover/${f.id}/google-account`);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal((ok.body.takeover as { url?: string }).url, CHOOSER);
      assert.equal(f.daemon.store.getTakeover(f.id)?.state, "human");

      const withUrl = await f.api(`/api/v1/takeover/${f.id}/google-account`, { url: CHOOSER });
      assert.equal(withUrl.status, 200);
    } finally {
      await f.close();
    }
  });
});

describe("takeover.goto is human-only and URL-pinned", () => {
  it("the gate lets the operator through and still blocks model navigation", () => {
    const session = createTakeoverSession();
    transition(session, "request");
    transition(session, "grant");
    assert.equal(gateMethod(session, "takeover.goto"), null);
    assert.notEqual(gateMethod(session, "browser_navigate"), null);
  });

  it("dispatch refuses the agent and any URL except the chooser", async () => {
    const rpc = (
      state: ReturnType<typeof createState>,
      method: string,
      params: Record<string, unknown>,
    ) => dispatch(state, { jsonrpc: "2.0", id: 1, method, params });

    const agent = createState("browser");
    const asAgent = await rpc(agent, "takeover.goto", { url: CHOOSER });
    assert.equal(asAgent.ok, false);

    const human = createState("browser");
    transition(human.takeover, "request");
    transition(human.takeover, "grant");
    const seen: string[] = [];
    human.browser = {
      navigate: async (url: string) => {
        seen.push(url);
        return { ok: true, data: { url } };
      },
    } as never;
    const wrong = await rpc(human, "takeover.goto", { url: "https://example.com/" });
    assert.equal(wrong.ok, false);
    assert.deepEqual(seen, []);
    const ok = await rpc(human, "takeover.goto", { url: CHOOSER });
    assert.equal(ok.ok, true);
    assert.deepEqual(seen, [CHOOSER]);
  });
});
