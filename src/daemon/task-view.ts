import type { TaskBudget } from "../types/contracts.ts";
import { harnessSpendUsd, type Store, type TaskRow } from "./store.ts";

/**
 * What this task has spent and what it may spend, read from the same counter
 * that stops it. A harness task is priced by the daemon's per-tool-call proxy
 * rate, which is also what its cap is measured in; a standalone task is priced
 * by the provider's own estimate, and its calls are counted from the log.
 */
export function taskBudget(
  store: Store,
  task: TaskRow,
  defaultCapUsd: number,
): TaskBudget {
  const binding = store.harnessBindingForTask(task.id);
  const cap = binding?.spend_cap_usd ?? task.spend_cap_usd ?? defaultCapUsd;
  return {
    spend_usd: binding
      ? harnessSpendUsd(binding.observed_tool_calls, binding.proxy_usd_per_tool_call)
      : store.taskUsage(task.id)?.usd_est ?? null,
    spend_cap_usd: cap,
    calls: binding?.observed_tool_calls ?? store.countToolCalls(task.id),
    // A harness run pays the per-call rate for every tool call and spends one
    // step on the same call, so both of its budgets are counted in calls and
    // the ceiling is whichever runs out first.
    //
    // A standalone run is not: it is priced by the provider's own dollar
    // estimate, and `max_steps` counts model turns, of which one may make
    // several tool calls. Neither cap converts into tool calls, so there is no
    // honest number to show and the meter shows none.
    calls_cap: binding
      ? Math.min(Math.floor(cap / binding.proxy_usd_per_tool_call), binding.max_steps)
      : null,
  };
}

/** Operator task history excludes browser observations, tool arguments and raw audit bodies. */
export function taskActivity(store: Store, taskId: string) {
  const rows = store.db.prepare(`
    SELECT kind, body_json, created_at, result_id FROM (
      SELECT kind, body_json, created_at, NULL AS result_id FROM steps WHERE task_id = ? AND kind = 'assistant'
      UNION ALL
      SELECT type AS kind, body_json, ts AS created_at, seq AS result_id FROM audit_refs WHERE task_id = ?
        AND type IN ('task.completed','task.failed','task.cancelled','task.resumed','task.step','tool.call','tool.result',
          'tool.error','usage','policy.denied','approval.requested','takeover.requested')
    ) ORDER BY created_at DESC LIMIT 101
  `).all(taskId, taskId) as Array<{ kind: string; body_json: string; created_at: string; result_id: number | null }>;
  let textTruncated = false;
  const steps = rows.slice(0, 100).reverse().map((row) => {
    const source = JSON.parse(row.body_json) as Record<string, unknown>;
    const body: Record<string, unknown> = {};
    if (row.kind === "assistant") {
      const content = (typeof source.content === "string" ? source.content : Array.isArray(source.content)
        ? source.content.filter((p) => p?.type === "text").map((p) => p.text).join("\n") : "");
      body.content = content.slice(0, 8000);
      body.content_truncated = content.length > 8000;
      textTruncated ||= content.length > 8000;
      if (Array.isArray(source.tool_calls)) body.tools = source.tool_calls
        .map((call) => String(call?.name ?? "").slice(0, 100)).slice(0, 20);
    }
    let resultId: number | undefined;
    if (row.kind.startsWith("task.") && typeof source.summary === "string") {
      body.summary = source.summary.slice(0, 16000);
      body.summary_truncated = source.summary.length > 16000;
      textTruncated ||= source.summary.length > 16000;
      if (["task.completed", "task.failed", "task.cancelled"].includes(row.kind)) resultId = row.result_id ?? undefined;
    }
    for (const key of ["name", "tool", "status", "reason", "code", "failure_kind", "provider_limit_reason", "provider_limit_resets_at"])
      if (typeof source[key] === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(source[key])) body[key] = source[key];
    if (row.kind === "usage") for (const key of ["tokens_in", "tokens_out", "usd_est", "steps"])
      if (typeof source[key] === "number" && Number.isFinite(source[key])) body[key] = source[key];
    return { kind: row.kind, body, created_at: row.created_at, ...(resultId === undefined ? {} : { result_id: resultId }) };
  });
  return { steps, truncated: rows.length > 100 || textTruncated, history_truncated: rows.length > 100 };
}

/** Only the same terminal summary already admitted to operator history; never raw audit data. */
export function taskResult(store: Store, taskId: string, resultId: number) {
  const row = store.db.prepare(`SELECT body_json FROM audit_refs WHERE task_id = ? AND seq = ?
    AND type IN ('task.completed','task.failed','task.cancelled')`).get(taskId, resultId) as { body_json: string } | undefined;
  if (!row) return null;
  const summary = (JSON.parse(row.body_json) as Record<string, unknown>).summary;
  if (typeof summary !== "string") return null;
  const maxChars = 256000;
  return { text: summary.slice(0, maxChars), truncated: summary.length > maxChars,
    total_chars: summary.length, max_chars: maxChars };
}
