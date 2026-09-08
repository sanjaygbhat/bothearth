import assert from "node:assert/strict";
import { test } from "node:test";
import { dayLabel, formatUsd, spendByDay, spendByTask } from "../../../src/ui/usage.ts";
import { all, byText, installDom, settle, type FakeElement } from "./fake-dom.ts";

const json = (body: unknown) => Response.json(body as Record<string, unknown>);

type World = {
  computers: Array<Record<string, unknown>>;
  defaultId: string | null;
  tasks: Array<Record<string, unknown>>;
  records: Array<Record<string, unknown>>;
  mutations: string[];
};

const emptyWorld = (): World => ({ computers: [], defaultId: null, tasks: [], records: [], mutations: [] });

async function mountSection(section: string, world: World) {
  const dom = installDom({ timers: "manual", hash: `#/settings/${section}`, fetch: async (path, init) => {
    if (init?.method && init.method !== "GET") world.mutations.push(`${init.method} ${path}`);
    if (path.startsWith("/api/v1/computers"))
      return json({ default_computer_id: world.defaultId, computers: world.computers });
    if (path.startsWith("/api/v1/tasks")) return json({ tasks: world.tasks });
    if (path.startsWith("/api/v1/audit")) return json({ records: world.records });
    if (path.startsWith("/api/v1/connection")) return json({ status: "connected", provider: "claude", model: "Opus 4.5" });
    if (path.startsWith("/api/v1/runtime")) return json({ ai: { provider: "claude", cli_found: true, cli_path_kind: "path", logged_in: true, detail: "" } });
    if (path.startsWith("/api/v1/session/devices")) return json({ devices: [] });
    if (path.startsWith("/api/v1/session")) return json({ ok: true, spend_cap_usd: 2, origin: "https://fixture.example" });
    if (path.startsWith("/healthz")) return json({ ok: true, version: "0.4.2" });
    return json({});
  } });
  const module = await import(`../../../src/ui/settings.ts?section=${section}&r=${Math.random()}`);
  const view = module.createSettingsView();
  view.mount(dom.root as never, { section });
  await settle();
  await settle();
  return { dom, view, pane: dom.root.querySelector(".set-pane") as FakeElement };
}

const text = (node: FakeElement) => all(node).map((n) => n.textContent).join(" ");

test("with no computer yet, Computers says so instead of showing an empty list", async () => {
  const world = emptyWorld();
  const { dom, view, pane } = await mountSection("computers", world);
  try {
    assert.match(text(pane), /does not have a computer yet/);
    assert.deepEqual(world.mutations, []);
  } finally {
    view.unmount();
    dom.restore();
  }
});

test("a fresh computer needs two clicks, and is refused outright while a task is using it", async () => {
  const world = emptyWorld();
  world.computers = [
    { id: "c1", name: "My browser", capabilities: ["browser"], persistent: true, status: "running", created_at: "" },
  ];
  world.defaultId = "c1";
  world.tasks = [{ id: "t1", computer_id: "c1", goal: "Find the invoices", status: "running" }];

  const { dom, view, pane } = await mountSection("computers", world);
  try {
    assert.match(text(pane), /Working on a task right now/);
    assert.match(text(pane), /keeps the sites it signed into/);

    const fresh = byText(pane, "Use a fresh one") as FakeElement;
    fresh.fire("click");
    await settle();
    assert.match(
      text(pane),
      /A task is already using this browser\. Let it finish or stop it before starting another\./,
    );
    assert.deepEqual(world.mutations, [], "a busy computer is never thrown away behind your back");

    // Now nothing is running: a first click warns, a second click does it.
    world.tasks = [];
    view.update({ section: "usage" });
    view.update({ section: "computers" });
    await settle();
    await settle();
    const again = byText(dom.root.querySelector(".set-pane") as FakeElement, "Use a fresh one") as FakeElement;
    again.fire("click");
    assert.deepEqual(world.mutations, [], "the first click only warns");
    assert.match(text(dom.root.querySelector(".set-pane") as FakeElement), /will need signing in again/);
    (byText(dom.root.querySelector(".set-pane") as FakeElement, "Yes, erase it") as FakeElement).fire("click");
    await settle();
    await settle();
    assert.deepEqual(world.mutations, ["DELETE /api/v1/computers/c1"]);
  } finally {
    view.unmount();
    dom.restore();
  }
});

test("renaming a computer is remembered on this Mac and shows up next time", async () => {
  const world = emptyWorld();
  world.computers = [
    { id: "c1", name: "My browser", capabilities: ["browser"], persistent: true, status: "running", created_at: "" },
  ];
  world.defaultId = "c1";
  const { dom, view, pane, } = await mountSection("computers", world);
  try {
    const input = all(pane).find((n) => n.tagName === "INPUT") as FakeElement;
    assert.equal(input.value, "My browser");
    const save = byText(pane, "Save name") as FakeElement;
    assert.equal(save.hidden, true, "nothing to save until something changes");
    input.value = "Shopping browser";
    input.fire("input");
    assert.equal(save.hidden, false);
    save.fire("click");
    assert.match(text(pane), /Shopping browser/);
    assert.equal(
      JSON.parse(localStorage.getItem("modelbot.computer-names") as string).c1,
      "Shopping browser",
    );
    assert.deepEqual(world.mutations, [], "a name is not a server change");
  } finally {
    view.unmount();
    dom.restore();
  }
});

