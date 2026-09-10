/**
 * The readiness ladder the UI polls, and the image-prepare
 * state machine (driven here by a fake spawner — no docker is ever invoked).
 */
import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import {
  BUILD_SPECS,
  LOG_TAIL_MAX,
  buildArgs,
  buildRuntimeStatus,
  compareVersions,
  createImagePreparer,
  childEnv,
  createRuntimeProbe,
  parseImageInspect,
  type BuildSpec,
  type ImageStatus,
  type PrepareState,
  type RuntimeStatus,
} from "../../../src/daemon/runtime.ts";
import { DEFAULT_BROWSER_IMAGE } from "../../../src/sandbox/flags.ts";

const READY_IMAGES: Record<"computer" | "shell" | "proxy", ImageStatus> = {
  computer: { present: true, created_at: "2026-01-01T00:00:00Z", stale: false, stamp: "s" },
  shell: { present: true, created_at: "2026-01-01T00:00:00Z", stale: false, stamp: "s" },
  proxy: { present: true, created_at: "2026-01-01T00:00:00Z", stale: false, stamp: "s" },
};
const IDLE: PrepareState = { state: "idle", step: "", percent: null, log_tail: [], error: null };
const AI_READY: RuntimeStatus["ai"] = {
  provider: "claude",
  cli_found: true,
  cli_path_kind: "well-known",
  logged_in: true,
  detail: "Claude Code is signed in and ready.",
};

function status(over: Partial<Parameters<typeof buildRuntimeStatus>[0]> = {}) {
  return buildRuntimeStatus({
    nodeVersion: "22.18.0",
    docker: { installed: true, running: true, engine: "orbstack", version: "27.1.1" },
    images: READY_IMAGES,
    prepare: IDLE,
    ai: AI_READY,
    taskStartAvailable: true,
    ...over,
  });
}

