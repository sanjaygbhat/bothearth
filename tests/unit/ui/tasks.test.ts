/**
 * The task list, the control-link redirect, and the overlay slot.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EMPTY_RECENT } from "../../../src/ui/home.ts";
import { createTasksView, filterTasks, sortTasks } from "../../../src/ui/tasks.ts";
import { matchRoute } from "../../../src/ui/shell.ts";
import type { TaskRow } from "../../../src/ui/task-view.ts";
import { installDom, settle } from "./fake-dom.ts";

function task(over: Partial<TaskRow>): TaskRow {
  return {
    id: "t_1",
    computer_id: "c_1",
    goal: "Find last month's invoice",
    status: "completed",
    created_at: "2026-09-01T10:00:00.000Z",
    max_steps: 20,
    ...over,
  };
}

describe("task list", () => {
  it("shows the newest task first", () => {
    const older = task({ id: "old", created_at: "2026-09-01T10:00:00.000Z" });
    const newer = task({ id: "new", created_at: "2026-09-05T10:00:00.000Z" });
    assert.deepEqual(
      sortTasks([older, newer]).map((t) => t.id),
      ["new", "old"],
    );
    const input = [older, newer];
    sortTasks(input);
    assert.deepEqual(input.map((t) => t.id), ["old", "new"], "sorting does not mutate");
  });

  it("searches the goal, case-insensitively, and never the status word", () => {
    const tasks = [
      task({ id: "a", goal: "Book a FLIGHT to Lisbon" }),
      task({ id: "b", goal: "Cancel the gym membership", status: "failed" }),
    ];
    assert.deepEqual(filterTasks(tasks, "flight").map((t) => t.id), ["a"]);
    assert.deepEqual(filterTasks(tasks, "  GYM ").map((t) => t.id), ["b"]);
    assert.deepEqual(filterTasks(tasks, "").map((t) => t.id), ["a", "b"]);
    assert.deepEqual(filterTasks(tasks, "   ").map((t) => t.id), ["a", "b"]);
    assert.deepEqual(
      filterTasks(tasks, "failed"),
      [],
      "typing a status word must not silently match a row whose goal never said it",
    );
  });

  it("keeps a task with no goal in the list rather than dropping it", () => {
    const tasks = [task({ id: "blank", goal: "" })];
    assert.deepEqual(filterTasks(tasks, "").map((t) => t.id), ["blank"]);
    assert.deepEqual(filterTasks(tasks, "invoice"), []);
  });
});

describe("the routes this module adds", () => {
  it("claims #/tasks without stealing #/tasks/:id", () => {
    assert.deepEqual(matchRoute("#/tasks", "#/tasks"), {});
    assert.equal(matchRoute("#/tasks", "#/tasks/t_1"), null);
    assert.deepEqual(matchRoute("#/tasks/:id", "#/tasks/t_1"), { id: "t_1" });
  });

  it("accepts every shape of the control link the daemon builds", () => {
    // src/daemon/server.ts: `${uiBaseUrl}/#/live/${selected?.id ?? ""}`.
    assert.deepEqual(matchRoute("#/live/:computerId?", "#/live/c_1"), { computerId: "c_1" });
    assert.deepEqual(matchRoute("#/live/:computerId?", "#/live/"), {});
    assert.deepEqual(matchRoute("#/live/:computerId?", "#/live"), {});
    assert.equal(matchRoute("#/live/:computerId?", "#/lives"), null);
  });
});

describe("task list view", () => {
  it("paints first-line titles, status, started and duration, newest first", async () => {
    const tasks = [
      task({
        id: "task_old",
        goal: "Older prompt",
        created_at: "2026-09-01T10:00:00.000Z",
        duration_ms: 90_000,
      }),
      task({
        id: "task_new",
        goal: "Book the morning flight\nLeave a note",
        status: "running",
        created_at: "2026-09-05T10:00:00.000Z",
        started_at: "2026-09-05T10:00:10.000Z",
      }),
    ];
    const dom = installDom({
      hash: "#/tasks",
      fetch: async (path) => {
        if (path === "/api/v1/tasks") return Response.json({ tasks });
        return Response.json({ error: "unexpected" }, { status: 404 });
      },
    });
    const view = createTasksView();
    try {
      view.mount(dom.root as unknown as HTMLElement);
      await settle(8);
      const rows = dom.findAll(".recent-row");
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.getAttribute("href"), "#/tasks/task_new");
      assert.equal(rows[0]!.querySelector(".recent-title")?.textContent, "Book the morning flight");
      assert.doesNotMatch(rows[0]!.textContent, /Leave a note/);
      assert.doesNotMatch(rows[0]!.textContent, /task_new/);
      assert.match(rows[0]!.textContent, /Working/);
      assert.equal(rows[1]!.getAttribute("href"), "#/tasks/task_old");
      assert.match(rows[1]!.textContent, /Done/);
      assert.match(rows[1]!.textContent, /2 min/);
    } finally {
      view.unmount();
      dom.restore();
    }
  });

  it("says so when there is nothing to open", async () => {
    const dom = installDom({
      hash: "#/tasks",
      fetch: async (path) => {
        if (path === "/api/v1/tasks") return Response.json({ tasks: [] });
        return Response.json({ error: "unexpected" }, { status: 404 });
      },
    });
    const view = createTasksView();
    try {
      view.mount(dom.root as unknown as HTMLElement);
      await settle(8);
      assert.equal(dom.find(".recent-empty")?.textContent, EMPTY_RECENT);
      assert.equal(dom.findAll(".recent-row").length, 0);
    } finally {
      view.unmount();
      dom.restore();
    }
  });
});
