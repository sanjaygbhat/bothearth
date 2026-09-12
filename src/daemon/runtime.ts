/**
 * Runtime readiness ladder behind `GET /api/v1/runtime`, plus the one-shot
 * local image build behind `POST /api/v1/runtime/prepare`.
 *
 * The home screen is the task box; nothing here gates opening the app. The UI
 * polls this every 2 s and shows `blockers[0]` only when a task cannot start,
 * so every probe is cached for `ttlMs` and concurrent polls are coalesced.
 *
 * Blocker copy is read by a non-technical owner: no "daemon", no "bootstrap",
 * no identifiers. Order is longest-lead-time first — a container runtime is a
 * multi-minute download, signing in to Claude Code takes seconds — so the slow
 * step is surfaced before the fast one.
 */

import { createWriteStream, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { decideRuntime, type ProbeResult } from "../sandbox/detect.ts";
import {
  DEFAULT_BROWSER_IMAGE,
  DEFAULT_PROXY_IMAGE,
  DEFAULT_SHELL_IMAGE,
} from "../sandbox/flags.ts";
import { BUILD_STAMP_LABEL, buildStamp } from "./build-stamp.ts";
import type { ProviderLimit } from "./provider-limit.ts";
import { resolveTool, toolPath, type ResolvedTool } from "./resolve-tool.ts";
import { logError, logInfo } from "./log.ts";

const MIN_NODE_VERSION = "22.18.0";
export const ORBSTACK_URL = "https://orbstack.dev/download";
const NODE_URL = "https://nodejs.org/en/download";
const CLAUDE_CODE_URL = "https://code.claude.com/docs/en/overview";

/** Package root: holds Dockerfile.* in both `src/daemon` and `dist/daemon` layouts. */
const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export type ImageName = "computer" | "shell" | "proxy";

export interface BuildSpec {
  image: ImageName;
  dockerfile: string;
  /** Tag(s) this build produces; the first is the one readiness reports on. */
  tags: string[];
  /** Plain-English progress line. */
  step: string;
}

/**
 * One tag per image, and the tag is the same constant `src/sandbox/flags.ts`
 * hands `docker create`. This list used to tag the browser computer
 * twice (`modelbot/computer:dev` *and* `modelbot/browser:dev`), and the config
 * default named the second one — so "the image prepare builds" and "the image
 * the daemon runs" were two strings that could drift apart, and did.
 */
export const BUILD_SPECS: readonly BuildSpec[] = [
  {
    image: "computer",
    dockerfile: "Dockerfile.computer",
    tags: [DEFAULT_BROWSER_IMAGE],
    step: "Building the browser workspace (1 of 3)",
  },
  {
    image: "shell",
    dockerfile: "Dockerfile.shell",
    tags: [DEFAULT_SHELL_IMAGE],
    step: "Building the command workspace (2 of 3)",
  },
  {
    image: "proxy",
    dockerfile: "Dockerfile.proxy",
    tags: [DEFAULT_PROXY_IMAGE],
    step: "Building the network guard (3 of 3)",
  },
] as const;

/**
 * The environment a probe or `docker build` child gets. The daemon's own
 * environment carries `MODELBOT_TOKEN` and `MODELBOT_VAULT_KEY_HEX` (and any
 * provider key resolved into it); a child needs none of that, and `docker`
 * echoes its environment into build logs and `inspect` output. Allowlist, so a
 * secret added to the daemon later is excluded by default.
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "LD_LIBRARY_PATH"]);
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (keep.has(key) || key.startsWith("DOCKER_") || key.startsWith("XDG_") || key.startsWith("COLIMA_")) {
      out[key] = value;
    }
  }
  return out;
}

export function buildArgs(spec: BuildSpec, root: string = PACKAGE_ROOT): string[] {
  return [
    "build",
    "-f",
    spec.dockerfile,
    ...spec.tags.flatMap((t) => ["-t", t]),
    "--label",
    `${BUILD_STAMP_LABEL}=${buildStamp(spec.image, root)}`,
    ".",
  ];
}

export type PrepareStateName = "idle" | "running" | "done" | "failed";

export interface PrepareState {
  state: PrepareStateName;
  step: string;
  percent: number | null;
  log_tail: string[];
  error: string | null;
}

export const LOG_TAIL_MAX = 20;

export interface PrepareDeps {
  /**
   * Runs one build. Must resolve with the exit code and must never reject for
   * a build failure. `onLine` receives each output line already trimmed.
   */
  runBuild(spec: BuildSpec, onLine: (line: string) => void): Promise<number>;
  specs?: readonly BuildSpec[];
  /** Shown in the failure message so the owner can find the full output. */
  logPath: string;
}