describe("runtime readiness ladder", () => {
  it("is clear of blockers when node, docker, images and the AI are all ready", () => {
    const s = status();
    assert.deepEqual(s.blockers, []);
    assert.equal(s.task_start_available, true);
    assert.equal(s.node.ok, true);
    assert.equal(s.images.prepare.state, "idle");
  });

  it("orders blockers longest-lead-time first: node, then the container app, then the AI", () => {
    const s = status({
      nodeVersion: "20.11.1",
      docker: { installed: false, running: false, engine: "unknown", version: "" },
      taskStartAvailable: false,
      ai: { provider: null, cli_found: false, cli_path_kind: null, logged_in: null, detail: "" },
    });
    assert.deepEqual(s.blockers.map((b) => b.id), ["node_version", "docker_missing", "ai_not_connected"]);
    assert.equal(s.node.ok, false);
    assert.equal(s.blockers[0]!.action.kind, "open_url");
    assert.match(s.blockers[1]!.action.url ?? "", /orbstack/);
  });

  it("names the installed engine when it is not running, and offers a retry", () => {
    const s = status({ docker: { installed: true, running: false, engine: "docker-desktop", version: "" } });
    assert.deepEqual(s.blockers.map((b) => b.id), ["docker_not_running"]);
    assert.equal(s.blockers[0]!.title, "Start Docker Desktop");
    assert.equal(s.blockers[0]!.action.kind, "retry");
  });

  it("asks for one-time setup when an image is missing or stale, and stops asking while it runs", () => {
    const missing = { ...READY_IMAGES, proxy: { present: false, created_at: null, stale: false, stamp: null } };
    assert.equal(status({ images: missing }).blockers[0]?.id, "images_missing");
    assert.equal(status({ images: missing }).blockers[0]?.action.kind, "prepare_images");

    // An owner who already has a working computer is told it is behind the
    // app, not that setup never happened.
    const stale = { ...READY_IMAGES, shell: { ...READY_IMAGES.shell, stale: true } };
    const staleBlocker = status({ images: stale }).blockers[0];
    assert.equal(staleBlocker?.id, "images_stale");
    assert.equal(staleBlocker?.title, "Its computer needs an update");
    assert.equal(staleBlocker?.action.kind, "prepare_images");

    const running: PrepareState = { state: "running", step: "step", percent: 33, log_tail: [], error: null };
    assert.deepEqual(status({ images: missing, prepare: running }).blockers, []);
    assert.equal(status({ images: missing, prepare: running }).images.prepare.percent, 33);
  });

  it("distinguishes 'no CLI installed' from 'installed but not signed in'", () => {
    const none = status({
      taskStartAvailable: false,
      ai: { provider: null, cli_found: false, cli_path_kind: null, logged_in: null, detail: "" },
    }).blockers[0]!;
    assert.equal(none.title, "Connect Claude or Codex");
    assert.equal(none.action.kind, "open_url");

    const out = status({
      taskStartAvailable: false,
      ai: { ...AI_READY, logged_in: false, detail: "" },
    }).blockers[0]!;
    assert.equal(out.title, "Sign in to Claude Code");
    assert.equal(out.action.kind, "open_settings");
  });

  it("raises a plan limit on a connection that is signed in and refusing", () => {
    const dated = status({
      ai: { ...AI_READY, provider: "codex", limit: { reason: "quota_exhausted", resets_at: "2026-09-11T17:21:00.000Z" } },
    }).blockers[0]!;
    assert.equal(dated.id, "ai_limit_reached");
    assert.equal(dated.title, "Codex plan limit reached");
    assert.equal(dated.action.kind, "open_settings");
    assert.match(dated.detail, /^Codex plan limit reached until .+\. Switch to Claude Code in Settings or wait\.$/);

    // No reset time named: say so rather than inventing one.
    const undated = status({
      ai: { ...AI_READY, limit: { reason: "rate_limited", resets_at: null } },
    }).blockers[0]!;
    assert.equal(undated.id, "ai_limit_reached");
    assert.match(undated.detail, /^Claude Code turned this task down for too many requests\. /);
    assert.match(undated.detail, /Switch to Codex in Settings/);

    // Nothing is connected at all: that is the bigger ask, and it wins.
    const disconnected = status({
      taskStartAvailable: false,
      ai: { ...AI_READY, limit: { reason: "quota_exhausted", resets_at: null } },
    });
    assert.deepEqual(disconnected.blockers.map((b) => b.id), ["ai_not_connected"]);
  });

  it("asks a signed-in CLI to be connected, not to sign in again", () => {
    const claude = status({ taskStartAvailable: false }).blockers[0]!;
    assert.equal(claude.title, "Connect Claude Code");
    assert.equal(claude.action.kind, "open_settings");
    assert.doesNotMatch(claude.detail, /sign in from settings/i);
    assert.match(claude.detail, /is signed in/);

    const codex = status({
      taskStartAvailable: false,
      ai: { ...AI_READY, provider: "codex" },
    }).blockers[0]!;
    assert.equal(codex.title, "Connect Codex");
  });

  it("names the machine without assuming a Mac, and points a server owner at `modelbot start`", () => {
    const s = status({
      nodeVersion: "20.0.0",
      docker: { installed: false, running: false, engine: "unknown", version: "" },
      taskStartAvailable: false,
    });
    for (const b of s.blockers) assert.doesNotMatch(b.detail, /\bMac\b/, b.detail);
    assert.match(s.blockers[0]!.detail, /modelbot start/);
    assert.doesNotMatch(s.blockers[0]!.detail, /open ModelBot again/);
  });

  it("writes blocker copy for a non-technical owner (no daemon/bootstrap/ids, no secrets)", () => {
    const all = [
      status({
        nodeVersion: "20.0.0",
        docker: { installed: false, running: false, engine: "unknown", version: "" },
        taskStartAvailable: false,
        ai: { provider: null, cli_found: false, cli_path_kind: null, logged_in: null, detail: "" },
      }),
      status({ docker: { installed: true, running: false, engine: "colima", version: "" } }),
      status({ images: { ...READY_IMAGES, computer: { present: false, created_at: null, stale: false, stamp: null } } }),
      status({ taskStartAvailable: false, ai: { ...AI_READY, logged_in: false } }),
    ].flatMap((s) => s.blockers);
    assert.ok(all.length >= 5);
    for (const b of all) {
      const text = `${b.title} ${b.detail}`;
      assert.doesNotMatch(text, /daemon|bootstrap|computer_id|localhost|127\.0\.0\.1|token/i, text);
      assert.ok(b.title.length > 0 && b.detail.length > 0);
    }
  });

  it("compares versions numerically", () => {
    assert.equal(compareVersions("22.9.0", "22.18.0") < 0, true);
    assert.equal(compareVersions("24.0.0", "22.18.0") > 0, true);
    assert.equal(compareVersions("22.18.0", "22.18.0"), 0);
  });

  it("parses docker image inspect output, ignoring images that were not found", () => {
    const parsed = parseImageInspect(
      "modelbot/computer:dev|2026-01-01T00:00:00Z|abc123\n\nmodelbot/shell:dev|2026-01-02T00:00:00Z|<no value>\n",
    );
    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed[0]!.tags, ["modelbot/computer:dev"]);
    assert.equal(parsed[0]!.stamp, "abc123");
    assert.equal(parsed[1]!.created, "2026-01-02T00:00:00Z");
    assert.equal(parsed[1]!.stamp, null, "an unstamped image reports no stamp, not '<no value>'");
  });

  it("builds each bundled Dockerfile with the tags sandbox and compose already consume", () => {
    assert.deepEqual(BUILD_SPECS.map((s) => s.dockerfile), [
      "Dockerfile.computer",
      "Dockerfile.shell",
      "Dockerfile.proxy",
    ]);
    // One tag per image: "what prepare builds" and "what the daemon runs" are
    // the same string, and `modelbot/browser:dev` is gone.
    assert.deepEqual(BUILD_SPECS.map((s) => s.tags), [
      ["modelbot/computer:dev"], ["modelbot/shell:dev"], ["modelbot/proxy:dev"],
    ]);
    assert.equal(BUILD_SPECS[0]!.tags[0], DEFAULT_BROWSER_IMAGE, "prepare tags the image flags.ts runs");
    const args = buildArgs(BUILD_SPECS[0]!);
    assert.deepEqual(args.slice(0, 5), [
      "build", "-f", "Dockerfile.computer", "-t", "modelbot/computer:dev",
    ]);
    assert.equal(args.at(-1), ".");
    const label = args[args.indexOf("--label") + 1] ?? "";
    assert.match(label, /^org\.modelbot\.build-stamp=[0-9a-f]{16}$/, "every build stamps the image");
  });
});

