import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeComputer } from "../../../src/computer-client/fake.ts";
import { createToolDispatcher } from "../../../src/daemon/dispatcher.ts";
import { Store } from "../../../src/daemon/store.ts";
import type { ToolResult } from "../../../src/types/contracts.ts";

test("observed mail remains actionable and real payment controls do not mint a takeover", async () => {
  const store = new Store();
  let yaml = '- row "Example Vendor, Invoice Payment Confirmation" [ref=e1]\n- paragraph: https://shop.example/checkout';
  const acts: string[] = [];
  class ObservedComputer extends FakeComputer {
    override async call(method: string, params?: unknown): Promise<ToolResult> {
      if (method === "browser_snapshot") return { ok: true, data: { url: "https://mail.example/inbox", yaml } };
      if (method === "request_takeover") return super.call(method, params);
      acts.push(method);
      return { ok: true, data: {} };
    }
  }
  const computer = new ObservedComputer("payment-observation");
  store.insertComputer({ id: computer.computerId, name: "mail", capabilities: ["browser"], persistent: false, status: "running" });
  const task = store.insertTask({ computer_id: computer.computerId, goal: "read mail", max_steps: 5 });
  const dispatcher = createToolDispatcher({ store, getClient: () => computer, emit: async () => {} });
  const context = { computerId: computer.computerId, taskId: task.id,
    originSets: { readable: ["mail.example"], writable: ["mail.example"] } };
  try {
    assert.equal((await dispatcher.dispatch("browser_click", { ref: "e1", snapshot_id: "s1" }, context)).ok, true);
    assert.equal((await dispatcher.dispatch("browser_navigate", { url: "https://mail.example/inbox#search/new" }, context)).ok, true);
    assert.deepEqual(acts, ["browser_click", "browser_navigate"]);
    assert.equal(store.listApprovals().length, 0);
    yaml = '- textbox "Card number" [ref=e2]';
    const clicked = await dispatcher.dispatch("browser_click", { ref: "e2", snapshot_id: "s2" }, context);
    assert.equal(clicked.ok, true);
    assert.deepEqual(acts, ["browser_click", "browser_navigate", "browser_click"]);
    assert.equal(store.activeTakeoverForComputer(computer.computerId), undefined);
    assert.equal(store.listApprovals().length, 0);
    const asked = await dispatcher.dispatch("request_takeover", { reason: "payment" }, context);
    assert.equal(asked.ok, true);
    assert.ok(store.activeTakeoverForComputer(computer.computerId));
  } finally { await computer.close(); store.close(); }
});
