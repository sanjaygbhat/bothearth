import { sanitizeSecretEvidenceRow } from "../policy/signals.ts";
import type { TaskBudget } from "../types/contracts.ts";
import { redactStringValue } from "./log.ts";
import { harnessSpendUsd, type Store, type TaskRow } from "./store.ts";

function compactTakeoverField(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (src.kind === "password" || src.kind === "otp") out.kind = src.kind;
  if (src.branch === "header" || src.branch === "marker" || src.branch === "name")
    out.branch = src.branch;
  if (Array.isArray(src.fields)) {
    const fields = [];
    for (const row of src.fields.slice(0, 5)) {
      const clean = sanitizeSecretEvidenceRow(row);
      if (!clean) continue;
      const branch =
        clean.branch === "header" || clean.branch === "marker" || clean.branch === "name"
          ? clean.branch
          : typeof out.branch === "string"
            ? out.branch
            : undefined;
      if (!branch) continue;
      fields.push({ ...clean, branch });
    }
    while (fields.length && JSON.stringify(fields).length > 400) fields.pop();
    if (fields.length) out.fields = fields;
  }
  while (JSON.stringify(out).length > 400 && Array.isArray(out.fields) && out.fields.length) {
    out.fields.pop();
    if (!out.fields.length) delete out.fields;
  }
  return out.kind || out.branch || out.fields ? out : undefined;
}

export interface TakeoverContextBody {
  [key: string]: unknown;
  takeover_id?: string;
  reason?: string;
  field_kind?: string;
  field?: Record<string, unknown>;
}

/** Only the human-facing handoff instruction and its identity, never tool arguments. */
export function takeoverContext(source: Record<string, unknown>): TakeoverContextBody {
  const body: TakeoverContextBody = {};
  if (typeof source.takeover_id === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(source.takeover_id))
    body.takeover_id = source.takeover_id;
  if (typeof source.reason === "string") body.reason = redactStringValue(source.reason).trim().slice(0, 2000);
  const field = compactTakeoverField(source.field);
  const nested = field?.kind;
  const kind =
    typeof source.field_kind === "string"
      ? source.field_kind
      : typeof nested === "string"
        ? nested
        : "";
  if (kind === "password" || kind === "otp") body.field_kind = kind;
  if (field) body.field = field;
  return body;
}

/**
 * What this task has spent and what it may spend, read from the same counter
 * that stops it. A harness task is priced by the daemon's per-tool-call proxy
 * rate, which is also what its cap is measured in; a standalone task is priced
 * by the provider's own estimate, and its calls are counted from the log.
 *
 * Native bindings store `spend_cap_usd` / `max_steps` as 0 (no BotHearth cap).
 * Those must not fall back to the API-adapter default — the proxy figure is an
 * estimate, not a limit.
 */
export function taskBudget(
  store: Store,
  task: TaskRow,
  defaultCapUsd: number,
): TaskBudget {
  const binding = store.harnessBindingForTask(task.id);
  if (binding) {
    const cap = binding.spend_cap_usd > 0 ? binding.spend_cap_usd : null;
    const stepCap = binding.max_steps > 0 ? binding.max_steps : null;
    const moneyCalls = cap !== null && binding.proxy_usd_per_tool_call > 0
      ? Math.floor(cap / binding.proxy_usd_per_tool_call)
      : Number.POSITIVE_INFINITY;
    const limited = Math.min(moneyCalls, stepCap ?? Number.POSITIVE_INFINITY);
    return {
      spend_usd: harnessSpendUsd(binding.observed_tool_calls, binding.proxy_usd_per_tool_call),
      spend_cap_usd: cap,
      calls: binding.observed_tool_calls,
      calls_cap: Number.isFinite(limited) ? limited : null,
    };
  }
  const cap = task.spend_cap_usd ?? defaultCapUsd;
  return {
    spend_usd: store.taskUsage(task.id)?.usd_est ?? null,
    spend_cap_usd: cap > 0 ? cap : null,
    calls: store.countToolCalls(task.id),
    calls_cap: null,
  };
}

/** Operator task history excludes browser observations, tool arguments and raw audit bodies. */
export function taskActivity(store: Store, taskId: string) {
  const rows = store.db.prepare(`
    SELECT kind, body_json, created_at, result_id FROM (
      SELECT kind, body_json, created_at, NULL AS result_id FROM steps WHERE task_id = ? AND kind IN ('assistant', 'user', 'native_tool')
      UNION ALL
      SELECT type AS kind, body_json, ts AS created_at, seq AS result_id FROM audit_refs WHERE task_id = ?
        AND type IN ('task.completed','task.failed','task.cancelled','task.resumed','task.step','tool.call','tool.result',
          'tool.error','usage','policy.denied','approval.requested','takeover.requested','download.promoted')
    ) ORDER BY created_at DESC LIMIT 101
  `).all(taskId, taskId) as Array<{ kind: string; body_json: string; created_at: string; result_id: number | null }>;
  const recent = rows.slice(0, 100);
  const task = store.getTask(taskId);
  const active = task && store.activeTakeoverForComputer(task.computer_id, taskId);
  if (active) {
    // Polling during a long human wait must not push its instruction out of history.
    const handoff = store.db.prepare(`SELECT type AS kind, body_json, ts AS created_at, seq AS result_id
      FROM audit_refs WHERE task_id = ? AND type = 'takeover.requested'
        AND json_extract(body_json, '$.takeover_id') = ? ORDER BY seq DESC LIMIT 1`)
      .get(taskId, active.id) as (typeof rows)[number] | undefined;
    if (handoff && !recent.some(row => row.result_id === handoff.result_id)) {
      if (recent.length === 100) recent.pop();
      recent.push(handoff);
    }
  }
  let textTruncated = false;
  const steps = recent.reverse().map((row) => {
    const source = JSON.parse(row.body_json) as Record<string, unknown>;
    const body: Record<string, unknown> = {};
    if (row.kind === "assistant" || row.kind === "user") {
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
    for (const key of ["id", "name", "tool", "type", "status", "reason", "code", "failure_kind", "provider_limit_reason", "provider_limit_resets_at", "cancelled_by"])
      if (typeof source[key] === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(source[key])) body[key] = source[key];
    if (row.kind === "takeover.requested") Object.assign(body, takeoverContext(source));
    if (row.kind === "download.promoted") {
      for (const key of ["path", "workspace_path", "filename", "name", "item_name"]) {
        const value = source[key];
        if (typeof value === "string" && value && value.length <= 500 && !value.includes("\0")) body[key] = value;
      }
      if (typeof source.bytes === "number" && Number.isFinite(source.bytes) && source.bytes >= 0) body.bytes = source.bytes;
    }
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
