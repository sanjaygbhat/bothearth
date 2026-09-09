import assert from "node:assert/strict";
import { test } from "node:test";
import { renderUsage } from "../../../src/ui/usage.ts";
import { all, installDom, settle, type FakeElement } from "./fake-dom.ts";

test("usage shows task totals without budget settings or a session-limit fetch", async () => {
  const requests: string[] = [];
  const dom = installDom({ hash: "#/settings/usage", fetch: async path => {
    requests.push(path);
    if (path.startsWith("/api/v1/audit")) return Response.json({ records: [{
      type: "usage", task_id: "one", ts: "2026-09-09T00:00:00Z",
      body_json: JSON.stringify({ usd_est: 0.42, steps: 3 }),
    }] });
    return Response.json({ tasks: [{ id: "one", goal: "Research", created_at: "2026-09-09T00:00:00Z" }] });
  } });
  const pane = document.createElement("div") as unknown as FakeElement;
  dom.root.append(pane as never);
  const dispose = renderUsage(pane as unknown as HTMLElement);
  try {
    await settle(); await settle();
    const nodes = all(pane);
    assert(nodes.some(n => n.textContent === "$0.42"));
    assert(!nodes.some(n => n.tagName === "INPUT"));
    assert(!requests.some(p => p.startsWith("/api/v1/session")));
    assert.doesNotMatch(nodes.map(n => n.textContent).join(" "), /Budget for|maximum|at most/);
  } finally { dispose(); dom.restore(); }
});
