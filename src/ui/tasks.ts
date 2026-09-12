/**
 * The task list (`#/tasks`), where home’s "All 23 tasks" link goes.
 *
 * This module also owns two small routes that have nowhere better to live:
 *
 *   `#/live/:computerId?`  the control-surface link the daemon hands the model
 *                          (src/daemon/server.ts `uiControlUrl`). It resolves
 *                          the computer’s live task and forwards to it, so an
 *                          old link opens the real task screen instead of a
 *                          bare canvas.
 *   `*`                    anything else: go home rather than sit on a blank
 *                          frame. Registered last, matched last.
 */

import { apiGet } from "./api.ts";
import { EMPTY_RECENT, recentStatus, relativeTime, taskTitle } from "./home.ts";
import { element } from "./safe.ts";
import { navigate, registerView, setTitle, type RouteParams } from "./shell.ts";
import type { TaskRow } from "./task-view.ts";

const TASKS_NO_MATCH = "No task matches that. Try a shorter word.";

/** Match on the goal only. Status words are not what anyone types into a search. */
export function filterTasks(tasks: TaskRow[], query: string): TaskRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return tasks;
  return tasks.filter((task) => (task.goal ?? "").toLowerCase().includes(needle));
}

export function sortTasks(tasks: TaskRow[]): TaskRow[] {
  return [...tasks].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

/** One row, identical in shape to home’s Recent row so the two read as one list. */
function taskRow(task: TaskRow): HTMLLIElement {
  const { word, tone } = recentStatus(task.status);
  const when = relativeTime(task.started_at ?? task.created_at);
  const ms = task.duration_ms;
  const seconds = typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : 0;
  const lasted = seconds < 1 ? "" : seconds < 60 ? `${seconds} s`
    : seconds < 3600 ? `${Math.round(seconds / 60)} min`
    : `${Math.round((seconds / 3600) * 10) / 10} hr`;
  const metaText = [word, when, lasted].filter(Boolean).join(" · ");

  const item = document.createElement("li");
  const link = element("a", "recent-row");
  link.setAttribute("href", `#/tasks/${task.id}`);
  const title = element("span", "recent-title", taskTitle(task.goal));
  const meta = element("span", "recent-meta");
  meta.append(
    element("span", tone === "neutral" ? "dot" : `dot ${tone}`),
    document.createTextNode(metaText),
  );
  link.append(title, meta);
  item.appendChild(link);
  return item;
}

class TasksView {
  private root: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private note: HTMLElement | null = null;
  private search: HTMLInputElement | null = null;
  private searchField: HTMLElement | null = null;
  private tasks: TaskRow[] | null = null;
  private revision = 0;

  mount(el: HTMLElement): void {
    this.root = el;
    // The page says "Tasks" in its own h1, so the titlebar keeps the brand
    // lockup rather than saying it a second time.
    setTitle(null);

    const page = element("div", "tasks");
    const head = element("header", "tasks-head");
    const heading = element("h1", "tasks-title", "Tasks");

    const field = element("div", "tasks-search");
    field.hidden = true;
    const label = element("label", "sr-only", "Search tasks");
    label.setAttribute("for", "tasks-search-input");
    const input = document.createElement("input");
    input.id = "tasks-search-input";
    input.type = "search";
    input.className = "tasks-search-input";
    input.placeholder = "Search";
    input.autocomplete = "off";
    input.addEventListener("input", () => this.paint());
    this.search = input;
    this.searchField = field;
    field.append(label, input);
    head.append(heading, field);

    const note = element("p", "recent-empty");
    note.hidden = true;
    note.setAttribute("role", "status");
    this.note = note;

    const list = element("ul", "recent-list tasks-list");
    this.list = list;

    page.append(head, note, list);
    el.appendChild(page);

    this.renderSkeleton();
    void this.load();
  }

  unmount(): void {
    this.revision += 1;
    this.root = null;
    this.list = null;
    this.note = null;
    this.search = null;
    this.searchField = null;
    setTitle(null);
  }

  private renderSkeleton(): void {
    const rows = element("div", "recent-skeleton");
    rows.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 5; i += 1) rows.appendChild(element("div", "recent-skeleton-row"));
    this.list?.replaceChildren(rows);
  }

  private async load(): Promise<void> {
    const revision = ++this.revision;
    try {
      const data = (await apiGet("/api/v1/tasks")) as { tasks: TaskRow[] };
      if (revision !== this.revision || !this.root) return;
      this.tasks = sortTasks(data.tasks ?? []);
      this.paint();
    } catch {
      if (revision !== this.revision || !this.root) return;
      this.tasks = [];
      this.showNote("Your tasks couldn’t be loaded just now. Check that BotHearth is running, then try again.");
      this.list?.replaceChildren();
    }
  }

  private showNote(text: string): void {
    if (!this.note) return;
    this.note.textContent = text;
    this.note.hidden = false;
  }

  private paint(): void {
    const tasks = this.tasks;
    if (!tasks || !this.list) return;
    const query = this.search?.value ?? "";
    const shown = filterTasks(tasks, query);
    if (this.searchField) this.searchField.hidden = tasks.length < 2;

    if (this.note) {
      const message = !tasks.length ? EMPTY_RECENT : shown.length ? "" : TASKS_NO_MATCH;
      this.note.textContent = message;
      this.note.hidden = message === "";
    }

    this.list.replaceChildren();
    for (const task of shown) this.list.appendChild(taskRow(task));
  }
}

/** Exported so the tests can drive one instance directly. */
export function createTasksView() {
  let view: TasksView | null = null;
  return {
    mount(el: HTMLElement) {
      view = new TasksView();
      view.mount(el);
    },
    unmount() {
      view?.unmount();
      view = null;
    },
  };
}

/**
 * `#/live/<computer id>` is the control link the daemon gives the model when it
 * asks for a human. Resolve it to the task that computer is actually running,
 * and forward there. With no live task the list is the honest answer — there is
 * nothing to take control of.
 */
async function resolveLiveTarget(computerId: string | undefined): Promise<string> {
  if (!computerId) return "#/tasks";
  try {
    const data = (await apiGet("/api/v1/tasks")) as { tasks: TaskRow[] };
    const forComputer = sortTasks(data.tasks ?? []).filter((t) => t.computer_id === computerId);
    const live = forComputer.find(
      (t) => !["completed", "failed", "cancelled"].includes(t.status),
    );
    const target = live ?? forComputer[0];
    return target ? `#/tasks/${target.id}` : "#/tasks";
  } catch {
    return "#/tasks";
  }
}

registerView("#/tasks", createTasksView());

registerView("#/live/:computerId?", {
  mount(el: HTMLElement, params: RouteParams) {
    setTitle("Opening", { back: "#/", backLabel: "Home" });
    el.appendChild(element("div", "tasks"));
    void resolveLiveTarget(params.computerId).then((hash) => {
      navigate(hash, { replace: true });
    });
  },
  unmount() {
    setTitle(null);
  },
});

// A hash nobody claims is a dead end, and a dead end should not be a blank
// frame. Deferred by one microtask so the router finishes this mount before it
// is asked to run the next one.
registerView("*", {
  mount() {
    queueMicrotask(() => navigate("#/", { replace: true }));
  },
});
