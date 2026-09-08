import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakeComputerClient } from "../../../src/computer-client/fake.ts";
import { createToolDispatcher, enforceHarnessMcpSpendCap } from "../../../src/daemon/dispatcher.ts";
import { Store } from "../../../src/daemon/store.ts";
import type { EventType, ToolResult } from "../../../src/types/contracts.ts";

const TASK_ID = "spend-cap-negative";
const COMPUTER_ID = "c_harness";

interface Emitted {
  type: EventType;
  body: Record<string, unknown>;
  ids?: { task_id?: string; computer_id?: string };
}

function harness(spendCapUsd: number, failedAuditAppends = 0): {
  store: Store;
  events: Emitted[];
  call(): Promise<ToolResult>;
  close(): Promise<void>;
} {
  const store = new Store(":memory:");
  store.insertComputer({
    id: COMPUTER_ID,
    name: "harness",
    capabilities: ["browser"],
    persistent: false,
    status: "running",
  });
  store.insertHarnessTaskBinding({
    task_id: TASK_ID,
    computer_id: COMPUTER_ID,
    spend_cap_usd: spendCapUsd,
    max_steps: 20,
    proxy_usd_per_tool_call: 0.01,
  });
  const events: Emitted[] = [];
  const emit = (
    type: EventType,
    body: Record<string, unknown>,
    ids?: { task_id?: string; computer_id?: string },
  ) => {
    if (type === "policy.denied" && failedAuditAppends-- > 0) {
      throw new Error("audit append failed");
    }
    events.push({ type, body, ids });
  };
  const computer = createFakeComputerClient(COMPUTER_ID);
  const dispatcher = createToolDispatcher({
    store,
    getClient: () => computer,
    emit,
  });
  return {
    store,
    events,
    async call() {
      const spendDenied = await enforceHarnessMcpSpendCap(
        { store, emit },
        COMPUTER_ID,
      );
      if (spendDenied) return spendDenied;
      return dispatcher.dispatch(
        "browser_snapshot",
        {
          scope: null,
          interactive_only: false,
          depth: 4,
          max_chars: 2_000,
        },
        {
          taskId: TASK_ID,
          computerId: COMPUTER_ID,
          origin: "https://example.com",
        },
      );
    },
    async close() {
      await computer.close();
      store.close();
    },
  };
}

function spendDenials(events: Emitted[]): Emitted[] {
  return events.filter(
    (event) => event.type === "policy.denied" && event.body.reason === "spend_cap",
  );
}

function spends(events: Emitted[]): unknown[] {
  return events.filter((event) => event.type === "usage").map((event) => event.body.usd_est);
}

function steps(events: Emitted[]): unknown[] {
  return events.filter((event) => event.type === "usage").map((event) => event.body.steps);
}