test("Usage adds up what each task cost, per day and per task, with the unit always stated", () => {
  const records = [
    { type: "usage", ts: "2026-09-06T10:00:00.000Z", task_id: "t1", body_json: '{"usd_est":0.10,"steps":4}' },
    { type: "usage", ts: "2026-09-06T10:05:00.000Z", task_id: "t1", body_json: '{"usd_est":0.42,"steps":11}' },
    { type: "usage", ts: "2026-09-06T12:00:00.000Z", task_id: "t2", body_json: '{"usd_est":0.08,"steps":3}' },
    { type: "task.started", ts: "2026-09-06T12:00:00.000Z", task_id: "t2", body_json: "{}" },
    { type: "usage", ts: "2026-09-05T09:00:00.000Z", task_id: "t3", body_json: "not json" },
  ];
  const tasks = [
    { id: "t1", goal: "Find the invoices", created_at: "2026-09-06T10:00:00.000Z", status: "done" },
    { id: "t2", goal: "Check the links", created_at: "2026-09-06T11:59:00.000Z", status: "done" },
  ];
  const rows = spendByTask(records, tasks);
  assert.deepEqual(
    rows.map((r) => [r.label, r.usd, r.steps]),
    [
      ["Check the links", 0.08, 3],
      ["Find the invoices", 0.42, 11],
    ],
  );
  const days = spendByDay(rows, new Date("2026-09-06T18:00:00.000Z"));
  assert.equal(days.length, 1);
  assert.equal(Number(days[0]?.usd.toFixed(2)), 0.5);
  assert.equal(days[0]?.label, "Today");

  assert.equal(formatUsd(0.5), "$0.50");
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(0.001), "less than $0.01");
  assert.equal(dayLabel("2026-09-05T09:00:00.000Z", new Date("2026-09-06T09:00:00.000Z")), "Yesterday");
  assert.equal(dayLabel("nonsense"), "Unknown day");
});

test("Usage renders a bar list with no chart library and an empty state that reads", async () => {
  const empty = emptyWorld();
  const first = await mountSection("usage", empty);
  try {
    // A setting you can read and not change is not a setting, so the budget is
    // a label, an input carrying the current figure, and a Save beside it.
    // `Kept on this Mac` is the honest scope: the daemon has no settings
    // endpoint, so this figure travels with each task rather than rewriting a
    // server-side default.
    assert.match(text(first.pane), /Budget for one task/);
    assert.match(text(first.pane), /Kept on this Mac/);
    const budgetInput = all(first.pane).find(
      (n) => n.tagName === "INPUT" && n.getAttribute("inputmode") === "decimal",
    );
    assert.ok(budgetInput, "the budget is editable");
    assert.equal(budgetInput.value, "2.00");
    assert.match(text(first.pane), /Nothing to show yet/);
    assert.equal(all(first.pane).some((n) => n.tagName === "CANVAS"), false);
  } finally {
    first.view.unmount();
    first.dom.restore();
  }

  const world = emptyWorld();
  world.tasks = [{ id: "t1", goal: "Find the invoices", created_at: new Date().toISOString(), status: "done" }];
  world.records = [
    { type: "usage", ts: new Date().toISOString(), task_id: "t1", body_json: '{"usd_est":0.42,"steps":11}' },
  ];
  const second = await mountSection("usage", world);
  try {
    assert.match(text(second.pane), /\$0\.42/);
    assert.match(text(second.pane), /Find the invoices/);
    assert.match(text(second.pane), /11 steps/);
    const meter = all(second.pane).find((n) => n.className === "meter") as FakeElement;
    assert.equal(meter.getAttribute("role"), "img");
    assert.match(meter.getAttribute("aria-label") ?? "", /\$0\.42 of \$0\.42/);
  } finally {
    second.view.unmount();
    second.dom.restore();
  }
});

test("About states the version it is actually running and links out safely", async () => {
  const world = emptyWorld();
  const { dom, view, pane } = await mountSection("about", world);
  try {
    assert.match(text(pane), /Version 0\.4\.2 · running on this machine/);
    // ModelBot is source-available under PolyForm Noncommercial, not open
    // source; the About pane is a licensing claim, so the wording is asserted.
    assert.match(text(pane), /Source-available · free for personal use\./);
    assert.doesNotMatch(text(pane), /open source|Apache/i);
    const links = all(pane).filter((n) => n.tagName === "A");
    assert.deepEqual(links.map((l) => l.textContent.replace("↗", "")), [
      "Read the documentation",
      "Report a problem",
      "View licence",
      "Licence and costs",
    ]);
    for (const link of links) {
      assert.match(link.href, /^https:\/\/github\.com\/sanjaygbhat\/bothearth/);
      assert.equal(link.rel, "noopener noreferrer");
      assert.equal(link.target, "_blank");
    }
  } finally {
    view.unmount();
    dom.restore();
  }
});
