/**
 * How long a task ran, and when it finished.
 *
 * Three real tasks all reported "Done in 0 seconds" against wall times of about
 * five minutes, 158 seconds and ninety seconds, and one showed a finish time
 * three minutes BEFORE entries in its own feed. Both came from reading a single
 * field that the daemon does not always write.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  spanDurationText,
  spanPreciseText,
  taskSpan,
  type DurableStep,
  type TaskRecord,
} from "../../../src/ui/task.ts";

const T = (m: number, s = 0) => new Date(Date.UTC(2026, 8, 7, 12, m, s)).toISOString();

function task(over: Partial<TaskRecord> = {}): TaskRecord {
  return { id: "t_1", computer_id: "c_1", goal: "g", status: "completed", created_at: T(56), ...over };
}
function steps(...times: string[]): DurableStep[] {
  return times.map((created_at) => ({ kind: "tool.call", body: {}, created_at }));
}

describe("how long a task ran", () => {
  it("uses the record when the record is complete", () => {
    const span = taskSpan(task({ started_at: T(56), finished_at: T(61, 12) }), []);
    assert.equal(span?.ms, 312_000);
    assert.equal(spanDurationText(span, 0), "5 minutes");
    assert.equal(spanPreciseText(span, 0), "5 min 12 s");
  });

  it("reads whichever end-of-task field the daemon happens to have written", () => {
    for (const field of ["finished_at", "completed_at", "ended_at", "updated_at"] as const) {
      const span = taskSpan(task({ [field]: T(58, 30) }), []);
      assert.equal(span?.ms, 150_000, field);
    }
  });

  it("never ends the task before its own last event (the 12:58/1:01 bug)", () => {
    // updated_at says 12:58; the feed has an entry at 13:01.
    const record = task({ created_at: T(56), updated_at: T(58) });
    const span = taskSpan(record, steps(T(57), T(59), T(61)));
    assert.equal(span?.to, T(61), "the finish time must not precede the last step");
    assert.equal(span?.ms, 300_000);
  });

  it("never starts the task after its own first event", () => {
    const span = taskSpan(task({ created_at: T(59), updated_at: T(61) }), steps(T(56)));
    assert.equal(span?.from, T(56));
  });

  it("says nothing rather than “0 seconds” when a task with events has no usable span", () => {
    // The exact shape QA hit: no end field written, and every event stamped at
    // the same instant, so both ends of the span collapse together.
    const span = taskSpan(task({ created_at: T(56) }), steps(T(56), T(56)));
    assert.equal(span?.ms, 0);
    assert.equal(spanDurationText(span, 14), null, "14 events cannot have taken no time");
    assert.equal(spanPreciseText(span, 14), null);
    // With no events at all, instant is a believable answer.
    assert.equal(spanDurationText(span, 0), "less than a second");
    assert.equal(spanPreciseText(span, 0), "Less than a second");
  });

  it("declines to invent a span when the record has no end and no events", () => {
    assert.equal(taskSpan(task({ created_at: T(56) }), []), null);
    assert.equal(spanPreciseText(null, 0), null, "the receipt then says it was not recorded");
  });

  it("never returns a negative span, whatever the record says", () => {
    assert.equal(taskSpan(task({ created_at: T(61), updated_at: T(56) }), []), null);
    assert.equal(spanDurationText(null, 3), null);
    assert.equal(spanPreciseText(null, 3), null);
  });

  it("survives a record with unparseable or missing timestamps", () => {
    assert.equal(taskSpan(task({ created_at: "not a date" }), []), null);
    assert.equal(
      taskSpan(task({ created_at: "not a date" }), steps(T(56), T(58)))?.ms,
      120_000,
      "the events alone are enough",
    );
  });

  it("is a pure function: the same record gives the same answer every time", () => {
    const record = task({ created_at: T(56), finished_at: T(61, 12) });
    const rows = steps(T(57), T(59));
    const first = taskSpan(record, rows);
    const second = taskSpan(record, rows);
    assert.deepEqual(first, second);
  });
});
