/** The task view hands the keyboard to the live screen, and Esc gives it back. */
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
      task.indexOf("this.renderPanelState(driving, needsYou, observing);") <
        task.indexOf("this.renderSurface(driving, observing);"),
      "the phase is set before the surface asks for focus",
    );
  });

  it("makes Esc return control, not just leave full screen", () => {
    const task = source("task.ts");
    assert.match(
      task,
      /event\.key === "Escape" && this\.drivingNow\(\)/,
      "the hint's promise is wired to something",
    );
  });
});
