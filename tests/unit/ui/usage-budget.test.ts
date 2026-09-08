import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../../src/ui/api.ts";
import {
  budgetEntry,
  budgetNoteText,
  budgetRejected,
  readBudgetPreference,
  renderUsage,
  writeBudgetPreference,
} from "../../../src/ui/usage.ts";
import { all, byText, installDom, settle, type FakeElement } from "./fake-dom.ts";

/**
 * Settings → Usage, "Budget for one task". The field accepted $10.00, said
 * "sent with every task you start here", and every task it started ran on
 * $2.00 — the daemon clamped it and nothing on screen said so.
 */

const json = (body: unknown) => Response.json(body as Record<string, unknown>);

type Session = Record<string, unknown>;

async function mountUsage(session: Session, stored?: number) {
  const dom = installDom({
    hash: "#/settings/usage",
    fetch: async (path) => {
      if (path.startsWith("/api/v1/audit")) return json({ records: [] });
      if (path.startsWith("/api/v1/tasks")) return json({ tasks: [] });
      if (path.startsWith("/api/v1/session")) return json(session);
      return json({});
    },
  });
  if (stored !== undefined) writeBudgetPreference(stored);
  const pane = document.createElement("div") as unknown as FakeElement;
  dom.root.append(pane as never);
  const dispose = renderUsage(pane as unknown as HTMLElement);
  await settle();
  await settle();
  const input = all(pane).find(
    (n) => n.tagName === "INPUT" && n.getAttribute("inputmode") === "decimal",
  ) as FakeElement;
  const text = () => all(pane).map((n) => n.textContent).join(" ");
  return { dom, pane, input, text, restore: () => { dispose(); dom.restore(); } };
}

const BUDGET = { ok: true, spend_cap_usd: 2, budget: { default_usd: 2, max_usd: 10 } };

test("the budget box names the default and the maximum it will accept", async () => {
  const t = await mountUsage(BUDGET);
  try {
    assert.match(t.text(), /A task gets \$2\.00 unless you change it/);
    assert.match(t.text(), /The most one task can have is \$10\.00\./);
    assert.equal(t.input.value, "2.00", "nothing chosen here: the box states what a task gets");
  } finally {
    t.restore();
  }
});

test("a budget above the maximum is refused on the spot, naming the maximum", async () => {
  const t = await mountUsage(BUDGET);
  try {
    t.input.value = "25";
    t.input.fire("input");
    (byText(t.pane, "Save") as FakeElement).fire("click");
    assert.match(t.text(), /One task can have at most \$10\.00\. Put in that or less\./);
    assert.equal(readBudgetPreference(), null, "and nothing is stored for tasks to send");

    // At the maximum it saves, and the box keeps the figure it was given.
    t.input.value = "10";
    t.input.fire("input");
    (byText(t.pane, "Save") as FakeElement).fire("click");
    assert.equal(readBudgetPreference(), 10);
    assert.equal(t.input.value, "10.00");
    assert.match(t.text(), /Saved\. Tasks you start from this Mac stop at \$10\.00\./);
  } finally {
    t.restore();
  }
});

test("on reload the box shows the figure this Mac stored, not the daemon's clamp", async () => {
  // The field self-reverted to 2.00 after a save of 10.00, so the two
  // disagreed silently and the run died on a budget nobody had chosen.
  const t = await mountUsage({ ok: true, spend_cap_usd: 2, budget: { default_usd: 2, max_usd: 10 } }, 10);
  try {
    assert.equal(t.input.value, "10.00");
  } finally {
    t.restore();
  }
});

test("the budget saves even when the session read fails outright", async () => {
  const dom = installDom({ hash: "#/settings/usage", fetch: async () => { throw new Error("offline"); } });
  const pane = document.createElement("div") as unknown as FakeElement;
  dom.root.append(pane as never);
  const dispose = renderUsage(pane as unknown as HTMLElement);
  await settle();
  await settle();
  try {
    const input = all(pane).find(
      (n) => n.tagName === "INPUT" && n.getAttribute("inputmode") === "decimal",
    ) as FakeElement;
    input.value = "4";
    input.fire("input");
    (byText(pane, "Save") as FakeElement).fire("click");
    assert.equal(readBudgetPreference(), 4, "the figure lives on this Mac, so it saves anyway");
  } finally {
    dispose();
    dom.restore();
  }
});

test("what the box accepts, and what it says when the daemon refuses it", () => {
  assert.deepEqual(budgetEntry("4.5", 10), { usd: 4.5 });
  assert.deepEqual(budgetEntry("4.5", null), { usd: 4.5 }, "no known maximum, no invented one");
  assert.deepEqual(budgetEntry("10", 10), { usd: 10 }, "the maximum itself is allowed");
  assert.deepEqual(budgetEntry("10.01", 10), {
    error: "One task can have at most $10.00. Put in that or less.",
  });
  assert.deepEqual(budgetEntry("nope", 10), {
    error: "Put in an amount between $0.01 and $1000.00.",
  });

  assert.equal(
    budgetNoteText(null, null),
    "A task stops when it reaches this. Kept on this Mac and sent with every task you start here.",
  );

  const refused = new ApiError(400, "spend_cap_usd must not exceed the configured cap of 2", {
    error: "E_LIMIT",
    message: "spend_cap_usd must not exceed the configured cap of 2",
  });
  assert.equal(
    budgetRejected(refused),
    "One task can have at most $2.00. Change the budget in Settings → Usage, then start it again.",
  );
  assert.equal(
    budgetRejected(new ApiError(429, "Too many links.", { error: "E_LIMIT" })),
    null,
    "an E_LIMIT about something else is not a budget message",
  );
  assert.equal(budgetRejected(new Error("offline")), null);
});
