/**
 * A task pauses when it asks for a person to take over. Resume cannot answer
 * that ask — only the keyboard can — so this pause keeps the live view and the
 * Take-control card instead of the terminal receipt.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TaskView } from "../../../src/ui/task.ts";
import { installDom, type FakeElement } from "./fake-dom.ts";

const AT = "2026-09-07T10:02:00.000Z";

type Json = Record<string, unknown>;

function detail(reason: string): Json {
  return {
    task: { id: "t_1", computer_id: "cmp_1", goal: "Sign in to the airline", status: "paused", created_at: AT },
    steps: [
      { kind: "task.started", body: {}, created_at: AT },
      { kind: "task.step", body: { status: "paused", reason }, created_at: AT },
    ],
  };
}

async function mount(routes: Record<string, Json>) {
  const dom = installDom({ hash: "#/tasks/t_1" });
  const original = globalThis.fetch;
  globalThis.fetch = (async (path: string) => {
    const body = routes[String(path).split("?")[0]!];
    return body ? Response.json(body) : new Response("{}", { status: 404 });
  }) as typeof fetch;
  const view = new TaskView();
  const root = document.createElement("div") as unknown as FakeElement;
  await view.mount(root as unknown as HTMLElement, "t_1");
  await new Promise(setImmediate);
  return {
    root,
    stop() {
      view.unmount();
      globalThis.fetch = original;
      dom.restore();
    },
  };
}

const SESSION = { ok: true, csrf: "c", spend_cap_usd: 2, execution_mode: "standalone" };

describe("a task paused for a takeover", () => {
  it("keeps the live view and offers Take control, not Resume", async () => {
    const view = await mount({
      "/api/v1/session": SESSION,
      "/api/v1/tasks/t_1": detail("takeover"),
      "/api/v1/approvals": { approvals: [] },
      "/api/v1/takeovers": { takeovers: [
        { id: "tk_1", computer_id: "cmp_1", task_id: "t_1", state: "takeover_requested" },
      ] },
    });
    try {
      assert.equal(view.root.querySelector(".done-scroll"), null, "the receipt took over the screen");
      const buttons = view.root.querySelectorAll("button").map((node) => node.textContent);
      assert.ok(!buttons.includes("Resume"), `Resume was offered for a takeover pause: ${buttons.join(", ")}`);
      assert.ok(view.root.querySelector(".takeover-ask"), "the Take-control card is missing");
      assert.ok(
        buttons.some((text) => text.startsWith("Take control")),
        `no Take-control button: ${buttons.join(", ")}`,
      );
      assert.ok(view.root.querySelector(".feed"), "the live view is gone");
      assert.equal(view.root.querySelector(".task-bar .spend")!.textContent, "",
        "the bar reported the run as settled while a person still has to answer");
    } finally {
      view.stop();
    }
  });

  it("still shows the receipt with Resume when the takeover ask itself timed out", async () => {
    const view = await mount({
      "/api/v1/session": SESSION,
      "/api/v1/tasks/t_1": detail("takeover"),
      "/api/v1/approvals": { approvals: [] },
      // `paused` is the durable takeover row of an ask nobody answered.
      "/api/v1/takeovers": { takeovers: [
        { id: "tk_1", computer_id: "cmp_1", task_id: "t_1", state: "paused" },
      ] },
    });
    try {
      assert.ok(view.root.querySelector(".done-scroll"), "a timed-out ask has no receipt");
      const buttons = view.root.querySelectorAll(".done-acts button").map((node) => node.textContent);
      assert.ok(buttons.includes("Resume"), `Resume is missing: ${buttons.join(", ")}`);
    } finally {
      view.stop();
    }
  });

  it("shows the receipt with Resume for a pause Resume can fix", async () => {
    const view = await mount({
      "/api/v1/session": SESSION,
      // An approval that timed out: no cap to raise, so a plain Resume is the
      // offer. A `spend_cap` or `max_steps` pause is refused a bare resume and
      // gets "Resume with a higher budget" / "Resume with more steps" instead.
      "/api/v1/tasks/t_1": detail("approval"),
      "/api/v1/approvals": { approvals: [] },
      "/api/v1/takeovers": { takeovers: [] },
    });
    try {
      assert.ok(view.root.querySelector(".done-scroll"), "a timed-out approval pause lost its receipt");
      const buttons = view.root.querySelectorAll(".done-acts button").map((node) => node.textContent);
      assert.ok(buttons.includes("Resume"), `Resume is missing: ${buttons.join(", ")}`);
    } finally {
      view.stop();
    }
  });
});
