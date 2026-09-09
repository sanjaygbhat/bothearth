/** The task view hands the keyboard to the live screen without stealing desktop Escape. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const UI = join(dirname(fileURLToPath(import.meta.url)), "../../../src/ui");
const source = (name: string) => readFileSync(join(UI, name), "utf8");

describe("taking control", () => {
  it("gives the keyboard to the screen, not to the Give-control-back button", () => {
    const task = source("task.ts");
    const surface = task.slice(task.indexOf('if (want === "driving")'));
    assert.match(surface.slice(0, 900), /this\.panel\.focusScreen\(\)/);
    // The panel must already be in the driving phase by then.
    assert.ok(
      task.indexOf("this.renderPanelState(driving, needsControl, observing);") <
        task.indexOf("this.renderSurface(driving, observing);"),
      "the phase is set before the surface asks for focus",
    );
  });

  it("keeps Escape available to the computer outside fullscreen", () => {
    const task = source("task.ts");
    assert.doesNotMatch(task, /event\.key === "Escape" && this\.drivingNow\(\)/);
  });
});
