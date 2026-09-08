/**
 * What the page hands the native shell: opening a saved file, the `back` event,
 * and the window title and badge while something is waiting.
 *
 * The Swift half is asserted by `npm run app:mac -- --selftest`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { documentTitleFor } from "../../../src/ui/shell.ts";

const UI = join(dirname(fileURLToPath(import.meta.url)), "../../../src/ui");
const source = (name: string) => readFileSync(join(UI, name), "utf8");

describe("opening a saved file", () => {
  it("has no anchor anywhere in the task view pointing at an API route", () => {
    const task = source("task.ts");
    // A `.href = "/api/..."` on an anchor replaces the app with the raw body
    // and leaves no way back.
    assert.equal(
      /\.href\s*=\s*[`"']\/api\//.test(task),
      false,
      "no anchor in the task view is given an API URL",
    );
    assert.equal(
      /createElement\("a"\)/.test(task.slice(task.indexOf("renderArtifacts"))),
      false,
      "the saved-files rows build buttons, not links",
    );
  });

  it("routes both file actions through the one bridge call", () => {
    const task = source("task.ts");
    const calls = task.match(/modelbotNative\.revealFile\(/g) ?? [];
    assert.equal(calls.length, 2, "the saved file and the saved result both go through it");
  });

  it("hands the shell the results directory when the record carries one", () => {
    const task = source("task.ts");
    assert.match(task, /results_dir\?: string \| null;/, "the record type has the field");
    assert.match(task, /resultsDir: task\.results_dir \?\? null/);
  });

  it("declares a `back` event, so ⌘[ has something to land on", () => {
    const native = source("native.ts");
    assert.match(native, /\| "back"/);
    // The shell dispatches this only once its own history is exhausted.
    const readme = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../apps/macos/README.md"),
      "utf8",
    );
    assert.match(readme, /`revealFile`/, "the contract doc lists the method");
    assert.match(readme, /`setAttention`/);
    assert.match(readme, /\| `back` \|/, "the shell→page kinds list `back`");
  });
});

describe("the window says it needs you", () => {
  it("titles the window '● Needs you — BotHearth' while something waits", () => {
    assert.equal(documentTitleFor("Working", true), "● Needs you — BotHearth");
    assert.equal(documentTitleFor(null, true), "● Needs you — BotHearth");
    assert.equal(documentTitleFor("Working", false), "Working — BotHearth");
    assert.equal(documentTitleFor(null, false), "BotHearth");
  });

  it("tells the shell how many things are waiting, alongside the badge", () => {
    const native = source("native.ts");
    const sync = native.slice(native.indexOf("modelbotNative.setBadge(live.length);"));
    assert.match(sync.slice(0, 400), /modelbotNative\.setAttention\(live\.length\)/);
    assert.match(native, /post\("setAttention", \{ waiting: n \}\)/);
  });

  it("does not say it twice in a browser tab", () => {
    const native = source("native.ts");
    assert.match(
      native,
      /badgeCount > 0 && !base\.startsWith\("● "\)/,
      "a tab titled '● Needs you' is not also prefixed '(1)'",
    );
  });
});