describe("image prepare state machine", () => {
  const specs: BuildSpec[] = [
    { image: "computer", dockerfile: "A", tags: ["a"], step: "one" },
    { image: "shell", dockerfile: "B", tags: ["b"], step: "two" },
  ];

  const tick = () => new Promise((r) => setImmediate(r));

  function preparer(codes: number[], lines: string[][] = []) {
    const seen: string[] = [];
    let call = 0;
    const gates: Array<() => void> = [];
    const p = createImagePreparer({
      specs,
      logPath: "/tmp/mb-test/image-build.log",
      runBuild: async (spec, onLine) => {
        const i = call++;
        seen.push(spec.dockerfile);
        for (const line of lines[i] ?? []) onLine(line);
        await new Promise<void>((r) => gates.push(r));
        return codes[i] ?? 0;
      },
    });
    /** Let the next queued build finish, waiting for it to be queued first. */
    const release = async () => {
      for (let i = 0; i < 50 && gates.length === 0; i++) await tick();
      gates.shift()?.();
      await tick();
    };
    return { p, seen, release };
  }

  it("starts idle, reports progress, and finishes done at 100%", async () => {
    const { p, seen, release } = preparer([0, 0]);
    assert.equal(p.snapshot().state, "idle");
    const first = p.start();
    assert.equal(first.started, true);
    assert.equal(p.snapshot().state, "running");
    assert.equal(p.snapshot().percent, 0);
    await release();
    assert.equal(p.snapshot().percent, 50);
    await release();
    await p.settled();
    assert.equal(p.snapshot().state, "done");
    assert.equal(p.snapshot().percent, 100);
    assert.equal(p.snapshot().error, null);
    assert.deepEqual(seen, ["A", "B"]);
  });

  it("refuses a second concurrent run and does not restart the builds", async () => {
    const { p, seen, release } = preparer([0, 0]);
    p.start();
    const second = p.start();
    assert.equal(second.started, false);
    assert.equal(second.state.state, "running");
    await release();
    await release();
    await p.settled();
    assert.deepEqual(seen, ["A", "B"]);
    // Idempotent: a run after the previous one settles is allowed again.
    assert.equal(p.start().started, true);
    await release();
    await release();
    await p.settled();
    assert.deepEqual(seen, ["A", "B", "A", "B"]);
  });

  it("fails on a non-zero build, stops there, and points at the log file", async () => {
    const { p, seen, release } = preparer([1, 0]);
    p.start();
    await release();
    await p.settled();
    const s = p.snapshot();
    assert.equal(s.state, "failed");
    assert.equal(s.percent, null);
    assert.match(s.error ?? "", /\/tmp\/mb-test\/image-build\.log/);
    assert.deepEqual(seen, ["A"]);
  });

  it("keeps only the last 20 output lines", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const { p, release } = preparer([0, 0], [many]);
    p.start();
    const tail = p.snapshot().log_tail;
    assert.equal(tail.length, LOG_TAIL_MAX);
    assert.equal(tail[tail.length - 1], "line 39");
    await release();
    await release();
    await p.settled();
  });
});