export interface ImagePreparer {
  snapshot(): PrepareState;
  /** `started:false` when a run is already in flight (HTTP 409). */
  start(): { started: boolean; state: PrepareState };
  /** Resolves when the in-flight run settles; undefined when idle. */
  settled(): Promise<void> | undefined;
}

export function createImagePreparer(deps: PrepareDeps): ImagePreparer {
  const specs = deps.specs ?? BUILD_SPECS;
  let state: PrepareStateName = "idle";
  let step = "";
  let percent: number | null = null;
  let error: string | null = null;
  let tail: string[] = [];
  let running: Promise<void> | undefined;

  const push = (line: string) => {
    if (!line) return;
    tail.push(line);
    if (tail.length > LOG_TAIL_MAX) tail = tail.slice(-LOG_TAIL_MAX);
  };

  function snapshot(): PrepareState {
    return { state, step, percent, log_tail: [...tail], error };
  }

  async function run(): Promise<void> {
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]!;
      step = spec.step;
      percent = Math.round((i / specs.length) * 100);
      const code = await deps.runBuild(spec, push).catch((err: unknown) => {
        push(String(err));
        return 1;
      });
      if (code !== 0) {
        state = "failed";
        error =
          `Setting up the ${spec.image} workspace did not finish. ` +
          `Make sure the container app is running and there is disk space free, then try again. ` +
          `Full output: ${deps.logPath}`;
        percent = null;
        return;
      }
    }
    state = "done";
    step = "Workspaces ready";
    percent = 100;
    error = null;
  }

  function start(): { started: boolean; state: PrepareState } {
    if (running) return { started: false, state: snapshot() };
    state = "running";
    step = specs[0]?.step ?? "";
    percent = 0;
    error = null;
    tail = [];
    running = run()
      .catch((err: unknown) => {
        state = "failed";
        percent = null;
        error = `Workspace setup stopped unexpectedly. Full output: ${deps.logPath}`;
        logError("runtime prepare crashed", { err: String(err) });
      })
      .finally(() => {
        running = undefined;
      });
    return { started: true, state: snapshot() };
  }

  return { snapshot, start, settled: () => running };
}

/** Real builder: streams `docker build` output to `logPath`, never to a response. */
export function createDockerBuildRunner(opts: {
  logPath: string;
  cwd?: string;
  binary?: string;
}): PrepareDeps["runBuild"] {
  return async (spec, onLine) =>
    await new Promise<number>((resolve) => {
      mkdirSync(dirname(opts.logPath), { recursive: true });
      const log = createWriteStream(opts.logPath, { flags: "a", mode: 0o600 });
      log.write(`\n=== ${new Date().toISOString()} ${spec.dockerfile} ===\n`);
      const child = spawn(opts.binary ?? toolPath("docker"), buildArgs(spec), {
        cwd: opts.cwd ?? PACKAGE_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv(),
      });
      let pending = "";
      const onChunk = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        log.write(text);
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) onLine(line.trim());
      };
      child.stdout.on("data", onChunk);
      child.stderr.on("data", onChunk);
      child.on("error", (err) => {
        log.write(`spawn failed: ${String(err)}\n`);
        log.end();
        onLine(String(err));
        resolve(127);
      });
      child.on("close", (code) => {
        if (pending.trim()) onLine(pending.trim());
        log.end();
        resolve(code ?? 1);
      });
    });
}

export type DockerEngine = "docker-desktop" | "orbstack" | "colima" | "unknown";

export interface ImageStatus {
  present: boolean;
  created_at: string | null;
  /** True when the image predates the daemon's own build inputs. */
  stale: boolean;
  /** Stamp baked into the image, or null for an image built before stamping. */
  stamp: string | null;
}

