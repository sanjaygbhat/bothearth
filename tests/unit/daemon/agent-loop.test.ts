import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import { AuditLog, readAuditRecords } from "../../../src/audit/log.ts";
import { staticAuditKey } from "../../../src/audit/key.ts";
import { createFakeComputerClient } from "../../../src/computer-client/fake.ts";
import { runAgentLoop } from "../../../src/daemon/agent-loop.ts";
import { createToolDispatcher } from "../../../src/daemon/dispatcher.ts";
import { createA11yDriver } from "../../../src/drivers/a11y.ts";
import type {
  AdapterCompleteRequest,
  AdapterCompleteResponse,
  ProviderAdapter,
  ToolResult,
} from "../../../src/types/contracts.ts";
import type { ComputerClient } from "../../../src/computer-client/types.ts";
import { Store } from "../../../src/daemon/store.ts";

class StableComputer extends EventEmitter implements ComputerClient {
  readonly computerId = "computer_fixture";
  readonly calls: Array<{ method: string; params: unknown }> = [];
  busy = false;
  busyObservation = false;
  varySnapshots = false;
  private snapshotSequence = 0;

  async call(method: string, params?: unknown): Promise<ToolResult> {
    this.calls.push({ method, params });
    if (this.busyObservation) {
      return {
        ok: false,
        error: { code: "E_TAKEOVER_BUSY", message: "human has control" },
      };
    }
    if (method === "browser_snapshot") {
      this.snapshotSequence += 1;
      const yaml = this.varySnapshots
        ? `- button "Continue" [ref=e1] #${this.snapshotSequence}`
        : '- button "Continue" [ref=e1]';
      return {
        ok: true,
        data: {
          snapshot_id: `snap_${this.snapshotSequence}`,
          yaml,
          truncated: false,
          refs: ["e1"],
          url: "https://fixture.local/",
          title: "Fixture",
        },
      };
    }
    if (this.busy) {
      return {
        ok: false,
        error: { code: "E_TAKEOVER_BUSY", message: "human has control" },
      };
    }
    if (method === "request_takeover") {
      return {
        ok: true,
        data: {
          takeover_id: "tk_fixture",
          state: "requested",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      };
    }
    return { ok: true, data: { method } };
  }

  async grantTakeover(): Promise<ToolResult> {
    return { ok: true, data: {} };
  }
  async releaseTakeover(): Promise<ToolResult> {
    return { ok: true, data: {} };
  }
  async declineTakeover(): Promise<ToolResult> {
    return { ok: true, data: {} };
  }
  async expireTakeover(): Promise<ToolResult> {
    return { ok: true, data: {} };
  }
  async relayInput(): Promise<ToolResult> {
    return { ok: true, data: {} };
  }
  startLive(): void {}
  stopLive(): void {}
  async close(): Promise<void> {}
}

class ScriptedAdapter implements ProviderAdapter {
  readonly kind = "openai_compat" as const;
  readonly requests: AdapterCompleteRequest[] = [];
  private readonly script: (
    call: number,
    req: AdapterCompleteRequest,
  ) => AdapterCompleteResponse;

  constructor(
    script: (call: number, req: AdapterCompleteRequest) => AdapterCompleteResponse,
  ) {
    this.script = script;
  }

