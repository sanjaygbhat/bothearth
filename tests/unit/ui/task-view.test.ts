import { test } from "node:test";
import assert from "node:assert/strict";
import { stepText, taskStatus } from "../../../src/ui/task-view.ts";

test("a task status reads as a plain word", () => {
  assert.equal(taskStatus("pending_approval"), "Needs approval");
  assert.equal(taskStatus("running"), "Working");
  assert.equal(taskStatus("cancelled"), "Stopped");
  assert.equal(taskStatus("something_new"), "something new");
});

test("conversation renders projected messages and summaries, never raw observation text", () => {
  assert.equal(stepText({ kind: "assistant", body: { content: "Report" }, created_at: "" }), "Report");
  assert.equal(stepText({ kind: "task.completed", body: { summary: "Done" }, created_at: "" }), "Done");
  assert.equal(stepText({ kind: "observation", body: { content: "private page" }, created_at: "" }), null);
});

test("terminal receipts without summaries show safe, actionable notices", () => {
  const text = (kind: string, body: Record<string, unknown> = {}) => stepText({ kind, body, created_at: "" });
  assert.match(text("task.failed", { detail: "PRIVATE_EXCEPTION_CANARY" }) ?? "", /did not finish/i);
  assert.match(text("task.cancelled") ?? "", /earlier actions/i);
  assert.match(text("task.completed", { summary: "   " }) ?? "", /no final summary/i);
  assert.equal(text("task.step", { status: "running" }), null);
  assert.equal(text("tool.result", { detail: "PRIVATE_EXCEPTION_CANARY" }), null);
  assert.doesNotMatch(text("task.failed", { detail: "PRIVATE_EXCEPTION_CANARY" }) ?? "", /PRIVATE_EXCEPTION_CANARY/);
});