export interface RuntimeBlocker {
  id: string;
  title: string;
  detail: string;
  action: { kind: "open_url" | "open_settings" | "prepare_images" | "retry"; url?: string };
}

export interface RuntimeStatus {
  node: { ok: boolean; version: string };
  docker: { installed: boolean; running: boolean; engine: DockerEngine; version: string };
  images: Record<ImageName, ImageStatus> & { prepare: PrepareState };
  ai: {
    provider: "claude" | "codex" | null;
    cli_found: boolean;
    cli_path_kind: "path" | "well-known" | null;
    logged_in: boolean | null;
    detail: string;
    /**
     * Set when the provider is signed in but refusing work. `logged_in` stays
     * true because it is: the sign-in is fine, the plan is not.
     */
    limit?: ProviderLimit | null;
  };
  task_start_available: boolean;
  blockers: RuntimeBlocker[];
}

export interface RuntimeDeps {
  preparer: ImagePreparer;
  /** Which provider the owner has configured, if any. */
  configuredProvider(): "claude" | "codex" | null;
  /** Existing connection probe: "connected" | "signed_in" | "signed_out" | "missing" | "error" | "unknown". */
  providerStatus(provider: "claude" | "codex"): Promise<string>;
  /** Native CLIs are bundled in the virtual computer, so no host installation is required. */
  nativeInComputer?(): boolean;
  /** A refusal this provider gave a task, while it lasts. */
  providerLimit?(provider: "claude" | "codex"): ProviderLimit | null;
  /** True when a model AND its credential are configured for direct API use. */
  standaloneReady(): boolean;
  /** Authoritative flag the rest of the daemon uses to gate task creation. */
  taskStartAvailable(): boolean;
  /** The computer's own words when its browser will not start, else null. */
  browserUnavailable?(): string | null;
  now?(): number;
  ttlMs?: number;
  nodeVersion?: string;
  resolve?(name: string): ResolvedTool | null;
  run?(bin: string, args: string[]): Promise<ProbeResult>;
  /** Content stamp of an image's build inputs; overridable for tests. */
  stampFor?(image: ImageName): string;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * `{"RepoTags":…}`-free parse of `docker image inspect --format`. One line per
 * found image, `tags|created|stamp`. The stamp column is empty for an image
 * built before stamping existed, which is itself the signal that it is stale.
 */
export function parseImageInspect(
  stdout: string,
): Array<{ tags: string[]; created: string; stamp: string | null }> {
  const out: Array<{ tags: string[]; created: string; stamp: string | null }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("|");
    if (parts.length < 2) continue;
    const tags = (parts[0] ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const created = (parts[1] ?? "").trim();
    const rawStamp = (parts[2] ?? "").trim();
    // Docker prints `<no value>` for a label the image does not carry.
    const stamp = rawStamp && rawStamp !== "<no value>" ? rawStamp : null;
    if (created) out.push({ tags, created, stamp });
  }
  return out;
}

function defaultRun(bin: string, args: string[]): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(toolPath(bin), args, { stdio: ["ignore", "pipe", "pipe"], env: childEnv() });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: String(e), code: 127 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code: code ?? 1,
      });
    });
  });
}

const ENGINE_LABEL: Record<DockerEngine, string> = {
  "docker-desktop": "Docker Desktop",
  orbstack: "OrbStack",
  colima: "Colima",
  unknown: "your container app",
};

