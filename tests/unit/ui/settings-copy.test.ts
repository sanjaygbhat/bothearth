/** The words Settings puts on screen, and the ones it refuses to. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { humanApiError } from "../../../src/ui/api.ts";
describe("readable settings errors", () => {
  it("never puts a daemon error code on the screen", () => {
    // A daemon code is not copy: the pane must not print "missing session".
    const fallback = "Usage could not be read just now.";
    assert.equal(humanApiError(new Error("missing session"), fallback), fallback);
    assert.equal(humanApiError(new Error("E_SANDBOX"), fallback), fallback);
    assert.equal(humanApiError(new Error(""), fallback), fallback);
    assert.equal(humanApiError(null, fallback), fallback);
    assert.equal(
      humanApiError(new Error("E_TASK_ACTIVE: something is wrong."), fallback),
      fallback,
      "a code wearing a sentence is still a code",
    );
    // A sentence the daemon actually wrote for a person is kept.
    const written = "Your current task is still working. Open it to continue or stop it before starting another.";
    assert.equal(humanApiError(new Error(written), fallback), written);
  });
});
