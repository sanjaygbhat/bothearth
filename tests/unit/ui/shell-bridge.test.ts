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
  it("downloads saved files through an attachment link, not a popup", () => {
    const task = source("task.ts");
    const artifacts = task.slice(task.indexOf("fillArtifacts"));
    assert.match(artifacts, /createElement\("a"\)/, "Download is an attachment link");
    assert.match(artifacts, /\.download\s*=/, "the link names the file");
    assert.doesNotMatch(artifacts, /target\s*=\s*["']_blank/, "no new window — that replaced the app");
    assert.doesNotMatch(artifacts, /window\.open/);
  });

  it("opens a file through the shell; Download does not", () => {
    const task = source("task.ts");
    const calls = task.match(/modelbotNative\.revealFile\(/g) ?? [];
    assert.equal(calls.length, 2, "Open and Open result go through it; Download does not");
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

describe("the titlebar can open the task list", () => {
  it("keeps a Tasks link to #/tasks next to the status cluster", () => {
    const html = source("index.html");
    assert.match(html, /id="tb-tasks"/);
    assert.match(html, /href="#\/tasks"/);
    assert.match(html, />Tasks<\/a>/);
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
