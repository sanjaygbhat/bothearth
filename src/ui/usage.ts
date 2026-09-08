import { ApiError, apiGet, humanApiError } from "./api.ts";
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

/**
 * The per-task budget. The daemon has no settings endpoint, so the figure is
 * kept on this Mac and sent with every task this window starts. The copy on
 * screen says exactly that and claims nothing more.
 */

const BUDGET_KEY = "modelbot.task-budget";

/** The figure this Mac prefers, or null when none has been set. */
export function readBudgetPreference(): number | null {
  try {
    const raw = localStorage.getItem(BUDGET_KEY);
    if (!raw) return null;
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeBudgetPreference(usd: number | null): void {
  try {
    if (usd === null) localStorage.removeItem(BUDGET_KEY);
    else localStorage.setItem(BUDGET_KEY, String(usd));
  } catch {
    // Storage off: the figure applies to this window and is not remembered.
  }
}

/** What the box accepts: a positive amount, at most four figures, 2dp. */
export function parseBudget(raw: string): number | null {
  const value = Number.parseFloat(raw.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(value) || value <= 0 || value > 1000) return null;
  return Math.round(value * 100) / 100;
}

/**
 * The box's answer: the amount to keep, or the sentence to put under it.
 *
 * A figure above what the daemon accepts is refused here, naming that figure.
 * Storing it and letting the server clamp it silently is how the field came to
 * read $10.00 while every task it started ran on $2.00.
 */
export function budgetEntry(raw: string, max: number | null): { usd: number } | { error: string } {
  const usd = parseBudget(raw);
  if (usd === null) return { error: "Put in an amount between $0.01 and $1000.00." };
  if (max !== null && Number.isFinite(max) && usd > max) {
    return { error: `One task can have at most ${formatUsd(max)}. Put in that or less.` };
  }
  return { usd };
}

/** The line under the box: what a task gets by default, and the ceiling. */
export function budgetNoteText(defaultUsd: number | null, max: number | null): string {
  const first =
    defaultUsd === null
      ? "A task stops when it reaches this."
      : `A task gets ${formatUsd(defaultUsd)} unless you change it, and stops when it reaches it.`;
  const most = max === null ? "" : ` The most one task can have is ${formatUsd(max)}.`;
  return `${first}${most} Kept on this Mac and sent with every task you start here.`;
}

/**
 * The daemon refusing a task's budget (`E_LIMIT` on `POST /api/v1/tasks`). Its
 * own message names a wire field, so it is replaced with the sentence that says
 * where the figure came from and where to change it.
 */
export function budgetRejected(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body as { error?: unknown; message?: unknown } | null;
  if (body?.error !== "E_LIMIT") return null;
  const message = typeof body.message === "string" ? body.message : "";
  if (!message.includes("spend_cap_usd")) return null;
  const cap = /cap of ([\d.]+)/.exec(message)?.[1];
  const most = cap ? `One task can have at most ${formatUsd(Number(cap))}. ` : "";
  return `${most}Change the budget in Settings → Usage, then start it again.`;
}

/** Render the Usage section into `pane`. Returns a disposer. */
export function renderUsage(pane: HTMLElement): () => void {
  let disposed = false;
  const live = () => !disposed && pane.isConnected;

  appendTextChild(pane, "h3", "Usage");
  appendTextChild(
    pane,
    "p",
    "An estimate of task work on this machine. Native model connections count computer-tool calls; API estimates use configured prices. This meter does not measure or cap your provider bill.",
    "set-lede",
  );

  const body = document.createElement("div");
  pane.append(body);

  // The budget, as a control rather than a sentence.
  const budgetRow = document.createElement("div");
  budgetRow.className = "set-row";
  const budgetText = document.createElement("div");
  budgetText.className = "set-grow";
  const budgetField = document.createElement("label");
  budgetField.className = "set-field";
  budgetField.textContent = "Budget for one task";
  const budgetInput = document.createElement("input");
  budgetInput.type = "text";
  budgetInput.setAttribute("inputmode", "decimal");
  budgetInput.setAttribute("autocomplete", "off");
  budgetInput.setAttribute("aria-describedby", "usage-budget-note");
  budgetField.append(budgetInput);
  budgetText.append(budgetField);
  const budgetNote = appendTextChild(budgetText, "span", budgetNoteText(null, null), "set-w");
  budgetNote.id = "usage-budget-note";
  const budgetActions = document.createElement("div");
  budgetActions.className = "set-actions";
  const budgetSave = document.createElement("button");
  budgetSave.type = "button";
  budgetSave.className = "btn sm";
  budgetSave.textContent = "Save";
  budgetSave.hidden = true;
  budgetActions.append(budgetSave);
  budgetRow.append(budgetText, budgetActions);
  pane.append(budgetRow);

  const budget = document.createElement("p");
  budget.className = "set-msg";
  budget.setAttribute("role", "status");
  pane.append(budget);

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

  // The control is drawn AND wired before anything is fetched: the figure lives
  // on this Mac, so a session read that is slow or fails must not leave a box
  // whose Save button does nothing. The fetch only fills in the daemon's own
  // default and ceiling.
  let maxUsd: number | null = null;
  let saved = readBudgetPreference();
  // The stored figure is what this Mac sends, so it is what the box shows —
  // never the daemon's clamped answer, which would hide the fact that the two
  // disagree.
  let original = saved === null ? "" : saved.toFixed(2);
  budgetInput.value = original;
  budgetInput.placeholder = "2.00";
  budgetInput.addEventListener("input", () => {
    budgetSave.hidden = budgetInput.value.trim() === original;
    budget.textContent = "";
  });
  budgetSave.addEventListener("click", () => {
    const entry = budgetEntry(budgetInput.value, maxUsd);
    if ("error" in entry) {
      budget.dataset.tone = "danger";
      budget.textContent = entry.error;
      budgetInput.focus();
      return;
    }
    writeBudgetPreference(entry.usd);
    saved = entry.usd;
    original = entry.usd.toFixed(2);
    budgetInput.value = original;
    budgetSave.hidden = true;
    budget.dataset.tone = "ok";
    budget.textContent = `Saved. Tasks you start from this Mac stop at ${formatUsd(entry.usd)}.`;
  });

  void (async () => {
    try {
      const [session, audit, tasks] = await Promise.all([
        apiGet("/api/v1/session") as Promise<{
          spend_cap_usd?: number | null;
          budget?: { default_usd?: number | null; max_usd?: number | null } | null;
        }>,
        apiGet("/api/v1/audit?limit=500") as Promise<{ records?: AuditRecord[] }>,
        apiGet("/api/v1/tasks") as Promise<{ tasks?: TaskRow[] }>,
      ]);
      if (!live()) return;
      const number = (value: unknown): number | null =>
        typeof value === "number" && Number.isFinite(value) ? value : null;
      const defaultUsd = number(session.budget?.default_usd) ?? number(session.spend_cap_usd);
      maxUsd = number(session.budget?.max_usd);
      if (defaultUsd !== null) {
        budgetInput.placeholder = defaultUsd.toFixed(2);
        // Nothing chosen on this Mac: the box states what a task actually gets.
        // A figure typed while the fetch was in flight is left alone.
        if (saved === null && budgetInput.value === original) {
          original = defaultUsd.toFixed(2);
          budgetInput.value = original;
        }
      }
      budgetNote.textContent = budgetNoteText(defaultUsd, maxUsd);

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