/** Assemble the ladder from already-collected probe results. Pure — unit tested directly. */
export function buildRuntimeStatus(input: {
  nodeVersion: string;
  docker: { installed: boolean; running: boolean; engine: DockerEngine; version: string };
  images: Record<ImageName, ImageStatus>;
  prepare: PrepareState;
  ai: RuntimeStatus["ai"];
  taskStartAvailable: boolean;
  browserUnavailable?: string | null;
}): RuntimeStatus {
  const nodeOk = compareVersions(input.nodeVersion, MIN_NODE_VERSION) >= 0;
  const blockers: RuntimeBlocker[] = [];

  if (!nodeOk) {
    blockers.push({
      id: "node_version",
      title: "Update Node",
      detail:
        `BotHearth needs Node ${MIN_NODE_VERSION} or newer to run. This machine has ${input.nodeVersion}. ` +
        `Install the current version, then run \`modelbot start\` again.`,
      action: { kind: "open_url", url: NODE_URL },
    });
  }

  if (!input.docker.installed) {
    blockers.push({
      id: "docker_missing",
      title: "Give BotHearth its own computer",
      detail:
        "BotHearth uses a separate computer with a workspace folder on this machine. " +
        "Install a supported container runtime to set it up. Browser tasks need several GB of memory and disk space.",
      action: { kind: "open_url", url: ORBSTACK_URL },
    });
  } else if (!input.docker.running) {
    blockers.push({
      id: "docker_not_running",
      title: `Start ${ENGINE_LABEL[input.docker.engine]}`,
      detail:
        `${ENGINE_LABEL[input.docker.engine]} is installed but not running yet. Open it and leave it running — ` +
        `BotHearth will carry on by itself as soon as it is up.`,
      action: { kind: "retry" },
    });
  } else {
    // Not `Object.keys`: a cached snapshot is reassembled from the published
    // `images` map, which carries a `prepare` key that is not an image. Reading
    // it as one made every cached poll claim setup had never run.
    const names: ImageName[] = ["computer", "shell", "proxy"];
    const missing = names.filter((name) => !input.images[name].present);
    const stale = names.filter((name) => input.images[name].present && input.images[name].stale);
    if (missing.length > 0 && input.prepare.state !== "running") {
      blockers.push({
        id: "images_missing",
        title: "Finish one-time setup",
        detail:
          "BotHearth still needs to build the private computer it works in. This happens once, takes a few minutes, " +
          "and runs entirely on this machine.",
        action: { kind: "prepare_images" },
      });
    } else if (stale.length > 0 && input.prepare.state !== "running") {
      // Distinct from first-run setup on purpose: this owner already has a
      // working computer, and the honest thing to say is that it is behind the
      // app, not that setup never happened.
      blockers.push({
        id: "images_stale",
        title: "Its computer needs an update",
        detail:
          "This version of BotHearth can do things the private computer on this machine was not built with yet. " +
          "Updating it takes a few minutes and runs entirely on this machine. Until then some tasks will be turned down.",
        action: { kind: "prepare_images" },
      });
    }
  }

  // A task without a browser can only fail, so it is not startable, whatever
  // the AI connection says.
  if (input.browserUnavailable) {
    blockers.push({
      id: "browser_unavailable",
      title: "Its browser will not start",
      detail:
        "The private computer on this machine is running, but the browser inside it will not open, so there is " +
        `nothing for a task to work in. BotHearth keeps trying. ${input.browserUnavailable}`,
      action: { kind: "retry" },
    });
  }

  if (!input.taskStartAvailable) {
    blockers.push(aiBlocker(input.ai));
  } else if (input.ai.limit) {
    const copy = limitCopy(input.ai.provider, input.ai.limit);
    blockers.push({ id: "ai_limit_reached", ...copy, action: { kind: "open_settings" } });
  }

  return {
    node: { ok: nodeOk, version: input.nodeVersion },
    docker: input.docker,
    images: { ...input.images, prepare: input.prepare },
    ai: input.ai,
    task_start_available: input.taskStartAvailable && !input.browserUnavailable,
    blockers,
  };
}

/**
 * Three distinct asks, not two. A CLI that is signed in and still blocking is
 * one BotHearth has not been pointed at yet; telling that owner to sign in
 * again reads as a bug, so it gets its own copy. The id stays
 * `ai_not_connected` for all three — it names the blocker, and the UI routes
 * the AI card on it.
 */
function aiBlocker(ai: RuntimeStatus["ai"]): RuntimeBlocker {
  if (!ai.cli_found) {
    return {
      id: "ai_not_connected",
      title: "Connect Claude or Codex",
      detail:
        "No supported model CLI was found on " +
        "this host. Install a supported CLI, then connect it in Settings.",
      action: { kind: "open_url", url: CLAUDE_CODE_URL },
    };
  }
  const app = ai.provider === "codex" ? "Codex" : "Claude Code";
  if (ai.logged_in) {
    return {
      id: "ai_not_connected",
      title: `Connect ${app}`,
      detail:
        `${app} is signed in. Connect it in Settings to use it for tasks.`,
      action: { kind: "open_settings" },
    };
  }
  return {
    id: "ai_not_connected",
    title: `Sign in to ${app}`,
    detail:
      `Sign in to ${app} from Model connection in Settings.`,
    action: { kind: "open_settings" },
  };
}

