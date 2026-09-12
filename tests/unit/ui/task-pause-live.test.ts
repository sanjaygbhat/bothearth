/**
 * A pause has to reach the page that is open on it.
 *
 * Final verification watched a task hit its $0.05 budget 34 seconds in. The
 * daemon had it `paused` from that second onward, and the open page said
 * "Working" with a frozen meter and no Resume button for nine minutes, until
 * someone reloaded it. The daemon announces a budget, step or runtime stop on
 * `task.step {status:"paused"}`, and the view treated every `task.step` as a
 * running heartbeat.
 *
 * The clock is the other half: a paused run has no finish time on its record,
 * so its receipt has to stop at the pause and not run on to whatever was
 * stamped last.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clockTime, TaskView } from "../../../src/ui/task.ts";
import { installDom, type FakeElement } from "./fake-dom.ts";

type Json = Record<string, unknown>;

const START = "2026-09-08T09:52:00.000Z";
const at = (seconds: number) => new Date(Date.parse(START) + seconds * 1000).toISOString();
const PAUSED_AT = at(34);

const SESSION = { ok: true, csrf: "c", spend_cap_usd: 0.05, execution_mode: "standalone" };

const PAUSE_BODY = {
  status: "paused",
  reason: "spend_cap",
  failure_kind: "spend_cap",
  detail: "it reached the $0.05 budget set for this task",
  steps: 5,
};

/** The run as the daemon has it while it is working: five tool calls, no pause. */
function running(): Json {
  return {
    task: {
      id: "t_1",
      computer_id: "cmp_1",
      goal: "Check my Gmail filters",
      status: "running",
      created_at: START,
      started_at: START,
      spend_usd: 0.05,
      spend_cap_usd: 0.05,
      calls: 5,
      calls_cap: 5,
    },
    steps: [
      { kind: "tool.call", body: { name: "browser_navigate" }, created_at: at(4) },
      { kind: "tool.call", body: { name: "browser_click" }, created_at: at(30) },
    ],
  };
}

/**
 * The same run a moment later. `emit` broadcasts to the sockets before it
 * appends to the audit log, so the refetch the event triggers can arrive
 * before the pause has a durable step — the shape this fixture holds.
 */
function pausedNoStepYet(over: Json = {}): Json {
  const base = running();
  return {
    ...base,
    task: { ...(base.task as Json), status: "paused", ...over },
  };
}

/** And after a reload, once the pause is durable. */
function pausedDurable(over: Json = {}): Json {
  const base = pausedNoStepYet(over);
  return {
    ...base,
    steps: [...(base.steps as Json[]), { kind: "task.step", body: PAUSE_BODY, created_at: PAUSED_AT }],
  };
}

async function mount(routes: Record<string, Json>) {
  const dom = installDom({ hash: "#/tasks/t_1" });
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (path: string) => {
    const url = String(path).split("?")[0]!;
    calls.push(url);
    const body = routes[url];
    return body ? Response.json(body) : new Response("{}", { status: 404 });
  }) as typeof fetch;
  const view = new TaskView();
  const root = document.createElement("div") as unknown as FakeElement;
  await view.mount(root as unknown as HTMLElement, "t_1");
  await new Promise(setImmediate);
  return {
    view,
    root,
    calls,
    async settle() {
      for (let i = 0; i < 4; i += 1) await new Promise(setImmediate);
    },
    stop() {
      view.unmount();
      globalThis.fetch = original;
      dom.restore();
    },
  };
}

function receiptRow(root: FakeElement, term: string): string | null {
  for (const row of root.querySelectorAll(".receipt div")) {
    if (row.querySelector("dt")?.textContent === term) {
      return row.querySelector("dd")?.textContent ?? null;
    }
  }
  return null;
}

function pauseEvent(): Json {
  return { type: "task.step", ts: PAUSED_AT, task_id: "t_1", computer_id: "cmp_1", body: PAUSE_BODY };
}

