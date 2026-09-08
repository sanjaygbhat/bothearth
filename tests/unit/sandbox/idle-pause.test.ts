import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createIdlePauseController } from "../../../src/sandbox/idle-pause.ts";

describe("idle pause", () => {
  function harness(opts?: {
    takeover?: () => boolean;
    unpauseComputer?: (id: string) => Promise<void>;
  }) {
    let now = 0;
    const pauses: string[] = [];
    const unpauses: string[] = [];
    let takeover = false;
    const ctl = createIdlePauseController({
      now: () => now,
      idlePauseMin: 1,
      pauseComputer: async (id) => {
        pauses.push(id);
      },
      unpauseComputer: async (id) => {
        unpauses.push(id);
        await opts?.unpauseComputer?.(id);
      },
      listComputers: () => ["demo"],
      isTakeoverActive: () => (opts?.takeover ? opts.takeover() : takeover),
    });
    ctl.track("demo");
    return {
      ctl,
      pauses,
      unpauses,
      setNow: (ms: number) => {
        now = ms;
      },
      setTakeover: (v: boolean) => {
        takeover = v;
      },
    };
  }

  it("idle > idle_pause_min → pauseComputer called exactly once", async () => {
    const h = harness();
    h.setNow(60_000);
    await h.ctl.tick();
    assert.equal(h.pauses.length, 0);
    h.setNow(60_001);
    await h.ctl.tick();
    await h.ctl.tick();
    assert.deepEqual(h.pauses, ["demo"]);
  });

  it("active takeover → not called", async () => {
    const h = harness();
    h.setTakeover(true);
    h.setNow(120_000);
    await h.ctl.tick();
    assert.equal(h.pauses.length, 0);
    assert.equal(h.ctl.pausedHas("demo"), false);
  });

  it("status poll → not resumed", async () => {
    const h = harness();
    h.setNow(60_001);
    await h.ctl.tick();
    assert.deepEqual(h.pauses, ["demo"]);
    h.ctl.statusPoll("demo");
    h.ctl.statusPoll();
    await h.ctl.tick();
    assert.equal(h.unpauses.length, 0);
    assert.equal(h.ctl.pausedHas("demo"), true);
    assert.deepEqual(h.pauses, ["demo"]);
  });

  it("first activity reconciles a pause inherited from the previous daemon, once", async () => {
    let pausedByPreviousDaemon = true;
    const h = harness({ unpauseComputer: async () => { pausedByPreviousDaemon = false; } });
    h.ctl.statusPoll("demo");
    assert.equal(pausedByPreviousDaemon, true, "status must not wake the container");
    await Promise.all([h.ctl.wake("demo"), h.ctl.wake("demo")]);
    assert.equal(pausedByPreviousDaemon, false);
    await h.ctl.wake("demo");
    assert.deepEqual(h.unpauses, ["demo"], "concurrent first calls share reconciliation");
  });

  it("activity waits for an in-flight pause and then resumes it", async () => {
    let now = 0, paused = false, finishPause!: () => void;
    const ctl = createIdlePauseController({ idlePauseMin: 1, now: () => now,
      listComputers: () => ["demo"], isTakeoverActive: () => false,
      pauseComputer: () => new Promise<void>((resolve) => { finishPause = () => { paused = true; resolve(); }; }),
      unpauseComputer: async () => { paused = false; },
    });
    await ctl.wake("demo"); now = 60_001;
    const tick = ctl.tick(), wake = ctl.wake("demo");
    finishPause();
    await Promise.all([tick, wake]);
    assert.equal(paused, false);
  });

  it("tool call → resumed", async () => {
    const h = harness();
    h.setNow(60_001);
    await h.ctl.tick();
    await h.ctl.wake("demo");
    assert.deepEqual(h.unpauses, ["demo"]);
    assert.equal(h.ctl.pausedHas("demo"), false);
    await h.ctl.tick();
    assert.deepEqual(h.pauses, ["demo"]);
    h.setNow(120_002);
    await h.ctl.tick();
    assert.deepEqual(h.pauses, ["demo", "demo"]);
  });

  it("failed unpause remains paused and can be retried", async () => {
    let attempts = 0;
    const h = harness({
      unpauseComputer: async () => {
        if (++attempts === 1) throw new Error("docker unavailable");
      },
    });
    h.setNow(60_001);
    await h.ctl.tick();

    await assert.rejects(h.ctl.wake("demo"), /docker unavailable/);
    assert.equal(h.ctl.pausedHas("demo"), true);
    await h.ctl.wake("demo");
    assert.equal(attempts, 2);
    assert.equal(h.ctl.pausedHas("demo"), false);
  });
});
