/**
 * The person has to be able to find out that the bot needs them.
 *
 * An ad-hoc signed build cannot post a macOS notification at all, so the window
 * itself is the fallback that cannot be refused.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { attentionBanner, countdownText, soonestDeadline } from "../../../src/ui/needs-you.ts";
import { waitingByTask } from "../../../src/ui/home.ts";
import type { AttentionItem } from "../../../src/ui/native.ts";

const NOW = Date.parse("2026-09-07T12:00:00.000Z");
const inSeconds = (n: number) => new Date(NOW + n * 1000).toISOString();

function item(over: Partial<AttentionItem> = {}): AttentionItem {
  return { id: "a1", kind: "approval", taskId: "t_1", ...over } as AttentionItem;
}

describe("countdown", () => {
  it("reads as a clock, not as a number of seconds", () => {
    assert.equal(countdownText(48_000), "0:48");
    assert.equal(countdownText(125_000), "2:05");
    assert.equal(countdownText(60_000), "1:00");
    assert.equal(countdownText(9_400), "0:09");
  });

  it("never goes negative once the deadline has passed", () => {
    assert.equal(countdownText(-5_000), "0:00");
    assert.equal(countdownText(0), "0:00");
  });
});

describe("the strip", () => {
  it("says nothing at all when nothing is waiting", () => {
    assert.equal(attentionBanner([], NOW), null);
  });

  it("names one waiting task and counts it down to the task it belongs to", () => {
    const banner = attentionBanner([item({ expiresAt: inSeconds(48) })], NOW);
    assert.equal(banner?.count, 1);
    assert.equal(banner?.text, "Your bot needs you");
    assert.equal(banner?.sub, "0:48 left");
    assert.equal(banner?.route, "#/tasks/t_1");
  });

  it("counts several, and counts down the one that runs out first", () => {
    const banner = attentionBanner(
      [item({ id: "a1", expiresAt: inSeconds(90) }), item({ id: "a2", expiresAt: inSeconds(20) })],
      NOW,
    );
    assert.equal(banner?.count, 2);
    assert.match(banner?.text ?? "", /2 things are waiting/);
    assert.equal(banner?.sub, "0:20 left");
  });

  it("says the time is up rather than showing a stuck 0:00", () => {
    const banner = attentionBanner([item({ expiresAt: inSeconds(-3) })], NOW);
    assert.equal(banner?.sub, "Time is up — it stopped and is waiting for you");
  });

  it("still shows, with no countdown, when the ask has no deadline", () => {
    const banner = attentionBanner([item({ kind: "takeover" })], NOW);
    assert.equal(banner?.count, 1);
    assert.equal(banner?.sub, undefined);
    assert.equal(soonestDeadline([item({ kind: "takeover" })]), null);
  });

  it("falls back to home when the ask is not tied to a task", () => {
    assert.equal(attentionBanner([item({ taskId: null })], NOW)?.route, "#/");
  });

  it("uses plain words — never the machinery behind them", () => {
    const banner = attentionBanner([item({ expiresAt: inSeconds(30) })], NOW);
    const text = `${banner?.text} ${banner?.sub}`;
    assert.doesNotMatch(text, /approval|takeover|epoch|lease|computer_id|daemon/i);
  });
});

describe("the Recent row", () => {
  it("maps a waiting ask onto the task whose row should count down", () => {
    const map = waitingByTask([item({ taskId: "t_1", expiresAt: inSeconds(48) })]);
    assert.equal(map.size, 1);
    assert.equal(countdownText((map.get("t_1") as number) - NOW), "0:48");
  });

  it("keeps the soonest deadline when one task has two asks open", () => {
    const map = waitingByTask([
      item({ id: "a1", taskId: "t_1", expiresAt: inSeconds(90) }),
      item({ id: "a2", taskId: "t_1", expiresAt: inSeconds(20) }),
    ]);
    assert.equal(map.size, 1);
    assert.equal(countdownText((map.get("t_1") as number) - NOW), "0:20");
  });

  it("ignores asks with no task, no deadline or an unreadable one", () => {
    const map = waitingByTask([
      item({ taskId: null, expiresAt: inSeconds(10) }),
      item({ id: "a2", taskId: "t_2" }),
      item({ id: "a3", taskId: "t_3", expiresAt: "not a date" }),
    ]);
    assert.equal(map.size, 0);
  });
});

describe("the window carries the wait", () => {
  it("hands the title across the bridge, and only in the Mac shell", () => {
    const UI = join(dirname(fileURLToPath(import.meta.url)), "../../../src/ui");
    const needsYou = readFileSync(join(UI, "needs-you.ts"), "utf8");
    assert.match(needsYou, /onDocumentTitle\(\(title\) => \{/);
    assert.match(
      needsYou,
      /if \(modelbotNative\.isNative\) modelbotNative\.setTitle\(title\)/,
      "a browser tab already has document.title; setting it twice would fight the shell",
    );
  });

  it("still says what is waiting, and for how long, in the strip", () => {
    const now = Date.parse("2026-09-07T10:00:00.000Z");
    const banner = attentionBanner(
      [{ id: "k1", kind: "takeover", taskId: "t_1", expiresAt: "2026-09-07T10:01:41.000Z" }],
      now,
    );
    assert.equal(banner?.text, "Your bot needs you");
    assert.equal(banner?.sub, "1:41 left");
    assert.equal(banner?.route, "#/tasks/t_1");
    assert.equal(attentionBanner([], now), null, "and says nothing when nothing waits");
  });
});