describe("harness MCP spend-cap", () => {
  it("reports the running estimate the cap is measured against, on every counted call", async () => {
    const ctx = harness(0.05);
    try {
      for (let i = 0; i < 5; i += 1) await ctx.call();
      // Five counted calls, five totals, ending on the cap that stopped it.
      assert.deepEqual(spends(ctx.events), [0.01, 0.02, 0.03, 0.04, 0.05]);
      // A harness run counts its steps in tool calls. Reporting 0 made every
      // harness task read as no work at all beside a real dollar figure.
      assert.deepEqual(steps(ctx.events), [1, 2, 3, 4, 5]);
      // A refused call is not charged for, so it does not move the meter either.
      await ctx.call();
      assert.equal(spends(ctx.events).length, 5);
    } finally {
      await ctx.close();
    }
  });

  it("executes a call when the proxy cap is not yet reached", async () => {
    const ctx = harness(0.02);
    try {
      assert.equal((await ctx.call()).ok, true);
      const binding = ctx.store.getHarnessTaskBinding(COMPUTER_ID);
      assert.equal(binding?.observed_tool_calls, 1);
      assert.equal(binding?.denied, 0);
      assert.equal(spendDenials(ctx.events).length, 0);
      assert.equal(ctx.events.filter((event) => event.type === "tool.call").length, 1);
    } finally {
      await ctx.close();
    }
  });

  it("refuses the boundary call and emits one truthful spend-cap record", async () => {
    const ctx = harness(0.02);
    try {
      assert.equal((await ctx.call()).ok, true);
      const denied = await ctx.call();
      assert.equal(denied.ok, false);
      if (denied.ok) assert.fail("boundary call unexpectedly succeeded");
      assert.equal(denied.error.code, "E_SPEND_CAP");

      const records = spendDenials(ctx.events);
      assert.equal(records.length, 1);
      assert.deepEqual(records[0], {
        type: "policy.denied",
        body: {
          reason: "spend_cap",
          budget_kind: "mcp_tool_call_proxy",
          cap_usd: 0.02,
          spend_usd: 0.02,
          proxy_estimate_usd: 0.02,
          proxy_usd_per_tool_call: 0.01,
          observed_tool_calls: 2,
          max_steps: 20,
          execution: "harness",
        },
        ids: { task_id: TASK_ID, computer_id: COMPUTER_ID },
      });
      assert.equal(ctx.events.filter((event) => event.type === "tool.call").length, 1);
    } finally {
      await ctx.close();
    }
  });

  it("keeps all later calls fail-closed without another audit record", async () => {
    const ctx = harness(0.01);
    try {
      const boundary = await ctx.call();
      const later = await ctx.call();
      assert.equal(boundary.ok, false);
      assert.equal(later.ok, false);
      if (boundary.ok || later.ok) assert.fail("denied call unexpectedly succeeded");
      assert.equal(boundary.error.code, "E_SPEND_CAP");
      assert.equal(later.error.code, "E_SPEND_CAP");
      assert.equal(spendDenials(ctx.events).length, 1);
      assert.equal(ctx.events.filter((event) => event.type === "tool.call").length, 0);
      assert.equal(
        ctx.store.getHarnessTaskBinding(COMPUTER_ID)?.observed_tool_calls,
        1,
      );
    } finally {
      await ctx.close();
    }
  });

  it("retries a failed boundary audit append once on a later denied call", async () => {
    const ctx = harness(0.01, 1);
    try {
      assert.equal((await ctx.call()).ok, false);
      assert.equal(spendDenials(ctx.events).length, 0);
      assert.equal(ctx.store.getHarnessTaskBinding(COMPUTER_ID)?.denial_audit_reserved, 0);

      assert.equal((await ctx.call()).ok, false);
      assert.equal((await ctx.call()).ok, false);
      assert.equal(spendDenials(ctx.events).length, 1);
      assert.equal(ctx.store.getHarnessTaskBinding(COMPUTER_ID)?.denial_audit_reserved, 1);
    } finally {
      await ctx.close();
    }
  });

  it("emits one denial audit when denied calls overlap", async () => {
    const ctx = harness(0.01);
    try {
      const results = await Promise.all([ctx.call(), ctx.call()]);
      assert.deepEqual(results.map((result) => result.ok), [false, false]);
      assert.equal(spendDenials(ctx.events).length, 1);
    } finally {
      await ctx.close();
    }
  });

  it("denies the first call when the $0.01 estimate reaches the $0.01 cap", async () => {
    const ctx = harness(0.01);
    try {
      const denied = await ctx.call();
      assert.equal(denied.ok, false);
      if (denied.ok) assert.fail("cap boundary call unexpectedly succeeded");
      assert.equal(denied.error.code, "E_SPEND_CAP");
      assert.equal(ctx.store.getHarnessTaskBinding(COMPUTER_ID)?.observed_tool_calls, 1);
      assert.equal(spendDenials(ctx.events).length, 1);
    } finally {
      await ctx.close();
    }
  });
});
