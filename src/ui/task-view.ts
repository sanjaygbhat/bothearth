/**
 * Task status and step wording. The daemon's own receipt tests
 * (tests/unit/daemon/task-outcome.test.ts) assert their terminal states through
 * these, so the wording lives in one place for both.
 */
export type TaskRow = {
  id: string; computer_id: string; goal: string; status: string; created_at: string;
  adapter?: string | null; max_steps: number;
  model?: string | null;
  execution_mode?: "executor" | "orchestrator" | null;
  executor?: { adapter: string; model: string } | null;
  started_at?: string | null;
  duration_ms?: number | null;
  awaiting_message?: boolean;
  last_assistant?: string | null;
};
export type TaskStep = { kind: string; body: Record<string, unknown>; created_at: string; result_id?: number };

export function taskStatus(status: string): string {
  return ({ running: "Working", completed: "Completed", failed: "Failed", cancelled: "Stopped",
    paused: "Paused", pending_approval: "Needs approval", takeover_requested: "Needs you" } as Record<string, string>)[status] ?? status.replaceAll("_", " ");
}


/** Render only projected message text; observations and tool arguments are not a conversation. */
export function stepText(step: TaskStep): string | null {
  const body = step.body;
  if (!body || typeof body !== "object") return null;
  if (typeof body.summary === "string" && body.summary.trim()) return body.summary;
  if (step.kind === "assistant" && typeof body.content === "string" && body.content.trim()) return body.content;
  if (step.kind === "assistant" && typeof body.text === "string" && body.text.trim()) return body.text;
  // Safe static notices, not raw runner/provider details or invented success.
  if (step.kind === "task.failed") return "The task did not finish. Review saved progress and any completed actions before starting another task.";
  if (step.kind === "task.cancelled") return "The task was stopped. Earlier actions may already have taken effect. Review saved progress before starting another task.";
  if (step.kind === "task.completed") return "The task was marked completed, but no final summary was saved. Review its activity before relying on the outcome.";
  return null;
}