describe("a pause on the open page", () => {
  it("switches to the paused receipt on the pause event, without a reload", async () => {
    const routes: Record<string, Json> = {
      "/api/v1/session": SESSION,
      "/api/v1/tasks/t_1": running(),
      "/api/v1/approvals": { approvals: [] },
      "/api/v1/takeovers": { takeovers: [] },
    };
    const page = await mount(routes);
    try {
      assert.equal(page.root.querySelector(".done-scroll"), null, "the receipt was up before the pause");

      routes["/api/v1/tasks/t_1"] = pausedNoStepYet();
      page.view.onEvent(pauseEvent() as never);
      await page.settle();

      const scroll = page.root.querySelector(".done-scroll");
      assert.ok(scroll, "the page was still Working after the pause event");
      assert.equal(scroll.dataset.outcome, "paused");
      assert.equal(page.root.querySelector(".t-title")?.textContent, "It’s waiting for you");
      // The reason rides on the event body, so the receipt says why even
      // before the daemon has finished writing the pause to its log.
      assert.equal(
        page.root.querySelector(".done-lede")?.textContent,
        "It reached its $0.05 budget after 5 tool calls.",
      );
      const buttons = page.root.querySelectorAll("button").map((node) => node.textContent);
      assert.ok(
        buttons.includes("Resume with a higher budget"),
        `no way to carry the task on: ${buttons.join(", ")}`,
      );
    } finally {
      page.stop();
    }
  });

  it("stops the clock at the pause, not at whatever was stamped last", async () => {
    const routes: Record<string, Json> = {
      "/api/v1/session": SESSION,
      "/api/v1/tasks/t_1": running(),
      "/api/v1/approvals": { approvals: [] },
      "/api/v1/takeovers": { takeovers: [] },
    };
    const page = await mount(routes);
    try {
      routes["/api/v1/tasks/t_1"] = pausedNoStepYet();
      page.view.onEvent(pauseEvent() as never);
      await page.settle();
      assert.equal(
        receiptRow(page.root, "Time before it stopped"),
        "34 s",
        "the clock ran to the last tool call instead of to the pause",
      );
      assert.equal(
        page.root.querySelector(".task-bar .spend")?.textContent,
        `Paused ${clockTime(PAUSED_AT)}`,
      );
    } finally {
      page.stop();
    }
  });

  it("still reads 34 s nine minutes later, on a record whose clock has moved on", async () => {
    // The reload that used to be the only way to see the pause: it happened at
    // 10:01:10, and the receipt read "9 min 10 s" for 34 seconds of work.
    const page = await mount({
      "/api/v1/session": SESSION,
      "/api/v1/tasks/t_1": pausedDurable({ updated_at: at(550) }),
      "/api/v1/approvals": { approvals: [] },
      "/api/v1/takeovers": { takeovers: [] },
    });
    try {
      assert.equal(receiptRow(page.root, "Time before it stopped"), "34 s");
    } finally {
      page.stop();
    }
  });

  it("does not refetch the record on a plain running heartbeat", async () => {
    const page = await mount({
      "/api/v1/session": SESSION,
      "/api/v1/tasks/t_1": running(),
      "/api/v1/approvals": { approvals: [] },
      "/api/v1/takeovers": { takeovers: [] },
    });
    try {
      const before = page.calls.filter((url) => url === "/api/v1/tasks/t_1").length;
      page.view.onEvent({
        type: "task.step",
        ts: at(20),
        task_id: "t_1",
        computer_id: "cmp_1",
        body: { status: "running" },
      } as never);
      await page.settle();
      assert.equal(
        page.calls.filter((url) => url === "/api/v1/tasks/t_1").length,
        before,
        "a heartbeat cost the daemon a fetch",
      );
      assert.equal(page.root.querySelector(".done-scroll"), null);
    } finally {
      page.stop();
    }
  });
});
