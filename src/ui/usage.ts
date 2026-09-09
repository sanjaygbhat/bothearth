import { apiGet, humanApiError } from "./api.ts";
import { appendTextChild } from "./safe.ts";
import type { TaskRow } from "./task-view.ts";

/**
 * Settings → Usage (ux-spec §2.7). What each run cost, per task and per day,
 * read from the events the daemon already records (`GET /api/v1/audit`, rows of
 * type `usage`) joined to the task list for the goal text.
 */

export type SpendRow = {
  id: string;
  label: string;
  usd: number;
  steps: number;
  when: string;
};

type AuditRecord = { type: string; ts: string; task_id: string | null; body_json: string };

/** `$0.42`, and `less than $0.01` rather than a misleading `$0.00`. */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.005) return "less than $0.01";
  return `$${usd.toFixed(2)}`;
}

/** `Today` / `Yesterday` / `Tue 2 Sep` — never a raw ISO date. */
export function dayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown day";
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/**
 * Usage events carry the running total for their task, so the newest one wins.
 * Returns newest-first, which is also the order the list is drawn in.
 */
export function spendByTask(records: readonly AuditRecord[], tasks: readonly TaskRow[]): SpendRow[] {
  const goals = new Map(tasks.map((task) => [task.id, task]));
  const latest = new Map<string, SpendRow>();
  for (const record of records) {
    if (record.type !== "usage" || !record.task_id) continue;
    let body: { usd_est?: number; steps?: number };
    try {
      body = JSON.parse(record.body_json) as { usd_est?: number; steps?: number };
    } catch {
      continue;
    }
    const previous = latest.get(record.task_id);
    if (previous && Date.parse(previous.when) >= Date.parse(record.ts)) continue;
    latest.set(record.task_id, {
      id: record.task_id,
      label: goals.get(record.task_id)?.goal ?? "A task you started",
      usd: typeof body.usd_est === "number" && Number.isFinite(body.usd_est) ? body.usd_est : 0,
      steps: typeof body.steps === "number" && Number.isFinite(body.steps) ? body.steps : 0,
      when: goals.get(record.task_id)?.created_at ?? record.ts,
    });
  }
  return [...latest.values()].sort((a, b) => Date.parse(b.when) - Date.parse(a.when));
}

/** Roll the per-task rows up into one row per calendar day, newest day first. */
export function spendByDay(rows: readonly SpendRow[], now = new Date()): SpendRow[] {
  const days = new Map<string, SpendRow>();
  for (const row of rows) {
    const date = new Date(row.when);
    const key = Number.isNaN(date.getTime())
      ? "unknown"
      : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const existing = days.get(key);
    if (existing) {
      existing.usd += row.usd;
      existing.steps += row.steps;
      continue;
    }
    days.set(key, {
      id: key,
      label: dayLabel(row.when, now),
      usd: row.usd,
      steps: row.steps,
      when: row.when,
    });
  }
  return [...days.values()].sort((a, b) => Date.parse(b.when) - Date.parse(a.when));
}

/** Render the Usage section into `pane`. Returns a disposer. */
export function renderUsage(pane: HTMLElement): () => void {
  let disposed = false;
  const live = () => !disposed && pane.isConnected;

  appendTextChild(pane, "h3", "Usage");
  appendTextChild(
    pane,
    "p",
    "An estimate of task work on this machine. Native model connections count computer-tool calls; API estimates use configured prices. These totals are estimates, not your provider bill.",
    "set-lede",
  );

  const body = document.createElement("div");
  pane.append(body);

  const draw = (title: string, rows: readonly SpendRow[], withSteps: boolean) => {
    appendTextChild(body, "p", title, "caps");
    const bars = document.createElement("div");
    bars.className = "set-bars";
    const peak = rows.reduce((max, row) => Math.max(max, row.usd), 0);
    for (const row of rows) {
      const bar = document.createElement("div");
      bar.className = "set-bar";
      const head = document.createElement("div");
      head.className = "set-bar-head";
      appendTextChild(head, "span", row.label);
      appendTextChild(head, "span", formatUsd(row.usd), "set-amount");
      bar.append(head);
      appendTextChild(
        bar,
        "div",
        withSteps
          ? `${dayLabel(row.when)} · ${row.steps} step${row.steps === 1 ? "" : "s"}`
          : `${row.steps} step${row.steps === 1 ? "" : "s"}`,
        "set-sub",
      );
      const meter = document.createElement("div");
      meter.className = "meter";
      const fill = document.createElement("i");
      const share = peak > 0 ? Math.max(0.02, row.usd / peak) : 0;
      fill.style.transform = `scaleX(${share.toFixed(3)})`;
      meter.append(fill);
      meter.setAttribute("role", "img");
      meter.setAttribute("aria-label", `${formatUsd(row.usd)} of ${formatUsd(peak)}, the most any one cost`);
      bar.append(meter);
      bars.append(bar);
    }
    body.append(bars);
  };

  void (async () => {
    try {
      const [audit, tasks] = await Promise.all([
        apiGet("/api/v1/audit?limit=500") as Promise<{ records?: AuditRecord[] }>,
        apiGet("/api/v1/tasks") as Promise<{ tasks?: TaskRow[] }>,
      ]);
      if (!live()) return;
      const perTask = spendByTask(audit.records ?? [], tasks.tasks ?? []);
      body.replaceChildren();
      if (perTask.length === 0) {
        appendTextChild(
          body,
          "p",
          "Nothing to show yet. Once your bot has run a task, what it cost appears here.",
          "set-note",
        );
        return;
      }
      const total = perTask.reduce((sum, row) => sum + row.usd, 0);
      const totalRow = document.createElement("div");
      totalRow.className = "set-total";
      appendTextChild(totalRow, "b", formatUsd(total));
      appendTextChild(
        totalRow,
        "span",
        `across ${perTask.length} task${perTask.length === 1 ? "" : "s"}`,
        "set-note",
      );
      body.append(totalRow);
      draw("By day", spendByDay(perTask), false);
      draw("By task", perTask.slice(0, 12), true);
    } catch (error) {
      if (!live()) return;
      body.replaceChildren();
      const failure = appendTextChild(
        body,
        "p",
        humanApiError(
          error,
          "Usage could not be read just now. Check that ModelBot is running, then open this section again.",
        ),
        "set-msg",
      );
      failure.dataset.tone = "danger";
    }
  })();

  return () => {
    disposed = true;
  };
}
