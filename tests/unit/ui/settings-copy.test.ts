/** The words Settings puts on screen, and the ones it refuses to. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { humanApiError } from "../../../src/ui/api.ts";
import { parseBudget, readBudgetPreference, writeBudgetPreference } from "../../../src/ui/usage.ts";

describe("a setting you can read is a setting you can change", () => {
  it("accepts a real amount and refuses the rest", () => {
    assert.equal(parseBudget("2"), 2);
    assert.equal(parseBudget("$12.50"), 12.5);
    assert.equal(parseBudget(" 3.999 "), 4);
    assert.equal(parseBudget("0"), null);
    assert.equal(parseBudget("-5"), null);
    assert.equal(parseBudget("nope"), null);
    assert.equal(parseBudget("100000"), null);
  });

  it("keeps the figure on this Mac and survives storage being off", () => {
    const store = new Map<string, string>();
    const g = globalThis as { localStorage?: unknown };
    const had = "localStorage" in globalThis;
    const previous = g.localStorage;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    try {
      assert.equal(readBudgetPreference(), null);
      writeBudgetPreference(4.5);
      assert.equal(readBudgetPreference(), 4.5);
      writeBudgetPreference(null);
      assert.equal(readBudgetPreference(), null);
      // Storage that throws must not take the pane down with it.
      g.localStorage = { getItem() { throw new Error("off"); }, setItem() { throw new Error("off"); }, removeItem() { throw new Error("off"); } };
      assert.equal(readBudgetPreference(), null);
      writeBudgetPreference(2);
    } finally {
      if (had) g.localStorage = previous;
      else delete g.localStorage;
    }
  });

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
