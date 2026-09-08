import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cronMatches,
  describeCron,
  cronIntervalFloorWarning,
  MINIMUM_INTERVAL_MS,
  MISSED_RUN_WINDOW_MS,
  nextCronRun,
  parseCron,
  shouldFireMissed,
} from "../../../src/scheduler/cron.ts";

/** Build a local Date from YYYY-MM-DDTHH:mm:ss (no Z). */
function local(iso: string): Date {
  const [d, t] = iso.split("T");
  const [y, m, day] = d!.split("-").map(Number);
  const [hh, mm, ss] = t!.split(":").map(Number);
  return new Date(y!, m! - 1, day!, hh!, mm!, ss! ?? 0, 0);
}

describe("cron parser", () => {
  const cases: Array<{ expr: string; at: string; want: boolean }> = [
    { expr: "* * * * *", at: "2026-03-15T12:30:00", want: true },
    { expr: "0 * * * *", at: "2026-03-15T12:00:00", want: true },
    { expr: "0 * * * *", at: "2026-03-15T12:01:00", want: false },
    { expr: "*/5 * * * *", at: "2026-03-15T12:00:00", want: true },
    { expr: "*/5 * * * *", at: "2026-03-15T12:05:00", want: true },
    { expr: "*/5 * * * *", at: "2026-03-15T12:06:00", want: false },
    { expr: "0 9 * * *", at: "2026-03-15T09:00:00", want: true },
    { expr: "0 9 * * *", at: "2026-03-15T10:00:00", want: false },
    { expr: "0 0 1 * *", at: "2026-03-01T00:00:00", want: true },
    { expr: "0 0 1 * *", at: "2026-03-02T00:00:00", want: false },
    { expr: "0 0 1 1 *", at: "2026-01-01T00:00:00", want: true },
    { expr: "0 0 1 1 *", at: "2026-02-01T00:00:00", want: false },
    { expr: "0 0 * * 0", at: "2026-03-15T00:00:00", want: true }, // Sun
    { expr: "0 0 * * 0", at: "2026-03-16T00:00:00", want: false },
    { expr: "0 0 * * sun", at: "2026-03-15T00:00:00", want: true },
    { expr: "0 0 * * mon", at: "2026-03-16T00:00:00", want: true },
    { expr: "0 0 * * fri", at: "2026-03-20T00:00:00", want: true },
    { expr: "30 14 * * 1-5", at: "2026-03-16T14:30:00", want: true },
    { expr: "30 14 * * 1-5", at: "2026-03-15T14:30:00", want: false },
    { expr: "0 9,17 * * *", at: "2026-03-15T09:00:00", want: true },
    { expr: "0 9,17 * * *", at: "2026-03-15T17:00:00", want: true },
    { expr: "0 9,17 * * *", at: "2026-03-15T12:00:00", want: false },
    { expr: "0-10 * * * *", at: "2026-03-15T12:05:00", want: true },
    { expr: "0-10 * * * *", at: "2026-03-15T12:11:00", want: false },
    { expr: "*/15 8-17 * * 1-5", at: "2026-03-16T08:00:00", want: true },
    { expr: "*/15 8-17 * * 1-5", at: "2026-03-16T08:15:00", want: true },
    { expr: "*/15 8-17 * * 1-5", at: "2026-03-16T07:00:00", want: false },
    { expr: "0 0 1 jan *", at: "2026-01-01T00:00:00", want: true },
    { expr: "0 0 1 dec *", at: "2026-12-01T00:00:00", want: true },
    { expr: "5 4 * * sun", at: "2026-03-15T04:05:00", want: true },
    { expr: "59 23 31 12 *", at: "2026-12-31T23:59:00", want: true },
    { expr: "0 12 15 * *", at: "2026-06-15T12:00:00", want: true },
    { expr: "10,20,30 * * * *", at: "2026-03-15T01:20:00", want: true },
    { expr: "10,20,30 * * * *", at: "2026-03-15T01:25:00", want: false },
    { expr: "*/10 * * * *", at: "2026-03-15T01:40:00", want: true },
    { expr: "0 0 * feb mon", at: "2026-02-02T00:00:00", want: true },
  ];

  it(`has >= 30 cases (n=${cases.length})`, () => {
    assert.ok(cases.length >= 30);
  });

  for (const c of cases) {
    it(`${c.expr} @ ${c.at} => ${c.want}`, () => {
      assert.equal(cronMatches(c.expr, local(c.at)), c.want);
    });
  }

  it("parseCron rejects bad field count", () => {
    assert.throws(() => parseCron("* * *"), /5/);
  });

  it("nextCronRun is strictly after", () => {
    const after = local("2026-03-15T09:00:00");
    const next = nextCronRun("0 9 * * *", after);
    assert.ok(next.getTime() > after.getTime());
    assert.equal(next.getHours(), 9);
    assert.equal(next.getMinutes(), 0);
  });

  it("shouldFireMissed window", () => {
    const sched = local("2026-03-15T10:00:00");
    assert.equal(shouldFireMissed(sched, local("2026-03-15T10:30:00")), true);
    assert.equal(
      shouldFireMissed(sched, new Date(sched.getTime() + MISSED_RUN_WINDOW_MS)),
      false,
    );
    assert.equal(shouldFireMissed(sched, local("2026-03-15T09:59:00")), false);
  });

  it("describeCron weekdays 09:00 is prose not raw", () => {
    const text = describeCron("0 9 * * 1-5");
    assert.notEqual(text, "0 9 * * 1-5");
    assert.match(text, /weekday/i);
    assert.match(text, /09:00/);
  });

  it("15-minute floor warns and does not reject */5", () => {
    assert.equal(MINIMUM_INTERVAL_MS, 15 * 60 * 1000);
    const warn = cronIntervalFloorWarning("*/5 * * * *");
    assert.ok(warn);
    assert.match(warn, /15 minutes/);
    assert.equal(cronIntervalFloorWarning("0 9 * * 1-5"), null);
  });
});
