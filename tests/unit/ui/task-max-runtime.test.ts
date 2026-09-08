/**
 * A run that reached the time limit its owner set did not run into anything:
 * the receipt used to shrug "Something on this machine got in its way", the
 * same sentence it gives a genuine machine fault, and sent the owner looking
 * for a problem that was not there.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { stopReasonText, terminalCopy } from "../../../src/ui/task.ts";

describe("a runtime stop", () => {
  it("says what the clock did, not that this machine got in the way", () => {
    const copy = terminalCopy({
      status: "paused",
      reason: "max_runtime",
      budget: "$20.00",
      took: "30 minutes",
      terminal: { failure_kind: "max_runtime" },
    });
    assert.equal(copy.kind, "paused");
    assert.match(copy.lede, /time limit/);
    assert.doesNotMatch(copy.lede, /got in its way/);
    assert.doesNotMatch(copy.lede, /rather than guess/);
  });

  it("says the same thing from the raw reason alone", () => {
    assert.match(stopReasonText("max_runtime")!, /time limit/);
  });

  it("still blames the machine only when the daemon actually did", () => {
    const copy = terminalCopy({
      status: "failed", reason: "runner_error", budget: null, took: null,
      terminal: { failure_kind: "machine" },
    });
    assert.match(copy.lede, /got in its way/);
  });
});
