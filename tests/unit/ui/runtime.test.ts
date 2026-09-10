import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aiIdentity,
  createRuntimeWatcher,
  formatModelName,
  isSettling,
  limitTime,
  primaryBlocker,
  shouldAutoPrepare,
  type RuntimeBlocker,
  type RuntimeStatus,
} from "../../../src/ui/runtime.ts";

const IMAGE = { present: true, created_at: "2026-09-01T00:00:00Z", stale: false };

function status(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    node: { ok: true, version: "22.18.0" },
    docker: { installed: true, running: true, engine: "orbstack", version: "1.0" },
    images: {
      computer: { ...IMAGE },
      shell: { ...IMAGE },
      proxy: { ...IMAGE },
      prepare: { state: "idle", step: "", percent: null, log_tail: [], error: null },
    },
    ai: {
      provider: "claude",
      cli_found: true,
      cli_path_kind: "path",
      logged_in: true,
      detail: "Signed in",
    },
    task_start_available: true,
    blockers: [],
    ...overrides,
  };
}

function blocker(id: string): RuntimeBlocker {
  return { id, title: id, detail: id, action: { kind: "retry" } };
}

describe("runtime — which card shows", () => {
  it("puts the AI ask ahead of the container runtime (ux-spec §2.2)", () => {
    const chosen = primaryBlocker(
      status({ blockers: [blocker("docker_missing"), blocker("ai_not_connected")] }),
    );
    assert.equal(chosen?.id, "ai_not_connected");
  });

  it("still puts an unusable Node first, because nothing else can be fixed", () => {
    const chosen = primaryBlocker(
      status({ blockers: [blocker("ai_not_connected"), blocker("node_version")] }),
    );
    assert.equal(chosen?.id, "node_version");
  });

  it("shows an id it has never seen rather than dropping it", () => {
    const chosen = primaryBlocker(status({ blockers: [blocker("something_new")] }));
    assert.equal(chosen?.id, "something_new");
  });

  it("has no card at all once the ladder is clear", () => {
    assert.equal(primaryBlocker(status()), null);
    assert.equal(isSettling(status()), false);
  });

  it("keeps polling while a build runs, even with no blocker left", () => {
    const preparing = status();
    preparing.images.prepare = {
      state: "running",
      step: "Building the browser workspace (1 of 3)",
      percent: 33,
      log_tail: [],
      error: null,
    };
    assert.equal(isSettling(preparing), true);
  });
});

describe("runtime — the one-time download starts by itself", () => {
  it("starts when images are missing and nothing has been tried yet", () => {
    const missing = status({
      blockers: [{ id: "images_missing", title: "", detail: "", action: { kind: "prepare_images" } }],
    });
    assert.equal(shouldAutoPrepare(missing), true);
  });

  it("never restarts a build that already failed — that would loop", () => {
    const failed = status({
      blockers: [{ id: "images_missing", title: "", detail: "", action: { kind: "prepare_images" } }],
    });
    failed.images.prepare = {
      state: "failed",
      step: "",
      percent: null,
      log_tail: [],
      error: "build failed",
    };
    assert.equal(shouldAutoPrepare(failed), false);
  });

  it("does not start one for a blocker that is not about images", () => {
    assert.equal(shouldAutoPrepare(status({ blockers: [blocker("docker_missing")] })), false);
  });
});

describe("runtime — naming the model without knowing it in advance", () => {
  it("reads real ids the way a person would say them", () => {
    assert.equal(formatModelName("claude-opus-4-5"), "Opus 4.5");
    assert.equal(formatModelName("claude-sonnet-4-5-20250929"), "Sonnet 4.5");
    assert.equal(formatModelName("gpt-5.6-sol"), "GPT-5.6 Sol");
    assert.equal(formatModelName("gpt-6-astra"), "GPT-6 Astra");
    assert.equal(formatModelName("opus"), "Opus");
  });

  it("says nothing rather than something wrong", () => {
    assert.equal(formatModelName(""), null);
    assert.equal(formatModelName(null), null);
    assert.equal(formatModelName("   "), null);
    // Too long for the titlebar: the provider carries the pill instead.
    assert.equal(formatModelName("some-extremely-long-internal-model-identifier"), null);
  });
});