describe("runtime probe", () => {
  function probe(over: Record<string, unknown> = {}) {
    const runs: string[][] = [];
    let clock = 1_000_000;
    const p = createRuntimeProbe({
      preparer: { snapshot: () => IDLE, start: () => ({ started: true, state: IDLE }), settled: () => undefined },
      configuredProvider: () => null,
      providerStatus: async () => "signed_in",
      standaloneReady: () => false,
      taskStartAvailable: () => true,
      nodeVersion: "22.18.0",
      now: () => clock,
      stampFor: () => "stamp0",
      resolve: (name: string) =>
        name === "docker"
          ? { name, path: "/usr/local/bin/docker", source: "path" as const }
          : name === "claude"
            ? { name, path: "/opt/homebrew/bin/claude", source: "well-known" as const }
            : null,
      run: async (bin: string, args: string[]) => {
        runs.push([bin, ...args]);
        if (args[0] === "version") return { stdout: "27.1.1|OrbStack\n", stderr: "", code: 0 };
        if (args[0] === "context") return { stdout: "orbstack\n", stderr: "", code: 0 };
        return {
          stdout: "modelbot/computer:dev|2026-01-01T00:00:00Z|stamp0\nmodelbot/shell:dev|2026-01-01T00:00:00Z|stamp0\n",
          stderr: "Error: No such image: modelbot/proxy:dev",
          code: 1,
        };
      },
      ...over,
    });
    return { p, runs, tick: (ms: number) => { clock += ms; } };
  }

  it("reports the engine, the images it found, and the CLI path kind", async () => {
    const { p } = probe();
    const s = await p.snapshot();
    assert.equal(s.docker.installed, true);
    assert.equal(s.docker.running, true);
    assert.equal(s.docker.engine, "orbstack");
    assert.equal(s.docker.version, "27.1.1");
    assert.equal(s.images.computer.present, true);
    assert.equal(s.images.computer.stale, false);
    assert.equal(s.images.proxy.present, false);
    assert.equal(s.ai.provider, "claude");
    assert.equal(s.ai.cli_path_kind, "well-known");
    assert.equal(s.ai.logged_in, true);
    assert.equal(s.blockers[0]?.id, "images_missing");
  });

  it("caches for 2 s so a polling UI is cheap, and re-probes after the TTL", async () => {
    const { p, runs, tick } = probe();
    await p.snapshot();
    const afterFirst = runs.length;
    await p.snapshot();
    assert.equal(runs.length, afterFirst, "second poll inside the TTL must not spawn");
    tick(2001);
    await p.snapshot();
    assert.equal(runs.length, afterFirst * 2);
  });

  it("coalesces concurrent polls into one probe", async () => {
    const { p, runs } = probe();
    await Promise.all([p.snapshot(), p.snapshot(), p.snapshot()]);
    assert.equal(runs.length, 3, "one version + one context + one inspect");
  });

  it("reports docker missing without spawning anything when no binary resolves", async () => {
    const { p, runs } = probe({ resolve: () => null });
    const s = await p.snapshot();
    assert.equal(runs.length, 0);
    assert.equal(s.docker.installed, false);
    assert.equal(s.images.shell.present, false);
    assert.equal(s.ai.cli_found, false);
  });
});