/**
 * Copy for a provider that is signed in and refusing. It says what happened,
 * when it ends if the provider said, and the one thing the owner can do now —
 * the other app is already installed for most of them, and switching is a
 * Settings trip rather than a wait.
 */
function limitCopy(
  provider: RuntimeStatus["ai"]["provider"],
  limit: ProviderLimit,
): { title: string; detail: string } {
  const app = provider === "codex" ? "Codex" : "Claude Code";
  const other = provider === "codex" ? "Claude Code" : "Codex";
  const until = limit.resets_at
    ? ` until ${new Date(limit.resets_at).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })}`
    : "";
  return limit.reason === "quota_exhausted"
    ? {
        title: `${app} plan limit reached`,
        detail: `${app} plan limit reached${until}. Switch to ${other} in Settings or wait.`,
      }
    : {
        title: `${app} is turning tasks down`,
        detail:
          `${app} turned this task down for too many requests${until}. ` +
          `Switch to ${other} in Settings, or wait a minute and start it again.`,
      };
}

export interface RuntimeProbe {
  snapshot(): Promise<RuntimeStatus>;
  /** Drop the cache so the next poll re-probes (used after a prepare run). */
  invalidate(): void;
  /** Docker engine liveness only — no image inspect, no AI/provider. */
  dockerLive(): Promise<boolean>;
}