describe("runtime — the status pill", () => {
  it("says which AI and that it runs on the person's own plan", () => {
    const pill = aiIdentity({ status: status(), model: "claude-opus-4-5" });
    assert.equal(pill.text, "Claude · Opus 4.5");
    assert.equal(pill.sub, "· on your plan");
    assert.equal(pill.tone, "ok");
  });

  it("falls back to the provider alone when the model is unknown", () => {
    const pill = aiIdentity({ status: status(), model: null });
    assert.equal(pill.text, "Claude");
    assert.equal(pill.sub, "· on your plan");
  });

  it("trusts the connection Settings just made over a stale readiness probe", () => {
    // The probe is a poller and can still name the AI a page just switched
    // away from in Settings; the session's `executionMode` is the same field
    // connection.ts republishes the instant a connection changes, so it wins.
    const stale = status();
    stale.ai.provider = "codex";
    const pill = aiIdentity({ status: stale, model: "gpt-6-astra", executionMode: "claude" });
    assert.equal(pill.text, "Claude · GPT-6 Astra");

    // No fresher signal yet (a page that has not read the session): the probe
    // is still the honest fallback rather than nothing at all.
    assert.equal(
      aiIdentity({ status: stale, model: "gpt-6-astra" }).text,
      "Codex · GPT-6 Astra",
    );
  });

  it("never claims a plan it cannot see", () => {
    const direct = status();
    direct.ai.provider = null;
    const pill = aiIdentity({ status: direct, model: "gpt-6-astra", executionMode: "standalone" });
    assert.equal(pill.sub, undefined);
    assert.equal(pill.text, "GPT-6 Astra");
  });

  it("says so plainly when nothing is connected", () => {
    const pill = aiIdentity({ status: status({ task_start_available: false }), model: null });
    assert.equal(pill.text, "No model connected");
    assert.equal(pill.tone, "warn");
  });

  it("keeps a selected model visible while reporting its actual connection state", () => {
    for (const [connectionStatus, message] of [
      ["signed_out", "sign-in required"], ["signing_in", "finish sign-in"],
      ["missing", "setup needed"], ["error", "connection check failed"],
    ] as const) {
      const pill = aiIdentity({ status: status({ task_start_available: false }),
        model: "gpt-6-astra", executionMode: "codex", connectionStatus });
      assert.equal(pill.text, "Codex · GPT-6 Astra");
      assert.equal(pill.sub, `· ${message}`);
      assert.equal(pill.tone, "warn");
      assert.match(pill.label, /Selected model: gpt-6-astra/);
      assert.doesNotMatch(pill.label, /on your own plan/);
    }
    assert.equal(aiIdentity({ status: null, model: "gpt-6-astra", executionMode: "codex" }).sub,
      "· checking connection");
  });

  it("keeps the detail the pill had to drop in its accessible name", () => {
    const pill = aiIdentity({ status: status(), model: "claude-opus-4-5" });
    assert.match(pill.label, /Claude · Opus 4\.5/);
    assert.match(pill.label, /your own plan/);
  });

  it("says the plan is spent rather than that it is on your plan", () => {
    // `codex login status` exits 0 on a dry plan, so `task_start_available`
    // stays true and only `ai.limit` says the AI will refuse.
    const spent = status();
    spent.ai.limit = { reason: "quota_exhausted", resets_at: "2026-09-11T17:21:00.000Z" };
    const pill = aiIdentity({ status: spent, model: "claude-opus-4-5" });
    assert.equal(pill.text, "Claude · Opus 4.5");
    assert.equal(pill.tone, "warn");
    assert.equal(pill.sub, `· plan limit reached until ${limitTime("2026-09-11T17:21:00.000Z")}`);
    assert.match(pill.label, /plan limit reached until/);
    assert.doesNotMatch(pill.label, /billed on your own plan/);

    const throttled = status();
    throttled.ai.limit = { reason: "rate_limited", resets_at: null };
    assert.equal(aiIdentity({ status: throttled, model: null }).sub, "· turning tasks down");
  });
});

describe("runtime — the poller only runs while something is moving", () => {
  type Timer = { fn: () => void; ms: number; id: number };

  function harness(responses: Array<RuntimeStatus | Error>) {
    const timers: Timer[] = [];
    let nextId = 1;
    const seen: RuntimeStatus[] = [];
    const errors: unknown[] = [];
    let hidden = false;
    let index = 0;
    const watcher = createRuntimeWatcher({
      onStatus: (s) => seen.push(s),
      onError: (e) => errors.push(e),
      load: async () => {
        const next = responses[Math.min(index, responses.length - 1)]!;
        index += 1;
        if (next instanceof Error) throw next;
        return next;
      },
      hidden: () => hidden,
      setTimer: (fn, ms) => {
        const id = nextId++;
        timers.push({ fn, ms, id });
        return id;
      },
      clearTimer: (id) => {
        const at = timers.findIndex((t) => t.id === id);
        if (at >= 0) timers.splice(at, 1);
      },
      activeMs: 2000,
      hiddenMs: 30_000,
    });
    return {
      watcher,
      seen,
      errors,
      timers,
      setHidden: (value: boolean) => (hidden = value),
      async fire() {
        const timer = timers.shift();
        timer?.fn();
        await settle();
      },
    };
  }

  const settle = async () => {
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  it("polls every 2s while a blocker is up and stops the moment it clears", async () => {
    const blocked = status({ task_start_available: false, blockers: [blocker("docker_missing")] });
    const h = harness([blocked, blocked, status()]);
    h.watcher.start();
    await settle();
    assert.equal(h.seen.length, 1);
    assert.equal(h.timers[0]?.ms, 2000, "reschedules at the active cadence");

    await h.fire();
    assert.equal(h.seen.length, 2);
    assert.equal(h.timers.length, 1);

    await h.fire();
    assert.equal(h.seen.length, 3);
    assert.equal(h.timers.length, 0, "ready and still: no timer is left running");
    h.watcher.stop();
  });

  it("backs off to 30s while the window is hidden", async () => {
    const blocked = status({ task_start_available: false, blockers: [blocker("docker_missing")] });
    const h = harness([blocked]);
    h.setHidden(true);
    h.watcher.start();
    await settle();
    assert.equal(h.timers[0]?.ms, 30_000);
    h.watcher.stop();
  });

  it("retries with a growing delay when the readiness call fails", async () => {
    const h = harness([new Error("offline")]);
    h.watcher.start();
    await settle();
    assert.equal(h.errors.length, 1);
    assert.equal(h.timers[0]?.ms, 2000);
    await h.fire();
    assert.equal(h.errors.length, 2);
    assert.equal(h.timers[0]?.ms, 4000, "doubles rather than hammering a dead daemon");
    h.watcher.stop();
  });

  it("drops every timer and every late response once stopped", async () => {
    const blocked = status({ task_start_available: false, blockers: [blocker("docker_missing")] });
    const h = harness([blocked, blocked]);
    h.watcher.start();
    await settle();
    const before = h.seen.length;
    h.watcher.stop();
    assert.equal(h.timers.length, 0);
    h.watcher.refresh();
    await settle();
    assert.equal(h.seen.length, before, "refresh after stop is inert");
  });
});