test("a probe or build child never inherits the daemon's secrets", () => {
  const env = childEnv({
    PATH: "/usr/bin", HOME: "/Users/t", DOCKER_HOST: "unix:///x.sock", XDG_RUNTIME_DIR: "/run",
    MODELBOT_TOKEN: "tok", MODELBOT_VAULT_KEY_HEX: "a".repeat(64),
    OPENAI_API_KEY: "sk-live", AWS_SECRET_ACCESS_KEY: "s", GITHUB_TOKEN: "g",
  });
  assert.deepEqual(Object.keys(env).sort(), ["DOCKER_HOST", "HOME", "PATH", "XDG_RUNTIME_DIR"]);
  for (const key of Object.keys(env)) assert.doesNotMatch(key, /TOKEN|KEY|SECRET/i);
  assert.doesNotMatch(JSON.stringify(env), /sk-live|a{64}|tok/);
});

test("a sign-in during the cache TTL drops ai_not_connected on the next read", async () => {
  let clock = 1_000;
  let available = false;
  const probe = createRuntimeProbe({
    preparer: { snapshot: () => IDLE, start: () => ({ started: false, state: IDLE }), settled: () => undefined },
    configuredProvider: () => "claude",
    providerStatus: async () => (available ? "connected" : "signed_out"),
    standaloneReady: () => false,
    taskStartAvailable: () => available,
    now: () => clock,
    ttlMs: 2000,
    nodeVersion: "22.18.0",
    resolve: () => ({ name: "claude", path: "/usr/local/bin/claude", source: "system" }),
    run: async () => ({ stdout: "", stderr: "", code: 1 }),
    dockerfileMtimeMs: () => null,
  });

  const cold = await probe.snapshot();
  assert.ok(cold.blockers.some((b) => b.id === "ai_not_connected"));

  // Sign-in completes 500 ms into a 2000 ms TTL: the cached branch is used.
  available = true;
  clock += 500;
  const warm = await probe.snapshot();
  assert.ok(!warm.blockers.some((b) => b.id === "ai_not_connected"),
    "blockers are derived from live state, not frozen with the cache");
  assert.equal(warm.task_start_available, true);
});

test("buildRuntimeStatus keeps prepare under images", () => {
  const built = buildRuntimeStatus({
    nodeVersion: "22.18.0",
    docker: { installed: false, running: false, engine: "unknown", version: "" },
    images: { computer: { present: false, created_at: null, stale: false },
      shell: { present: false, created_at: null, stale: false },
      proxy: { present: false, created_at: null, stale: false } },
    prepare: IDLE,
    ai: { provider: null, cli_found: false, cli_path_kind: null, logged_in: null, detail: "" },
    taskStartAvailable: false,
  });
  assert.equal(built.images.prepare.state, "idle");
});
