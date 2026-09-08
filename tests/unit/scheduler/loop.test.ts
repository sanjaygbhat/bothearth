import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NotifyPayload } from "../../../src/notify/index.ts";
import { Scheduler } from "../../../src/scheduler/loop.ts";
import { RoutinesStore } from "../../../src/scheduler/store.ts";

describe("scheduler loop", () => {
  it("fires, single-flight, history, missed-run, failure notify", async () => {
    const store = new RoutinesStore(":memory:");
    let now = new Date("2026-03-15T10:00:00.000Z");
    const notifies: NotifyPayload[] = [];
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const routine = store.create({
      name: "weekly-invoices",
      cron: "0 10 * * *",
      computer_name: "office",
      task: {
        goal: "collect invoices",
        capabilities: ["browser"],
        origins: ["https://example.com"],
      },
      notify: ["webhook:https://example.test/hook"],
      notify_on: ["fail", "done"],
      enabled: true,
    });
    store.setNextRun(routine.id, "2026-03-15T10:00:00.000Z", now);

    const scheduler = new Scheduler({
      store,
      clock: { now: () => now },
      notifyFn: async (_targets, payload) => {
        notifies.push(payload);
      },
      runner: {
        async run() {
          runs += 1;
          if (runs === 1) {
            await gate;
            return { ok: false, error: "portal down https://evil.example/x" };
          }
          return { ok: true, task_id: "task_ok", cost_usd: 0.01 };
        },
      },
    });

    const first = scheduler.runNow(routine.id);
    const skipped = await scheduler.runNow(routine.id);
    assert.equal(skipped.status, "skipped");
    assert.match(skipped.error ?? "", /single-flight|already running/i);

    release();
    const failed = await first;
    assert.equal(failed.status, "failed");
    assert.ok(store.listHistory(routine.id).length >= 2);
    assert.equal(notifies.length, 1);
    assert.equal(notifies[0]!.kind, "routine_fail");
    assert.match(notifies[0]!.reason ?? "", /portal down/);

    now = new Date("2026-03-15T12:00:00.000Z");
    store.setNextRun(routine.id, "2026-03-15T11:30:00.000Z", now);
    await scheduler.tick();
    assert.ok(runs >= 2);

    const before = runs;
    now = new Date("2026-03-15T15:00:00.000Z");
    store.setNextRun(routine.id, "2026-03-15T12:00:00.000Z", now);
    await scheduler.tick();
    assert.equal(runs, before);
    assert.ok(
      store
        .listHistory(routine.id)
        .some((h) => h.status === "skipped" && h.missed === 1),
    );

    store.close();
  });

  it("10 consecutive failures disable the routine with one fatigue notify", async () => {
    const store = new RoutinesStore(":memory:");
    const notifies: NotifyPayload[] = [];
    const routine = store.create({
      name: "flaky",
      cron: "0 9 * * 1-5",
      computer_name: "office",
      task: { goal: "x", capabilities: ["browser"] },
      notify: ["webhook:https://example.test/hook"],
      notify_on: ["fail"],
    });
    const scheduler = new Scheduler({
      store,
      notifyFn: async (_t, payload) => {
        notifies.push(payload);
      },
      runner: { async run() { return { ok: false, error: "down" }; } },
    });
    for (let i = 0; i < 10; i++) {
      await scheduler.runNow(routine.id);
    }
    const row = store.get(routine.id);
    assert.equal(row?.enabled, 0);
    assert.equal(
      notifies.filter((n) => /switched.{0,20}off/i.test(n.reason ?? "")).length,
      1,
    );
    store.close();
  });

  it("five consecutive failures with notify_on fail send five notifications", async () => {
    const store = new RoutinesStore(":memory:");
    const notifies: NotifyPayload[] = [];
    const routine = store.create({
      name: "weekly-back-office",
      cron: "0 9 * * 1",
      computer_name: "office",
      task: { goal: "x", capabilities: ["browser"] },
      notify: ["webhook:https://example.test/hook"],
      notify_on: ["fail"],
    });
    const scheduler = new Scheduler({
      store,
      notifyFn: async (_t, payload) => {
        notifies.push(payload);
      },
      runner: { async run() { return { ok: false, error: "down" }; } },
    });
    for (let i = 0; i < 5; i++) {
      await scheduler.runNow(routine.id);
    }
    assert.equal(notifies.length, 5);
    assert.ok(notifies.every((n) => n.kind === "routine_fail"));
    store.close();
  });

  it("skips overlapping ticks", async () => {
    const store = new RoutinesStore(":memory:");
    let now = new Date("2026-03-16T09:00:00.000Z");
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const routine = store.create({
      name: "slow",
      cron: "0 9 * * 1-5",
      computer_name: "office",
      task: { goal: "x", capabilities: ["browser"] },
    });
    store.setNextRun(routine.id, now.toISOString(), now);
    const scheduler = new Scheduler({
      store,
      clock: { now: () => now },
      runner: {
        async run() {
          runs += 1;
          await gate;
          return { ok: true };
        },
      },
    });
    const first = scheduler.tick();
    await scheduler.tick();
    release();
    await first;
    assert.equal(runs, 1);
    store.close();
  });
});