  async complete(req: AdapterCompleteRequest): Promise<AdapterCompleteResponse> {
    this.requests.push(structuredClone(req));
    return this.script(this.requests.length, req);
  }
}

const allow = () => ({ decision: "allow" as const });

function base(computer: StableComputer, adapter: ProviderAdapter) {
  return {
    taskId: "task_fixture",
    computerId: computer.computerId,
    goal: "finish fixture",
    model: "mock-model",
    adapter,
    computer,
    driver: createA11yDriver(computer),
    declaredOrigins: {
      readable: ["https://fixture.local"],
      writable: ["https://fixture.local"],
    },
    policyGate: allow,
  };
}

describe("standalone agent loop", () => {
  it("completes a three-step golden flow and persists transcript rows", async () => {
    const computer = new StableComputer();
    const adapter = new ScriptedAdapter((call) => ({
      tool_calls:
        call === 1
          ? [
              {
                id: "c1",
                name: "browser_click",
                arguments: {
                  snapshot_id: "snap_fixed",
                  ref: "e1",
                  button: null,
                  double_click: null,
                },
              },
            ]
          : call === 2
            ? [
                {
                  id: "c2",
                  name: "browser_type",
                  arguments: {
                    snapshot_id: "snap_fixed",
                    ref: "e1",
                    text: "hello",
                    submit: null,
                    slowly: null,
                  },
                },
              ]
            : [
                {
                  id: "c3",
                  name: "done",
                  arguments: { summary: "golden complete", status: "success" },
                },
              ],
      usage: { tokens_in: 10, tokens_out: 2, usd_est: 0.001 },
    }));
    const store = new Store();
    const result = await runAgentLoop({ ...base(computer, adapter), store });
    assert.equal(result.status, "completed");
    assert.equal(result.steps, 3);
    assert.equal(adapter.requests.length, 3);
    assert.equal(result.usage.tokens_in, 30);
    const transcriptRows = store.db
      .prepare("SELECT COUNT(*) AS n FROM steps WHERE task_id = ?")
      .get("task_fixture") as { n: number };
    assert.ok(transcriptRows.n >= 6);
    store.close();
  });

  it("emits usage and stops before another provider call at the spend cap", async () => {
    const computer = new StableComputer();
    const adapter = new ScriptedAdapter(() => ({
      tool_calls: [
        {
          id: "wait",
          name: "browser_wait",
          arguments: {
            timeout_ms: null,
            ms: 1,
            text: null,
            url_glob: null,
            load_state: null,
          },
        },
      ],
      usage: { tokens_in: 1, tokens_out: 1, usd_est: 0.6 },
    }));
    const events: string[] = [];
    const result = await runAgentLoop({
      ...base(computer, adapter),
      spendCapUsd: 0.5,
      emit: (event) => events.push(event.type),
    });
    assert.equal(result.reason, "spend_cap");
    assert.equal(adapter.requests.length, 1);
    assert.ok(events.includes("usage"));
  });

  it("emits policy.denied with cap, spend, and task_id when the spend cap trips", async () => {
    const computer = new StableComputer();
    const adapter = new ScriptedAdapter(() => ({
      tool_calls: [
        {
          id: "wait",
          name: "browser_wait",
          arguments: {
            timeout_ms: null,
            ms: 1,
            text: null,
            url_glob: null,
            load_state: null,
          },
        },
      ],
      usage: { tokens_in: 1, tokens_out: 1, usd_est: 0.6 },
    }));
    const events: Array<{ type: string; body: Record<string, unknown>; task_id: string }> = [];
    const result = await runAgentLoop({
      ...base(computer, adapter),
      spendCapUsd: 0.5,
      emit: (event) =>
        events.push({ type: event.type, body: event.body, task_id: event.task_id }),
    });
    assert.equal(result.reason, "spend_cap");
    const rec = events.find((e) => e.type === "policy.denied" && e.body.reason === "spend_cap");
    assert.ok(rec);
    assert.equal(rec!.body.cap_usd, 0.5);
    assert.equal(rec!.body.spend_usd, 0.6);
    assert.equal(rec!.task_id, "task_fixture");
    assert.equal(rec!.body.task_id, "task_fixture");
  });

  it("stops when the same action appears three times with unchanged observation", async () => {
    const computer = new StableComputer();
    const adapter = new ScriptedAdapter(() => ({
      tool_calls: [
        {
          id: "repeat",
          name: "browser_click",
          arguments: {
            snapshot_id: "snap_fixed",
            ref: "e1",
            button: null,
            double_click: null,
          },
        },
      ],
      usage: { tokens_in: 1, tokens_out: 1, usd_est: 0 },
    }));
    const result = await runAgentLoop({ ...base(computer, adapter), maxSteps: 10 });
    assert.equal(result.reason, "loop_detected");
    assert.equal(adapter.requests.length, 3);
  });

  it("detects A,B,A,B,A,B period-2 loops with unchanged observation", async () => {
    const click = {
      snapshot_id: "snap_fixed",
      ref: "e1",
      button: null,
      double_click: null,
    };
    const type = {
      snapshot_id: "snap_fixed",
      ref: "e1",
      text: "hello",
      submit: null,
      slowly: null,
    };
    const computer = new StableComputer();
    const adapter = new ScriptedAdapter((call) => ({
      tool_calls: [
        call % 2 === 1
          ? { id: `a${call}`, name: "browser_click", arguments: click }
          : { id: `b${call}`, name: "browser_type", arguments: type },
      ],
      usage: { tokens_in: 1, tokens_out: 1, usd_est: 0 },
    }));
    const events: Array<{ type: string; body: Record<string, unknown> }> = [];
    const result = await runAgentLoop({
      ...base(computer, adapter),
      maxSteps: 10,
      emit: (event) => events.push({ type: event.type, body: event.body }),
    });
    assert.equal(result.reason, "loop_detected");
    assert.ok(adapter.requests.length >= 4);
    assert.ok(adapter.requests.length <= 6);
    const paused = events.find((e) => e.type === "task.step" && e.body.reason === "loop_detected");
    assert.ok(paused);
    assert.match(String(paused!.body.detail), /cycle/i);
  });

  it("does not flag A,B,C when observations change", async () => {
    const computer = new StableComputer();
    computer.varySnapshots = true;
    const adapter = new ScriptedAdapter((call) => {
      if (call === 1) {
        return {
          tool_calls: [
            {
              id: "a",
              name: "browser_click",
              arguments: {
                snapshot_id: "snap_fixed",
                ref: "e1",
                button: null,
                double_click: null,
              },
            },
          ],
          usage: { tokens_in: 1, tokens_out: 1, usd_est: 0 },
        };
      }
      if (call === 2) {
        return {
          tool_calls: [
            {
              id: "b",
              name: "browser_type",
              arguments: {
                snapshot_id: "snap_fixed",
                ref: "e1",
                text: "hello",
                submit: null,
                slowly: null,
              },
            },
          ],
          usage: { tokens_in: 1, tokens_out: 1, usd_est: 0 },
        };
      }
      if (call === 3) {
        return {
          tool_calls: [
            {
              id: "c",
              name: "browser_press",
              arguments: { key: "Enter", snapshot_id: "snap_fixed", ref: "e1" },
            },
          ],
          usage: { tokens_in: 1, tokens_out: 1, usd_est: 0 },
        };
      }
      return {
        tool_calls: [
          { id: "d", name: "done", arguments: { summary: "moved on", status: "success" } },
        ],
        usage: { tokens_in: 1, tokens_out: 1, usd_est: 0 },
      };
    });
    const result = await runAgentLoop({ ...base(computer, adapter), maxSteps: 10 });
    assert.equal(result.reason, "completed");
    assert.notEqual(result.reason, "loop_detected");
  });

  it("does not flag genuine pagination (same tool, changing page arg)", async () => {
    const computer = new StableComputer();
    const adapter = new ScriptedAdapter((call) => {
      if (call <= 6) {
        return {
          tool_calls: [
            {
              id: `p${call}`,
              name: "browser_navigate",
              arguments: {
                url: `https://fixture.local/?page=${call}`,
                wait_until: null,
              },
            },
          ],
          usage: { tokens_in: 1, tokens_out: 1, usd_est: 0 },
        };
      }
      return {
        tool_calls: [
          { id: "d", name: "done", arguments: { summary: "paged", status: "success" } },
        ],
        usage: { tokens_in: 1, tokens_out: 1, usd_est: 0 },
      };
    });
    const result = await runAgentLoop({ ...base(computer, adapter), maxSteps: 10 });
    assert.equal(result.reason, "completed");
    assert.equal(adapter.requests.length, 7);
  });

  it("stop-and-asks when the provider stalls", async () => {
    const computer = new StableComputer();
    let asked = "";
    const adapter: ProviderAdapter = {
      kind: "openai_compat",
      complete: () => new Promise<AdapterCompleteResponse>(() => {}),
    };
    const result = await runAgentLoop({
      ...base(computer, adapter),
      stallSec: 0.01,
      stopAndAsk: (reason) => {
        asked = reason;
      },
    });
    assert.equal(result.reason, "stall");
    assert.equal(asked, "stall");
  });

  it("pauses for takeover and never sends E_TAKEOVER_BUSY as a model result", async () => {
    const computer = new StableComputer();
    computer.busy = true;
    const adapter = new ScriptedAdapter(() => ({
      tool_calls: [
        {
          id: "click",
          name: "browser_click",
          arguments: {
            snapshot_id: "snap_fixed",
            ref: "e1",
            button: null,
            double_click: null,
          },
        },
      ],
      usage: { tokens_in: 1, tokens_out: 1, usd_est: 0 },
    }));
    const result = await runAgentLoop({ ...base(computer, adapter) });
    assert.equal(result.reason, "takeover");
    assert.equal(adapter.requests.length, 1);
    assert.doesNotMatch(JSON.stringify(adapter.requests), /E_TAKEOVER_BUSY/);
  });

  it("does not send an observation-time E_TAKEOVER_BUSY to the provider", async () => {
    const computer = new StableComputer();
    computer.busyObservation = true;
    const adapter = new ScriptedAdapter(() => ({
      tool_calls: [],
      usage: { tokens_in: 1, tokens_out: 1 },
    }));
    const result = await runAgentLoop({ ...base(computer, adapter) });
    assert.equal(result.reason, "takeover");
    assert.equal(adapter.requests.length, 0);
  });

  it("pauses immediately after a successful takeover request", async () => {
    const computer = new StableComputer();
    const adapter = new ScriptedAdapter(() => ({
      tool_calls: [
        {
          id: "takeover",
          name: "request_takeover",
          arguments: { reason: "login", category: "password" },
        },
      ],
      usage: { tokens_in: 1, tokens_out: 1, usd_est: 0 },
    }));
    const result = await runAgentLoop({ ...base(computer, adapter) });
    assert.equal(result.reason, "takeover");
    assert.equal(adapter.requests.length, 1);
  });

  it("resolves emit(tool.call) before computer.call is invoked", async () => {
    const computer = new StableComputer();
    const order: string[] = [];
    const originalCall = computer.call.bind(computer);
    computer.call = async (method: string, params?: unknown) => {
      if (method !== "browser_snapshot") order.push("call");
      return originalCall(method, params);
    };
    const adapter = new ScriptedAdapter((call) =>
      call === 1
        ? {
            tool_calls: [
              {
                id: "c1",
                name: "browser_click",
                arguments: {
                  snapshot_id: "snap_fixed",
                  ref: "e1",
                  button: null,
                  double_click: null,
                },
              },
            ],
            usage: { tokens_in: 1, tokens_out: 1, usd_est: 0 },
          }
        : {
            tool_calls: [
              { id: "d", name: "done", arguments: { summary: "ok", status: "success" } },
            ],
            usage: { tokens_in: 1, tokens_out: 1, usd_est: 0 },
          },
    );
    const result = await runAgentLoop({
      ...base(computer, adapter),
      emit: async (event) => {
        if (event.type !== "tool.call") return;
        order.push("emit-start");
        await new Promise((resolve) => setTimeout(resolve, 25));
        order.push("emit-resolved");
      },
    });
    assert.equal(result.reason, "completed");
    const first = order.indexOf("emit-start");
    const resolved = order.indexOf("emit-resolved");
    const invoked = order.indexOf("call");
    assert.ok(first >= 0 && resolved > first && invoked > resolved);
    assert.deepEqual(order.slice(first, invoked + 1).slice(0, 3), [
      "emit-start",
      "emit-resolved",
      "call",
    ]);
  });

  const waitArgs = {
    timeout_ms: null,
    ms: 1,
    text: null,
    url_glob: null,
    load_state: null,
  };

  it("compacts once when prompt tokens exceed compact_at and the next request is smaller", async () => {
    const computer = new StableComputer();
    const adapter = new ScriptedAdapter((call) =>
      call < 5
        ? {
            tool_calls: [{ id: `w${call}`, name: "browser_wait", arguments: waitArgs }],
            usage: {
              tokens_in: call === 4 ? 80 : 10,
              tokens_out: 1,
              usd_est: 0,
            },
          }
        : {
            tool_calls: [
              { id: "d", name: "done", arguments: { summary: "compacted", status: "success" } },
            ],
            usage: { tokens_in: 10, tokens_out: 1, usd_est: 0 },
          },
    );
    const store = new Store();
    const result = await runAgentLoop({
      ...base(computer, adapter),
      store,
      compactAt: 0.5,
      contextTokensMax: 100,
      tokenCapIn: null,
      compactAfterSteps: 10_000,
      spendCapUsd: 99,
      maxSteps: 10,
    });
    assert.equal(result.reason, "completed");
    const compactionRows = store.db
      .prepare("SELECT COUNT(*) AS n FROM steps WHERE task_id = ? AND kind = ?")
      .get("task_fixture", "compaction") as { n: number };
    assert.equal(compactionRows.n, 1);
    assert.ok(adapter.requests.length >= 5);
    const crossed = Buffer.byteLength(JSON.stringify(adapter.requests[3]!.messages));
    const next = Buffer.byteLength(JSON.stringify(adapter.requests[4]!.messages));
    assert.ok(next < crossed, `next request ${next} should be smaller than compact trigger ${crossed}`);
    store.close();
  });

  it("stops with spend_cap when cumulative input tokens exceed token_cap_in", async () => {
    const computer = new StableComputer();
    const adapter = new ScriptedAdapter(() => ({
      tool_calls: [{ id: "wait", name: "browser_wait", arguments: waitArgs }],
      usage: { tokens_in: 100, tokens_out: 1, usd_est: 0 },
    }));
    const events: Array<{ type: string; body: Record<string, unknown> }> = [];
    const result = await runAgentLoop({
      ...base(computer, adapter),
      tokenCapIn: 50,
      compactAt: 1,
      contextTokensMax: 100_000,
      spendCapUsd: 99,
      maxSteps: 10,
      emit: (event) => events.push({ type: event.type, body: event.body }),
    });
    assert.equal(result.reason, "spend_cap");
    assert.equal(adapter.requests.length, 1);
    assert.ok(events.some((e) => e.type === "usage"));
    const paused = events.find((e) => e.type === "task.step" && e.body.reason === "spend_cap");
    assert.ok(paused);
    assert.match(String(paused!.body.detail), /token_cap_in/);
  });

  it("USD cap + done finishes spend_cap and emits policy.denied once", async () => {
    const computer = new StableComputer();
    const adapter = new ScriptedAdapter(() => ({
      tool_calls: [
        { id: "d", name: "done", arguments: { summary: "would complete", status: "success" } },
      ],
      usage: { tokens_in: 1, tokens_out: 1, usd_est: 1 },
    }));
    const events: Array<{ type: string; body: Record<string, unknown> }> = [];
    const result = await runAgentLoop({
      ...base(computer, adapter),
      spendCapUsd: 0.5,
      emit: (event) => events.push({ type: event.type, body: event.body }),
    });
    assert.equal(result.status, "paused");
    assert.equal(result.reason, "spend_cap");
    assert.equal(events.filter((e) => e.type === "policy.denied" && e.body.reason === "spend_cap").length, 1);
    assert.equal(events.some((e) => e.type === "task.completed"), false);
    assert.equal(events.some((e) => e.type === "tool.call"), false);
    assert.equal(computer.calls.some((c) => c.method === "done"), false);
  });

  it("USD cap with no tool call finishes spend_cap, not model_response", async () => {
    const computer = new StableComputer();
    const adapter = new ScriptedAdapter(() => ({
      content: "plain text, no tools",
      tool_calls: [],
      usage: { tokens_in: 1, tokens_out: 1, usd_est: 1 },
    }));
    const events: Array<{ type: string; body: Record<string, unknown> }> = [];
    const result = await runAgentLoop({
      ...base(computer, adapter),
      spendCapUsd: 0.5,
      emit: (event) => events.push({ type: event.type, body: event.body }),
    });
    assert.equal(result.reason, "spend_cap");
    assert.notEqual(result.reason, "model_response");
    assert.equal(events.filter((e) => e.type === "policy.denied" && e.body.reason === "spend_cap").length, 1);
    assert.equal(events.some((e) => e.type === "task.step" && e.body.reason === "model_response"), false);
  });

  it("token cap + done finishes spend_cap before the done call", async () => {
    const computer = new StableComputer();
    const adapter = new ScriptedAdapter(() => ({
      tool_calls: [
        { id: "d", name: "done", arguments: { summary: "would complete", status: "success" } },
      ],
      usage: { tokens_in: 100, tokens_out: 1, usd_est: 0 },
    }));
    const events: Array<{ type: string; body: Record<string, unknown> }> = [];
    const result = await runAgentLoop({
      ...base(computer, adapter),
      tokenCapIn: 50,
      spendCapUsd: 99,
      emit: (event) => events.push({ type: event.type, body: event.body }),
    });
    assert.equal(result.reason, "spend_cap");
    assert.equal(events.filter((e) => e.type === "policy.denied" && e.body.reason === "spend_cap").length, 1);
    assert.equal(events.some((e) => e.type === "task.completed"), false);
    assert.equal(computer.calls.some((c) => c.method === "done"), false);
    const paused = events.find((e) => e.type === "task.step" && e.body.reason === "spend_cap");
    assert.ok(paused);
    assert.match(String(paused!.body.detail), /token_cap_in/);
  });

  it("the 20th unpriced response + done finishes spend_cap", async () => {
    const computer = new StableComputer();
    const adapter = new ScriptedAdapter((call) =>
      call < 20
        ? {
            tool_calls: [{ id: `w${call}`, name: "browser_wait", arguments: waitArgs }],
            usage: { tokens_in: 1, tokens_out: 1 },
          }
        : {
            tool_calls: [
              { id: "d", name: "done", arguments: { summary: "would complete", status: "success" } },
            ],
            usage: { tokens_in: 1, tokens_out: 1 },
          },
    );
    const events: Array<{ type: string; body: Record<string, unknown> }> = [];
    const result = await runAgentLoop({
      ...base(computer, adapter),
      spendCapUsd: 99,
      maxSteps: 30,
      emit: (event) => events.push({ type: event.type, body: event.body }),
    });
    assert.equal(result.reason, "spend_cap");
    assert.equal(adapter.requests.length, 20);
    assert.equal(events.filter((e) => e.type === "policy.denied" && e.body.reason === "spend_cap").length, 1);
    assert.equal(events.some((e) => e.type === "task.completed"), false);
    assert.equal(computer.calls.some((c) => c.method === "done"), false);
    const paused = events.find((e) => e.type === "task.step" && e.body.reason === "spend_cap");
    assert.ok(paused);
    assert.match(String(paused!.body.detail), /20-call budget/);
  });

  it("USD and token caps together emit policy.denied once", async () => {
    const computer = new StableComputer();
    const adapter = new ScriptedAdapter(() => ({
      tool_calls: [
        { id: "d", name: "done", arguments: { summary: "would complete", status: "success" } },
      ],
      usage: { tokens_in: 100, tokens_out: 1, usd_est: 1 },
    }));
    const events: Array<{ type: string; body: Record<string, unknown> }> = [];
    const result = await runAgentLoop({
      ...base(computer, adapter),
      spendCapUsd: 0.5,
      tokenCapIn: 50,
      emit: (event) => events.push({ type: event.type, body: event.body }),
    });
    assert.equal(result.reason, "spend_cap");
    assert.equal(events.filter((e) => e.type === "policy.denied").length, 1);
    assert.equal(events.filter((e) => e.type === "policy.denied" && e.body.reason === "spend_cap").length, 1);
    assert.equal(events.some((e) => e.type === "task.completed"), false);
  });

  it("does not compact or hit token_cap_in below either threshold", async () => {
    const computer = new StableComputer();
    const adapter = new ScriptedAdapter((call) =>
      call < 3
        ? {
            tool_calls: [{ id: `w${call}`, name: "browser_wait", arguments: waitArgs }],
            usage: { tokens_in: 10, tokens_out: 1, usd_est: 0 },
          }
        : {
            tool_calls: [
              { id: "d", name: "done", arguments: { summary: "under caps", status: "success" } },
            ],
            usage: { tokens_in: 10, tokens_out: 1, usd_est: 0 },
          },
    );
    const store = new Store();
    const events: string[] = [];
    const result = await runAgentLoop({
      ...base(computer, adapter),
      store,
      compactAt: 0.5,
      contextTokensMax: 1000,
      tokenCapIn: 1000,
      compactAfterSteps: 10_000,
      spendCapUsd: 99,
      maxSteps: 10,
      emit: (event) => events.push(event.type),
    });
    assert.equal(result.reason, "completed");
    const compactionRows = store.db
      .prepare("SELECT COUNT(*) AS n FROM steps WHERE task_id = ? AND kind = ?")
      .get("task_fixture", "compaction") as { n: number };
    assert.equal(compactionRows.n, 0);
    assert.ok(events.includes("usage"));
    store.close();
  });

  it("surfaces a rejecting emit(tool.result) as a loop error, not an unhandled rejection", async () => {
    const computer = new StableComputer();
    const adapter = new ScriptedAdapter(() => ({
      tool_calls: [
        {
          id: "c1",
          name: "browser_click",
          arguments: {
            snapshot_id: "snap_fixed",
            ref: "e1",
            button: null,
            double_click: null,
          },
        },
      ],
      usage: { tokens_in: 1, tokens_out: 1, usd_est: 0 },
    }));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const result = await runAgentLoop({
        ...base(computer, adapter),
        emit: async (event) => {
          if (event.type === "tool.result") throw new Error("emit-tool-result-boom");
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(result.status, "failed");
      assert.equal(result.reason, "failed");
      assert.equal(unhandled.length, 0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("resolves emit(task.completed) before runAgentLoop returns", async () => {
    const computer = new StableComputer();
    const adapter = new ScriptedAdapter(() => ({
      tool_calls: [
        { id: "d", name: "done", arguments: { summary: "ok", status: "success" } },
      ],
      usage: { tokens_in: 1, tokens_out: 1, usd_est: 0 },
    }));
    const order: string[] = [];
    const result = await runAgentLoop({
      ...base(computer, adapter),
      emit: async (event) => {
        if (event.type !== "task.completed") return;
        order.push("emit-start");
        await new Promise((resolve) => setTimeout(resolve, 25));
        order.push("emit-resolved");
      },
    });
    order.push("loop-returned");
    assert.equal(result.reason, "completed");
    assert.deepEqual(order, ["emit-start", "emit-resolved", "loop-returned"]);
  });
});



  it("parks an explicit takeover until release, then resumes with matching tool response", async () => {
    const computer = new StableComputer();
    const requested = Promise.withResolvers<void>();
    const released = Promise.withResolvers<boolean>();
    const adapter = new ScriptedAdapter((call) => ({
      tool_calls: call === 1
        ? [{ id: "human", name: "request_takeover", arguments: { reason: "fixture login", category: "login" } }]
        : [{ id: "done", name: "done", arguments: {} }],
      usage: { tokens_in: 1, tokens_out: 1, usd_est: 0 },
    }));
    const run = runAgentLoop({ ...base(computer, adapter), waitForResume: async (reason) => {
      assert.equal(reason, "takeover");
      requested.resolve();
      return released.promise;
    } });
    await requested.promise;
    assert.equal(adapter.requests.length, 1);
    released.resolve(true);
    assert.equal((await run).status, "completed");
    assert.equal(adapter.requests.length, 2);
    assert.ok(adapter.requests[1]!.messages.some((m) => m.role === "tool" && m.tool_call_id === "human"));
    assert.equal(computer.calls.filter((c) => c.method === "request_takeover").length, 1);
  });

it("a daemon-dispatched tool call produces one audit record", async () => {
  const store = new Store(":memory:");
  const computer = createFakeComputerClient("audit-computer");
  store.insertComputer({
    id: computer.computerId,
    name: "audit",
    capabilities: ["browser"],
    persistent: false,
    status: "running",
  });
  const task = store.insertTask({
    computer_id: computer.computerId,
    goal: "finish",
    capabilities: ["browser"],
    max_steps: 2,
  });
  const path = join(mkdtempSync(join(tmpdir(), "mb-tool-audit-")), "audit.jsonl");
  const audit = new AuditLog({
    path,
    keyProvider: staticAuditKey(Buffer.from("tool-audit-unit-test-key-123456")),
  });
  const emit = async (
    type: Parameters<AuditLog["append"]>[0]["type"],
    body: Record<string, unknown>,
    ids?: { task_id?: string; computer_id?: string },
  ) => {
    await audit.append({ type, body, task_id: ids?.task_id, computer_id: ids?.computer_id });
  };
  const dispatcher = createToolDispatcher({ store, getClient: () => computer, emit });
  const adapter: ProviderAdapter = {
    kind: "openai_compat",
    async complete() {
      return {
        tool_calls: [{ id: "done-1", name: "done", arguments: { summary: "ok" } }],
        usage: { tokens_in: 1, tokens_out: 1, usd_est: 0 },
      };
    },
  };

  try {
    const result = await runAgentLoop({
      taskId: task.id,
      computerId: computer.computerId,
      goal: task.goal,
      model: "unit",
      adapter,
      driver: createA11yDriver(computer),
      computer,
      store,
      dispatchTool: (tool, args, context) =>
        dispatcher.dispatch(tool, args, {
          taskId: task.id,
          computerId: computer.computerId,
          ...context,
        }),
      emit: (event) => emit(event.type, event.body, {
        task_id: event.task_id,
        computer_id: event.computer_id,
      }),
    });
    assert.equal(result.status, "completed");
    assert.equal(
      readAuditRecords(path).filter((record) => record.type === "tool.call").length,
      1,
    );
  } finally {
    await computer.close();
    store.close();
  }
});

it("answers an operator during human control without observations or tools", async () => {
  const computer = new StableComputer();
  const store = new Store(":memory:");
  store.insertComputer({ id: computer.computerId, name: "fixture", capabilities: ["browser"], persistent: false, status: "running" });
  store.insertTask({ id: "task_fixture", computer_id: computer.computerId, goal: "finish fixture", max_steps: 10 });
  store.insertStep("task_fixture", 0, "user", { role: "user", content: "Why are you waiting?" });
  const adapter = new ScriptedAdapter((_, request) => {
    assert.equal(computer.calls.length, 0);
    assert.deepEqual(request.tools, []);
    assert.ok(request.messages.some(message => message.role === "user" && message.content === "Why are you waiting?"));
    return { content: "Waiting for your sign-in.", tool_calls: [], usage: { tokens_in: 2, tokens_out: 3, usd_est: 0.01 } };
  });
  try {
    const result = await runAgentLoop({ ...base(computer, adapter), store, maxSteps: 1, isWaiting: () => true });
    assert.equal(result.status, "paused");
    assert.equal(result.usage.usd_est, 0.01);
    assert.ok(store.taskTranscript("task_fixture").some(message => message.content === "Waiting for your sign-in."));
  } finally { store.close(); }
});