export function createRuntimeProbe(deps: RuntimeDeps): RuntimeProbe {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? 2000;
  const run = deps.run ?? defaultRun;
  const resolve = deps.resolve ?? ((name: string) => resolveTool(name));
  const stampFor = deps.stampFor ?? ((image: ImageName) => buildStamp(image, PACKAGE_ROOT));
  let cached: { at: number; value: RuntimeStatus } | undefined;
  let inflight: Promise<RuntimeStatus> | undefined;

  async function probeDocker(): Promise<RuntimeStatus["docker"]> {
    const docker = resolve("docker");
    const podman = docker ? null : resolve("podman");
    const binary = docker ? "docker" : podman ? "podman" : null;
    if (!binary) return { installed: false, running: false, engine: "unknown", version: "" };
    // One `version` call answers running + server version + engine flavour.
    const version = await run(binary, ["version", "--format", "{{.Server.Version}}|{{.Server.Platform.Name}}"]);
    const running = version.code === 0;
    const [serverVersion = "", platform = ""] = version.stdout.trim().split("|");
    const context = running ? await run(binary, ["context", "show"]) : { stdout: "", stderr: "", code: 1 };
    const decided = decideRuntime({
      dockerOk: running,
      dockerInfo: platform || undefined,
      contextShow: context.code === 0 ? context.stdout : undefined,
      podmanOk: Boolean(podman) && running,
    });
    const engine: DockerEngine =
      decided?.kind === "orbstack"
        ? "orbstack"
        : decided?.kind === "colima"
          ? "colima"
          : decided?.kind === "docker"
            ? "docker-desktop"
            : "unknown";
    return { installed: true, running, engine, version: serverVersion };
  }

  async function probeImages(
    binary: string | null,
    running: boolean,
  ): Promise<Record<ImageName, ImageStatus>> {
    const blank: ImageStatus = { present: false, created_at: null, stale: false, stamp: null };
    const images: Record<ImageName, ImageStatus> = {
      computer: { ...blank },
      shell: { ...blank },
      proxy: { ...blank },
    };
    if (!binary || !running) return images;
    const refs = BUILD_SPECS.map((s) => s.tags[0]!);
    const result = await run(binary, [
      "image",
      "inspect",
      ...refs,
      "--format",
      `{{join .RepoTags ","}}|{{.Created}}|{{index .Config.Labels "${BUILD_STAMP_LABEL}"}}`,
    ]);
    const found = parseImageInspect(result.stdout);
    for (const spec of BUILD_SPECS) {
      const hit = found.find((f) => f.tags.some((t) => spec.tags.includes(t)));
      if (!hit) continue;
      images[spec.image] = {
        present: true,
        created_at: hit.created,
        stamp: hit.stamp,
        // An unstamped image was built before the daemon knew how to check, so
        // it cannot be shown to match: treat unknown as stale rather than
        // advertising tools it may not have.
        stale: hit.stamp !== stampFor(spec.image),
      };
    }
    return images;
  }

  async function probeAi(): Promise<RuntimeStatus["ai"]> {
    const configured = deps.configuredProvider();
    if (deps.nativeInComputer?.()) {
      const provider = configured ?? "codex";
      const status = await deps.providerStatus(provider);
      const logged_in = status === "connected" || status === "signed_in";
      return { provider, cli_found: status !== "missing", cli_path_kind: null, logged_in,
        detail: logged_in ? "Signed in on your virtual computer." : "Connect your model account on your virtual computer.",
        limit: logged_in ? deps.providerLimit?.(provider) ?? null : null };
    }
    const claude = resolve("claude");
    const codex = resolve("codex");
    const provider = configured ?? (claude ? "claude" : codex ? "codex" : null);
    const found = provider === "codex" ? codex : provider === "claude" ? claude : null;
    const cli_path_kind = found ? (found.source === "well-known" ? "well-known" : "path") : null;
    if (!provider) {
      return {
        provider: null,
        cli_found: false,
        cli_path_kind: null,
        logged_in: null,
        detail: deps.standaloneReady()
          ? "Using the model key you configured."
          : "No Claude Code or Codex app found on this machine.",
      };
    }
    const status = found ? await deps.providerStatus(provider) : "missing";
    const logged_in = status === "connected" || status === "signed_in";
    const limit = logged_in ? (deps.providerLimit?.(provider) ?? null) : null;
    const app = provider === "codex" ? "Codex" : "Claude Code";
    const detail = !found
      ? `${app} is not installed on this machine.`
      : limit
        ? limitCopy(provider, limit).detail
        : logged_in
          ? `${app} is signed in and ready.`
          : status === "signing_in"
            ? `Finishing sign-in to ${app}…`
            : `${app} is installed but not signed in.`;
    return { provider, cli_found: Boolean(found), cli_path_kind, logged_in, detail, limit };
  }

  function assemble(
    docker: RuntimeStatus["docker"],
    images: Record<ImageName, ImageStatus>,
    ai: RuntimeStatus["ai"],
  ): RuntimeStatus {
    return buildRuntimeStatus({
      nodeVersion: deps.nodeVersion ?? process.versions.node,
      docker,
      images,
      prepare: deps.preparer.snapshot(),
      ai,
      taskStartAvailable: deps.taskStartAvailable(),
      browserUnavailable: deps.browserUnavailable?.() ?? null,
    });
  }

  async function collect(): Promise<RuntimeStatus> {
    const docker = await probeDocker();
    const binary = docker.installed ? (resolve("docker") ? "docker" : "podman") : null;
    const [images, ai] = await Promise.all([probeImages(binary, docker.running), probeAi()]);
    // probeAi() has already refreshed the connection, so taskStartAvailable reads fresh.
    return assemble(docker, images, ai);
  }

  return {
    invalidate() {
      cached = undefined;
    },
    async dockerLive(): Promise<boolean> {
      const docker = await probeDocker();
      return docker.running;
    },
    async snapshot(): Promise<RuntimeStatus> {
      if (cached && now() - cached.at < ttlMs) {
        // The prepare state machine and the AI connection both move faster than
        // the cache, and `blockers` is derived from them — returning the cached
        // list left `ai_not_connected` on screen for a whole TTL after a sign-in
        // completed, and dropped `images_missing` late after a build.
        return assemble(cached.value.docker, cached.value.images, cached.value.ai);
      }
      if (inflight) return await inflight;
      inflight = collect()
        .then((value) => {
          cached = { at: now(), value };
          return value;
        })
        .catch((err: unknown) => {
          logInfo("runtime probe failed", { err: String(err) });
          throw err;
        })
        .finally(() => {
          inflight = undefined;
        });
      return await inflight;
    },
  };
}
