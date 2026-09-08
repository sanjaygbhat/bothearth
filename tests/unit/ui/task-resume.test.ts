/**
 * A paused task is recoverable: it says why it stopped, and the primary action
 * carries it on rather than starting a new run.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TaskView, terminalCopy, terminalKind } from "../../../src/ui/task.ts";
import { installDom, type FakeElement } from "./fake-dom.ts";

const AT = "2026-09-07T10:02:00.000Z";

type Json = Record<string, unknown>;

function paused(status: string): Json {
  return {
    "/api/v1/session": { ok: true, csrf: "c", spend_cap_usd: 2, execution_mode: "standalone" },
    "/api/v1/tasks/t_1": {
      task: { id: "t_1", computer_id: "cmp_1", goal: "Book the flight", status, created_at: AT },
      steps: [
        { kind: "task.started", body: {}, created_at: AT },
        { kind: "task.step", body: { status: "paused", reason: "approval" }, created_at: AT },
      ],
    },
    "/api/v1/approvals": { approvals: [] },
    "/api/v1/takeovers": { takeovers: [] },
  };
}

describe("a paused task offers to carry on", () => {
  it("has its own receipt, not the one for a run that failed", () => {
    assert.equal(terminalKind("paused"), "paused");
    const copy = terminalCopy({ status: "paused", reason: "approval", budget: null, took: null });
    assert.equal(copy.barVerb, "Paused");
    assert.equal(copy.againLabel, "Run again");
    assert.match(copy.lede, /asked you a question/);
    assert.doesNotMatch(copy.heading, /couldn’t finish/i);
  });

  it("resumes the same task through the daemon, then goes back to the live view", async () => {
    const dom = installDom({ hash: "#/tasks/t_1" });
    const original = globalThis.fetch;
    const calls: Array<{ method: string; path: string }> = [];
    let status = "paused";
    globalThis.fetch = (async (path: string, init?: RequestInit) => {
      const key = String(path).split("?")[0]!;
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, path: key });
      if (key === "/api/v1/tasks/t_1/resume") {
        status = "running";
        return Response.json({ ok: true, status: "running" }, { status: 202 });
      }
      const body = (paused(status) as Record<string, Json>)[key];
      return body ? Response.json(body) : new Response("{}", { status: 404 });
    }) as typeof fetch;

    const view = new TaskView();
    const root = document.createElement("div") as unknown as FakeElement;
    try {
      await view.mount(root as unknown as HTMLElement, "t_1");

      assert.match(
        root.querySelector(".task-bar .spend")!.textContent,
        /^Paused /,
        "the bar says it paused, never that it finished",
      );

      const receipt = root.querySelector(".done-scroll");
      assert.ok(receipt, "a paused task draws a receipt");
      assert.match(receipt.textContent, /asked you a question/, "the pause reason is on screen");

      const buttons = root
        .querySelectorAll(".done-acts button")
        .map((node) => ({ text: node.textContent, className: node.className, node }));
      const resume = buttons.find((button) => button.text === "Resume");
      assert.ok(resume, "a paused task offers Resume");
      assert.match(resume.className, /primary/, "Resume is the primary action");
      const again = buttons.find((button) => button.text === "Run again");
      assert.ok(again, "Run again is still offered");
      assert.doesNotMatch(again.className, /primary/, "starting over is not the primary action");

      resume.node.click();
      await new Promise(setImmediate);
      await new Promise(setImmediate);

      assert.deepEqual(
        calls.filter((call) => call.path.endsWith("/resume")),
        [{ method: "POST", path: "/api/v1/tasks/t_1/resume" }],
      );
      assert.equal(root.querySelector(".done-scroll"), null, "the receipt is gone");
      assert.ok(root.querySelector(".feed"), "the live view is back");
    } finally {
      view.unmount();
      globalThis.fetch = original;
      dom.restore();
    }
  });
});
