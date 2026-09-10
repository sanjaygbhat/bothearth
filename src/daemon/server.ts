import { homedir } from "node:os";
import { createCodexConnection, type CodexLoginOptions } from "./codex-connection.ts";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { constants, existsSync, statSync } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { AddressInfo } from "node:net";
import type {
  ApprovalDecision,
  ComputerCapability,
  CreateComputerBody,
  CreateHarnessBindingBody,
  CreateTaskBody,
  DriverKind,
  Driver,
  NativeProvider,
  NativeTaskSettings,
  EventType,
  ProviderAdapter,
  SandboxRuntime,
  ToolName,
  ToolResult,
  UiEvent,
} from "../types/contracts.ts";
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  checkApiOrigin,
  checkHost,
  checkMcpOrigin,
  clearSessionCookieHeader,
  canonicalHttpsOrigin,
  deviceId,
  isMcpToken,
  parseCookies,
  sessionCookieHeader,
} from "./auth.ts";
import { EventBus, makeEvent } from "./events.ts";
import { logError, logInfo } from "./log.ts";
import { harnessCapReason, MAX_TASK_ORIGIN_GRANTS, RECEIPT_REPAIR_VERSION, STALE_TAKEOVER_VERSION, Store, type TaskRow, type ComputerRow, takeoverEpochFromData, isTakeoverPending } from "./store.ts";
import {
  acceptWebSocket,
  rejectUpgrade,
  writeJson,
  type WsSocket,
} from "./ws.ts";
import {
  createDefaultSandbox,
  createFakeComputerClient,
  openComputerClient,
  useFakeComputer,
  type ComputerClient,
} from "../computer-client/index.ts";
import { durableStateAfterRelease, toWireState } from "../protocol/takeover.ts";
import { toolError } from "../protocol/errors.ts";
import { encodeLiveFrame, type LiveModeMsg } from "../protocol/live.ts";
import {
  createMcpHttpHandler,
  type McpServerOptions,
  type McpToolBackend,
} from "../mcp/index.ts";
import { DEFAULT_MAX_STEPS, DEFAULT_SPEND_CAP_MAX_USD, DEFAULT_SPEND_CAP_USD, browserUnavailableDetail, maxRuntimeStopDetail, maxStepsStopDetail, runAgentLoop, spendCapStopDetail, type AgentLoopOptions } from "./agent-loop.ts";
import { taskActivity, taskBudget, taskResult, takeoverContext } from "./task-view.ts";
import { MAX_RUNTIME_STOP, runCodexTask, type CodexRunnerConfig } from "./codex-runner.ts";
import { getNativeModelCatalog, resolveNativeTaskSettings } from "./native-models.ts";
import { GUEST_CLAUDE_HOME, GUEST_CODEX_HOME, guestSpawn, setGuestComputerPaused } from "./guest-native.ts";
import { activateLicence, licenceState, type LicencePolicy } from "./licence.ts";
import {
  createA11yDriver,
  createHybridDriver,
  createVisionDriver,
} from "../drivers/index.ts";
import { startRoutines } from "./routines.ts";
import {
  ConnectorBroker,
  type ConnectorConfig,
  type ConnectorPublicView,
} from "./connectors.ts";
import type { Vault } from "../vault/types.ts";
import { AuditLog } from "../audit/log.ts";
import { persistedAuditKey } from "../audit/key.ts";
import { createToolDispatcher, enforceHarnessMcpSpendCap, recordTakeover } from "./dispatcher.ts";
import { approvalGrantOrigins, decideApproval as decideBoundApproval } from "../policy/approvals.ts";
import type { ApprovalBind, ApprovalRequest, ApprovalStatus } from "../types/contracts.ts";
import { createUiStaticHandler } from "../ui/static.ts";
import { TOOL_CATALOGUE } from "../tools/catalog.ts";
import { createIdlePauseController } from "../sandbox/idle-pause.ts";
import { pauseComputer, unpauseComputer } from "../sandbox/lifecycle.ts";
import {
  createDockerBuildRunner,
  createImagePreparer,
  createRuntimeProbe,
  type RuntimeStatus,
} from "./runtime.ts";
import { classifyFailureKind, classifyProviderLimit, createProviderLimits, providerLimitFields, type FailureKind } from "./provider-limit.ts";
import { resolveTool } from "./resolve-tool.ts";

export interface StandaloneAgentConfig {
  /** Default plus optional named adapters selected by CreateTaskBody.adapter. */
  adapter: ProviderAdapter;
  adapters?: Record<string, ProviderAdapter>;
  model: string;
  models?: Record<string, string>;
  /**
   * False when the configured model has no usable credential (fresh install:
   * the shipped example config names a model but ships no key). Standalone
   * execution — and `task_start_available` — stay off until this is true.
   * Undefined keeps the in-process test default of "credentialed".
   */
  credentialed?: boolean;
  spendCapUsd?: number;
  loopIdentical?: number;
  stallSec?: number;
  snapshotMaxBytes?: number;
  compactAfterSteps?: number;
  contextMaxBytes?: number;
  compactAt?: number;
  contextTokensMax?: number;
  tokenCapIn?: number | null;
  declaredOrigins?: AgentLoopOptions["declaredOrigins"];
  mode?: AgentLoopOptions["mode"];
  policyGate?: AgentLoopOptions["policyGate"];
  stopAndAsk?: AgentLoopOptions["stopAndAsk"];
  createDriver?: (kind: DriverKind, computer: ComputerClient) => Driver;
}
export interface DaemonOptions {
  host?: string;
  port?: number;
  /** In-process route tests can exercise the HTTP listener without opening a socket. */
  listen?: boolean;
  schedulerEnabled?: boolean;
  allowPublicBind?: boolean;
  mcpToken: string;
  bootstrapToken: string;
  sqlitePath?: string;
  workspaceRoot?: string;
  sandbox?: SandboxRuntime & {
    start?(computerId: string): Promise<void>;
    refreshImage?(computerId: string, capabilities: ComputerCapability[]): Promise<boolean>;
    get?(computerId: string): { workspaceRoot?: string } | undefined;
  };
  allowedHosts?: string[];
  /** Canonical HTTPS proxy origin; transport stays on loopback. */
  publicOrigin?: string;
  /** A host without a local browser, including an SSH-only VM. */
  headless?: boolean;
  /** Enables standalone execution for tasks created through `POST /api/v1/tasks`. */
  agentLoop?: StandaloneAgentConfig;
  /** Explicit opt-in to the existing Codex login; never inferred from installed binaries. */
  codexRunner?: CodexRunnerConfig;
  /** Native login executable/home; credentials remain owned by Codex. */
  codexLogin?: CodexLoginOptions;
  claudeLogin?: CodexLoginOptions;
  /** The application runs new native sessions in its computer. Host is for legacy integrations. */
  nativeExecutionLocation?: "computer" | "host";
  licencePolicy?: LicencePolicy;
  /** Pre-built connector broker (tests). */
  connectorBroker?: ConnectorBroker;
  /** Or configs (+ optional vault) to build a broker under workspaceRoot. */
  connectorConfigs?: ConnectorConfig[];
  vault?: Vault;
  auditLog?: AuditLog;
  mode?: "supervised" | "strict";
  declaredOrigins?: AgentLoopOptions["declaredOrigins"];
  /** Minutes of no tool/resume activity before `pauseComputer`. 0 disables. Default 10. */
  idlePauseMin?: number;
  /** Harness budget proxy only; this is not measured provider spend. Default $0.01/call. */
  mcpToolCallProxyUsd?: number;
  /** Schema `policy.approval_ttl_sec`. Seconds an approval stays answerable. */
  approvalTtlSec?: number;
  /** Schema `takeover.ttl_sec`. Seconds of human control per grant, renewed by each relayed input. */
  takeoverTtlSec?: number;
  /** Schema `agent.max_steps`. Steps a task gets when the request names none. */
  maxSteps?: number;
  /** Schema `agent.spend_cap_max_usd`. The most a request or a resume may ask for. */
  spendCapMaxUsd?: number;
  /**
   * Schema `agent.max_runtime_sec`. Seconds of wall clock one run may take
   * before it PAUSES; 0 (the default) means a task runs until it is done, out
   * of budget, out of steps, or stopped. Never a failure cause.
   */
  maxRuntimeSec?: number;
  /** Where the image-build log is written. Defaults beside `sqlitePath`. */
  dataDir?: string;
  /**
   * Adopt an already-signed-in Claude Code / Codex CLI when the owner has not
   * configured a provider. Off by default so in-process tests never pick up a
   * CLI that happens to be installed on the machine running them.
   */
  autoConnectProvider?: boolean;
}

const DEFAULT_MCP_TOOL_CALL_PROXY_USD = 0.01;
const DEFAULT_TAKEOVER_TTL_SEC = 600;
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

class RequestBodyTooLargeError extends Error {}

/**
 * Accept only input from the current HUMAN lease, sent by the device that took
 * it. Never promote stale input to a newer takeover epoch, including input
 * delayed behind another action. Ownership is checked here rather than in the
 * UI: a second authenticated tab could otherwise type into a computer someone
 * else is driving.
 */
export function validateLiveRelayFrame(
  store: Store,
  computerId: string,
  msg: Record<string, unknown>,
  device: string,
): Record<string, unknown> | null {
  const takeover = store.activeTakeoverForComputer(computerId);
  if (takeover?.state !== "human" || !takeover.expires_at || Date.parse(takeover.expires_at) <= Date.now()) return null;
  if (takeover.granted_to !== device) return null;
  if (!Number.isSafeInteger(msg.epoch) || (msg.epoch as number) <= 0 || msg.epoch !== takeover.epoch) return null;
  return msg;
}

export async function restoreTakeoverExpiries(
  store: Store,
  schedule: (takeoverId: string) => void,
  expire: (takeoverId: string) => Promise<void>,
  nowMs = Date.now(),
): Promise<void> {
  for (const takeover of store.listTakeovers()) {
    if (
      takeover.state !== "takeover_requested" &&
      takeover.state !== "human" &&
      takeover.state !== "resume_validating"
    ) continue;
    if (!store.getComputer(takeover.computer_id)) {
      store.updateTakeoverState(takeover.id, "terminated");
      continue;
    }
    // An unanswered question has no deadline, so nothing expires it.
    if (!takeover.expires_at) continue;
    if (Date.parse(takeover.expires_at) > nowMs) schedule(takeover.id);
    else await expire(takeover.id);
  }
}

/**
 * `Content-Disposition` for a workspace file. The path comes from the query
 * string, so the filename is reduced to its last segment and encoded per RFC
 * 5987 — a header value can never carry a quote, a newline, or a directory.
 */
export function contentDisposition(rel: string): string {
  const base = rel.split(/[\\/]/).pop() ?? "";
  const safe = base.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}

/**
 * Is the file a receipt names actually there?
 *
 * The receipt records the path `GET /api/v1/computers/:id/files` serves by —
 * relative to the computer's workspace — but older rows carry the
 * container-absolute `/workspace/…` form, and some carry a bare filename
 * so all three shapes are resolved against the same jail that route
 * enforces. A workspace directory that is not there at all means "cannot
 * tell", and an unverifiable entry is KEPT: erasing a true record because a
 * disk was unmounted is the worse lie.
 *
 * Deliberately synchronous — one `stat` of a handful of paths, on a route that
 * already awaits more than this costs.
 */
export function artifactOnDisk(workspace: string, rel: string): boolean {
  if (!rel || rel.includes("\0")) return false;
  if (!existsSync(workspace)) return true;
  const root = resolve(workspace);
  const stripped = rel.replace(/^\/+workspace\/+/, "");
  const base = stripped.split(/[\\/]/).pop() ?? "";
  for (const candidate of [stripped, base && join("out", base)]) {
    if (!candidate) continue;
    const target = resolve(root, candidate);
    if (target !== root && !target.startsWith(root + sep)) continue;
    if (statSync(target, { throwIfNoEntry: false })?.isFile()) return true;
  }
  return false;
}

/**
 * The same task record with every artifact it offers proved to exist. Marks the
 * summary `repaired` when it had to drop one, which is what tells the UI that
 * this list — not anything the live feed still remembers — is the whole truth.
 * The stat results are cached for the life of the call, so one request never
 * stats the same path twice.
 */
export function verifiedArtifacts(task: TaskRow, workspace: string): TaskRow {
  const summary = task.summary;
  const saved = summary?.files_saved;
  if (!summary || !Array.isArray(saved) || saved.length === 0) return task;
  const seen = new Map<string, boolean>();
  const kept = saved.filter((path) => {
    let there = seen.get(path);
    if (there === undefined) {
      there = artifactOnDisk(workspace, path);
      seen.set(path, there);
    }
    return there;
  });
  if (kept.length === saved.length) return task;
  return { ...task, summary: { ...summary, files_saved: kept, repaired: true } };
}

/**
 * A file the receipt offered is not on disk any more.
 *
 * The Open link is an ordinary top-level navigation, so answering raw JSON
 * turned the whole app window into `{"error":"E_IO"}` with no way back short
 * of quitting. A browser gets a page it can read and close; `fetch` still gets
 * the JSON it parses.
 */
export function fileGone(req: IncomingMessage, res: ServerResponse): void {
  const accept = String(req.headers.accept ?? "");
  if (!accept.includes("text/html")) {
    writeJson(res, 404, { error: "E_IO", message: "file not found" });
    return;
  }
  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>File not found</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
    background: #faf9f7; color: #1c1b19; padding: 2rem;
  }
  main { max-width: 26rem; text-align: center; }
  h1 { font-size: 1.375rem; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 0.5rem; }
  p { margin: 0; color: #6b6863; }
  @media (prefers-color-scheme: dark) {
    body { background: #16150f; color: #f2efe6; }
    p { color: #a19c91; }
  }
</style>
<main>
  <h1>This file isn&rsquo;t here any more</h1>
  <p>Your bot saved it on its own computer, and it has since been cleared away. Close this window and ask for it again &mdash; nothing else was lost.</p>
</main>
`;
  res.writeHead(404, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
    // A page rendered from a file route must never run anything of its own.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "x-content-type-options": "nosniff",
  });
  res.end(html);
}

export interface DaemonHandle {
  server: Server;
  store: Store;
  events: EventBus;
  port: number;
  host: string;
  baseUrl: string;
  close(): Promise<void>;
  callTool(computerId: string, method: string, params?: unknown): Promise<unknown>;
  auditLog: AuditLog;
}

export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const host = opts.host ?? "127.0.0.1";
  const wantPort = opts.port ?? 7777;
  const publicOrigin = opts.publicOrigin ? canonicalHttpsOrigin(opts.publicOrigin) : undefined;
  const allowedHosts = [...opts.allowedHosts ?? [], ...(publicOrigin ? [new URL(publicOrigin).host] : [])];
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    if (!opts.allowPublicBind || publicOrigin) {
      throw new Error("refusing non-loopback bind without allowPublicBind");
    }
  }

  const store = new Store(opts.sqlitePath ?? ":memory:");
  const savedConnection = store.getCodexConnection();
  if (!opts.codexRunner && savedConnection) opts.codexRunner = { codexHome: savedConnection.home, model: savedConnection.model, provider: savedConnection.provider };
  // A model name alone is not a working configuration: the shipped example
  // config names one with no key, which made a fresh install report "Connected".
  const standaloneAvailable = Boolean(opts.agentLoop?.model.trim()) && opts.agentLoop?.credentialed !== false;
  /**
   * Two different numbers, and conflating them is what made the UI's editable
   * budget field a lie. `agent.spend_cap_usd` is what a task gets when nobody
   * chooses; `agent.spend_cap_max_usd` is the most anyone may choose. A request
   * above the maximum is refused by name rather than silently clamped.
   */
  const spendCapDefault = (): number => opts.agentLoop?.spendCapUsd ?? DEFAULT_SPEND_CAP_USD;
  // An operator who named a per-task figure and no maximum named both: raising
  // their ceiling to the built-in $100 spends real money they never authorised.
  const spendCapMax = (): number => opts.spendCapMaxUsd ??
    (opts.agentLoop?.spendCapUsd !== undefined ? spendCapDefault() : DEFAULT_SPEND_CAP_MAX_USD);
  const spendCap = (requested?: number | null): number =>
    Math.min(requested ?? spendCapDefault(), spendCapMax());
  const perCallUsd = opts.mcpToolCallProxyUsd ?? DEFAULT_MCP_TOOL_CALL_PROXY_USD;
  /** Steps a task gets when the request names none: `agent.max_steps`, else the built-in. */
  const defaultMaxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const executionInfo = {
    standalone_available: standaloneAvailable,
    task_start_available: Boolean(opts.codexRunner) || standaloneAvailable,
    execution_mode: opts.codexRunner ? opts.codexRunner.provider ?? "codex" : standaloneAvailable ? "standalone" : null,
    model: opts.codexRunner?.model ?? (standaloneAvailable ? opts.agentLoop!.model : null),
    spend_cap_usd: opts.codexRunner || standaloneAvailable ? spendCap() : null,
    budget_kind: opts.codexRunner ? "tool_proxy" : standaloneAvailable ? "provider_estimate" : null,
    budget: { default_usd: spendCapDefault(), max_usd: spendCapMax(), per_call_usd: perCallUsd },
  };
  const providerLimits = createProviderLimits();
  const guestExecution = opts.nativeExecutionLocation === "computer";
  function nativeRunnerConfig(provider: NativeProvider): CodexRunnerConfig {
    if (opts.codexRunner && (opts.codexRunner.provider ?? "codex") === provider) return opts.codexRunner;
    const login = provider === "codex" ? opts.codexLogin : opts.claudeLogin;
    return { provider, codexHome: login?.codexHome
      ?? (provider === "codex" ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR)
      ?? (provider === "codex" ? join(homedir(), ".codex") : ""),
      model: provider === "codex" ? "gpt-6-astra" : "claude-fable-5-1",
      runsRoot: opts.codexRunner?.runsRoot,
      ...(login?.binary ? { binary: login.binary } : {}) };
  }
  const connections = Object.fromEntries((["codex", "claude"] as const).map(provider => {
    const configured = opts.codexRunner?.provider ?? "codex";
    const loginOptions = provider === "codex" ? opts.codexLogin : opts.claudeLogin;
    const loginHome = (opts.codexRunner && configured === provider ? opts.codexRunner.codexHome : undefined)
      ?? loginOptions?.codexHome ?? (provider === "codex" ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR)
      ?? (provider === "codex" ? join(homedir(), ".codex") : "");
    return [provider, createCodexConnection({ ...loginOptions, provider, codexHome: loginHome,
      authorized: (owner) => Boolean(store.getSession(owner)),
      loginMode: loginOptions?.loginMode ?? (publicOrigin || opts.headless ? provider === "codex" ? "device" : "terminal" : "browser"),
      binary: (configured === provider ? opts.codexRunner?.binary : undefined) ?? loginOptions?.binary,
      model: () => opts.codexRunner && (opts.codexRunner.provider ?? "codex") === provider ? opts.codexRunner.model : provider === "codex" ? "gpt-6-astra" : "",
      configured: () => Boolean(opts.codexRunner) && (opts.codexRunner?.provider ?? "codex") === provider,
      connected(model) {
        if (closing) return false;
        const same = (opts.codexRunner?.provider ?? "codex") === provider;
        opts.codexRunner = { runsRoot: opts.codexRunner?.runsRoot, ...(same ? opts.codexRunner : {}), provider, codexHome: loginHome, model,
          ...(loginOptions?.binary ? { binary: loginOptions.binary } : {}) };
        store.setCodexConnection(loginHome, model, provider);
        Object.assign(executionInfo, { task_start_available: true, execution_mode: provider, model,
          spend_cap_usd: spendCap(), budget_kind: "tool_proxy",
          budget: { default_usd: spendCapDefault(), max_usd: spendCapMax(), per_call_usd: perCallUsd } });
        return true;
      },
    })];
  })) as Record<"codex" | "claude", ReturnType<typeof createCodexConnection>>;
  const guestConnections = new Map<string, ReturnType<typeof createCodexConnection>>();
  function connectionFor(provider: NativeProvider, computerId?: string) {
    if (!guestExecution) return connections[provider];
    if (!computerId) return undefined;
    const key = `${computerId}:${provider}`;
    let connection = guestConnections.get(key);
    if (!connection) {
      connection = createCodexConnection({ provider,
        codexHome: provider === "codex" ? GUEST_CODEX_HOME : GUEST_CLAUDE_HOME,
        loginMode: provider === "codex" ? "device" : "terminal",
        spawn: args => guestSpawn(computerId, provider, args),
        authorized: owner => Boolean(store.getSession(owner)),
        model: () => nativeRunnerConfig(provider).model,
        configured: () => Boolean(opts.codexRunner) && (opts.codexRunner?.provider ?? "codex") === provider,
        connected(model) {
          if (closing) return false;
          // Keep the legacy host location for saved sessions; new tasks record
          // their guest location independently and never copy its credentials.
          opts.codexRunner = { ...nativeRunnerConfig(provider), model };
          store.setCodexConnection(opts.codexRunner.codexHome, model, provider);
          Object.assign(executionInfo, { task_start_available: true, execution_mode: provider, model,
            spend_cap_usd: spendCap(), budget_kind: "tool_proxy" });
          return true;
        },
      });
      guestConnections.set(key, connection);
    }
    return connection;
  }
  const allConnections = () => [...Object.values(connections), ...guestConnections.values()];
  /**
   * `codex login status` exits 0 on a plan whose quota is spent, so a signed-in
   * connection is not the same as a usable one: a remembered refusal rides
   * along on the status the UI reads.
   */
  async function connectionStatus(provider: NativeProvider = opts.codexRunner?.provider ?? "codex", audience?: string, computerId = defaultComputer()?.id) {
    const connection = connectionFor(provider, computerId);
    const state = connection ? await connection.status(audience) : {
      status: "signed_out", provider, model: nativeRunnerConfig(provider).model,
      login_mode: provider === "codex" ? "device" as const : "terminal" as const,
      message: "Sign in to your model account. BotHearth will prepare your computer first.",
    };
    if (opts.codexRunner && (opts.codexRunner.provider ?? "codex") === provider)
      executionInfo.task_start_available = state.status === "connected" || state.status === "signed_in";
    const limit = providerLimits.get(provider);
    return { ...state, ...(limit ? { limit } : {}), execution_location: guestExecution ? "computer" : "host", ...(computerId ? { computer_id: computerId } : {}) };
  }
  if (opts.codexRunner) await connectionStatus();

  const dataDir = opts.dataDir
    ?? (opts.sqlitePath && opts.sqlitePath !== ":memory:" ? dirname(opts.sqlitePath) : join(homedir(), "ModelBot"));
  const imageBuildLogPath = join(dataDir, "logs", "image-build.log");
  /**
   * `log_tail` is 20 lines of raw `docker build` output — image names, host
   * paths, whatever a Dockerfile echoed — and `GET /api/v1/runtime` is readable
   * by any UI session. The full output stays in the build log on disk, where
   * the failure message already points; the wire carries only step, percent and
   * a one-line error.
   */
  const redactPrepare = <T extends { log_tail: string[] }>(prepare: T): T => ({ ...prepare, log_tail: [] });
  const withoutBuildLog = (status: RuntimeStatus): RuntimeStatus =>
    ({ ...status, images: { ...status.images, prepare: redactPrepare(status.images.prepare) } });
  const imagePreparer = createImagePreparer({
    runBuild: createDockerBuildRunner({ logPath: imageBuildLogPath }),
    logPath: imageBuildLogPath,
  });
  /** One prepare attempt per cooldown, counted from the last attempt. */
  const PREPARE_COOLDOWN_MS = 10_000;
  let lastPrepareAt = 0;
  /**
   * The first-run screen polls readiness every 2 s and the readiness cache TTL
   * is 2 s, so without a backoff nearly every poll missed and every miss
   * spawned `claude auth status` *and* `codex login status`, forever, on the
   * screen a new user sits on. Each fruitless sweep doubles the wait to a
   * one-minute ceiling; a successful adoption sets `opts.codexRunner`, which
   * stops the sweep for good.
   */
  const ADOPT_RETRY_MIN_MS = 2_000;
  const ADOPT_RETRY_MAX_MS = 60_000;
  let adopting: Promise<void> | undefined;
  let adoptNextAt = 0;
  let adoptRetryMs = ADOPT_RETRY_MIN_MS;
  const adoptRefused = new Set<string>();
  /**
   * Adopt an installed, already-signed-in CLI when the owner has configured
   * nothing yet, so a fresh install becomes usable without a settings trip.
   * Never overrides a configured provider and never starts a login: `connect`
   * only reads the CLI's own `auth status`.
   */
  async function adoptSignedInProvider(): Promise<void> {
    if (guestExecution || !opts.autoConnectProvider || opts.codexRunner) return;
    if (adopting) { await adopting; return; }
    if (Date.now() < adoptNextAt) return;
    adopting = (async () => {
      for (const provider of ["claude", "codex"] as const) {
        if (opts.codexRunner) continue;
        // An explicitly configured binary is the owner's own choice; only the
        // path ModelBot picked for itself needs the check below.
        const pinned = (provider === "codex" ? opts.codexLogin : opts.claudeLogin)?.binary;
        const found = pinned ? null : resolveTool(provider);
        if (!pinned && !found) continue;
        // Auto-adoption binds the daemon to a CLI and starts spending the
        // owner's real subscription quota, with no consent step. A binary under
        // $HOME is writable by anything running as the user, so it is never
        // adopted silently — the owner connects it from Settings instead, which
        // is the explicit confirmation this path lacks.
        if (found?.source === "well-known") {
          if (!adoptRefused.has(found.path)) {
            adoptRefused.add(found.path);
            logInfo("auto-adoption refused: user-writable install", { provider, path: found.path });
          }
          continue;
        }
        const state = await connections[provider].connect();
        if (state.status === "connected") {
          logInfo("adopted signed-in provider", { provider, path: found?.path ?? pinned, source: found?.source ?? "configured" });
          return;
        }
      }
      adoptRetryMs = Math.min(adoptRetryMs * 2, ADOPT_RETRY_MAX_MS);
      adoptNextAt = Date.now() + adoptRetryMs;
    })().finally(() => { adopting = undefined; });
    await adopting;
  }
  /**
   * A browser that will not start blocks every task on its computer, and the
   * model cannot restart one. Remember which computer said so, and clear it
   * only when a browser call on that computer works again.
   */
  let browserDown: { computer_id: string; detail: string } | null = null;
  let browserRetry: Promise<unknown> | undefined;
  function noteBrowserHealth(computerId: string, tool: string, result: ToolResult): void {
    const detail = browserUnavailableDetail(result);
    if (detail) browserDown = { computer_id: computerId, detail };
    else if (result.ok && tool.startsWith("browser_") && browserDown?.computer_id === computerId) browserDown = null;
  }
  /** Reports the blocker and, while it stands, retries the launch in the background. */
  function browserBlocked(): string | null {
    const down = browserDown;
    if (!down) return null;
    // A computer that has been stopped or thrown away is not the reason a task
    // cannot start, and probing it would keep the blocker up forever.
    if (store.getComputer(down.computer_id)?.status !== "running") {
      browserDown = null;
      return null;
    }
    browserRetry ??= getClient(down.computer_id)
      .call("browser_snapshot", {})
      .then((result) => noteBrowserHealth(down.computer_id, "browser_snapshot", result))
      .catch(() => undefined)
      .finally(() => { browserRetry = undefined; });
    return down.detail;
  }

  const runtimeProbe = createRuntimeProbe({
    preparer: imagePreparer,
    configuredProvider: () => opts.codexRunner ? opts.codexRunner.provider ?? "codex" : null,
    nativeInComputer: () => guestExecution,
    async providerStatus(provider) {
      await adoptSignedInProvider();
      return (await connectionStatus(provider)).status;
    },
    providerLimit: (provider) => providerLimits.get(provider),
    standaloneReady: () => standaloneAvailable,
    taskStartAvailable: () => executionInfo.task_start_available,
    browserUnavailable: browserBlocked,
  });
  const events = new EventBus();
  const workspaceRoot =
    opts.workspaceRoot ?? join(process.cwd(), ".modelbot-workspaces");
  await mkdir(workspaceRoot, { recursive: true });
  const sandbox =
    opts.sandbox ??
    (createDefaultSandbox({ workspaceRoot }) as SandboxRuntime & {
      start?(computerId: string): Promise<void>;
      refreshImage?(computerId: string, capabilities: ComputerCapability[]): Promise<boolean>;
      get?(computerId: string): { workspaceRoot?: string } | undefined;
    });

  // Receipts written before the receipt was taught to read outcomes
  // instead of requests still name files that were never written, and those
  // rows are frozen — nothing recomputes them. Sweep them once, here, where
  // the workspace layout is known.
  const receiptRepair = store.repairFrozenFileLists((computerId, file) =>
    artifactOnDisk(sandbox.get?.(computerId)?.workspaceRoot ?? join(workspaceRoot, computerId), file),
  );
  if (receiptRepair.applied) {
    logInfo("receipt file lists recomputed against disk", {
      migration: RECEIPT_REPAIR_VERSION,
      tasks_repaired: receiptRepair.repaired,
    });
  }

  // A task that died on an older daemon never closed the takeover it opened,
  // and that row kept telling every later task on the same computer that a
  // person still had control.
  const staleTakeovers = store.closeStaleTakeovers();
  if (staleTakeovers.applied) {
    logInfo("stale takeovers closed", {
      migration: STALE_TAKEOVER_VERSION,
      takeovers_closed: staleTakeovers.closed,
    });
  }

  let closing = false;
  const clients = new Map<string, ComputerClient>();
  const controlChanges = new Map<string, Promise<unknown>>();
  async function changeControl<T>(computerId: string, action: () => Promise<T>): Promise<T> {
    const pending = (controlChanges.get(computerId) ?? Promise.resolve()).catch(() => {}).then(action);
    controlChanges.set(computerId, pending);
    try { return await pending; }
    finally { if (controlChanges.get(computerId) === pending) controlChanges.delete(computerId); }
  }
  const hasGuestComputer = (computerId: string) => store.listTasks().some(task =>
    task.computer_id === computerId && task.execution_location === "computer");
  const taskControllers = new Map<string, AbortController>();
  const taskRuns = new Map<string, Promise<unknown>>();
  const liveSubs = new Map<string, Set<WsSocket>>();
  const eventSubs = new Set<WsSocket>();
  const socketSessions = new Map<WsSocket, string>();
  function authorizeSocket(ws: WsSocket): boolean {
    const sessionId = socketSessions.get(ws);
    if (ws.readyState === "open" && sessionId && store.getSession(sessionId)) return true;
    ws.close(1008, "operator session expired or revoked");
    return false;
  }
  // Close idle revoked sockets too; every send and queued input checks immediately.
  const socketSessionTimer = setInterval(() => {
    for (const ws of socketSessions.keys()) authorizeSocket(ws);
    for (const connection of allConnections()) {
      const owner = connection.loginSession();
      if (owner && !store.getSession(owner)) void connection.cancel(false);
    }
  }, 1_000);
  socketSessionTimer.unref?.();
  const takeoverTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const takeoverGapStarts = new Map<string, string>();
  const idlePause = createIdlePauseController({
    idlePauseMin: opts.idlePauseMin ?? 10,
    pauseComputer: async (id) => {
      if (useFakeComputer()) return;
      await pauseComputer(id);
    },
    unpauseComputer: async (id) => {
      if (useFakeComputer()) return;
      await unpauseComputer(id);
    },
    listComputers: () =>
      store.listComputers().filter((c) => c.status === "running").map((c) => c.id),
    isTakeoverActive: (id) => isTakeoverPending(store.activeTakeoverForComputer(id)) || store.listTasks().some(task =>
      task.computer_id === id && task.status === "running" && (task.adapter === "codex" || task.adapter === "claude")),
  });
  idlePause.start();
  const approvalExpiryTimer = setInterval(() => {
    for (const approval of store.expirePendingApprovals()) {
      void emit(
        "approval.expired",
        { approval_id: approval.id },
        { task_id: approval.task_id },
      );
    }
  }, 1_000);
  approvalExpiryTimer.unref?.();

  const harnessCallsInFlight = new Map<string, number>();
  const computersCancelling = new Set<string>();

  let defaultProvision: Promise<ComputerRow> | undefined;
  function defaultComputer(): ComputerRow | undefined {
    const browsers = store.listComputers().filter((computer) => JSON.parse(computer.capabilities).includes("browser"));
    const remembered = store.getDefaultComputerId();
    // A deleted default must not silently transfer a task to another signed-in profile.
    return remembered ? browsers.find((computer) => computer.id === remembered) :
      (browsers.length === 1 ? browsers[0] : undefined);
  }

  async function provisionComputer(body: CreateComputerBody): Promise<ComputerRow> {
    const handle = await sandbox.create(body);
    if (closing) { await sandbox.stop(handle.computer_id); throw new Error("daemon is shutting down"); }
    const computer = store.insertComputer({ id: handle.computer_id, name: handle.name,
      capabilities: handle.capabilities, persistent: Boolean(body.persistent), status: "running" });
    idlePause.track(computer.id);
    getClient(computer.id);
    void emit("sandbox.started", { computer_id: computer.id }, { computer_id: computer.id });
    return computer;
  }

  async function resolveDefaultComputer(): Promise<ComputerRow> {
    const selected = defaultComputer();
    if (selected) return selected;
    // An explicit task or native sign-in provisions; overlapping requests share one computer.
    defaultProvision ??= (async () => {
      const computer = await provisionComputer({ name: `browser-${randomBytes(6).toString("hex")}`,
        capabilities: ["browser"], persistent: true });
      store.db.prepare("UPDATE computers SET name = ? WHERE id = ?").run("My browser", computer.id);
      computer.name = "My browser";
      store.setDefaultComputerId(computer.id);
      return computer;
    })().finally(() => { defaultProvision = undefined; });
    return defaultProvision;
  }

  /**
   * What each computer says it can actually run, learned from its own
   * `methods` RPC on attach. Absent = not asked yet, and every tool stays
   * advertised; an entry that exists is authoritative.
   *
   * The daemon used to advertise `write_file` to the model while the container
   * answered `E_CAPABILITY unknown method: write_file`, and the only evidence
   * was a failed task. Advertising the intersection means a computer built
   * before a tool shipped simply never offers it.
   */
  const computerMethods = new Map<string, Set<string>>();

  async function probeComputerMethods(computerId: string): Promise<void> {
    const result = await clients.get(computerId)?.call("methods").catch(() => null);
    const methods = (result as { ok?: boolean; data?: { methods?: unknown } } | null | undefined)?.ok
      ? (result as { data: { methods?: unknown } }).data.methods
      : null;
    if (!Array.isArray(methods)) return; // Older computer: leave it unfiltered.
    computerMethods.set(computerId, new Set(methods.filter((m): m is string => typeof m === "string")));
  }

  /** Record a method this computer proved it cannot run, so it is never offered again. */
  function forgetMethod(computerId: string, method: string): void {
    const known = computerMethods.get(computerId);
    if (known) known.delete(method);
    else computerMethods.set(computerId, new Set(TOOL_CATALOGUE.map((t) => t.name).filter((n) => n !== method)));
  }

  /**
   * Containers pin the image id they were created from, so a rebuilt tag never
   * reaches a computer that already exists — which is how the owner's
   * persistent browser kept running a build with no `write_file` in it. Run at
   * boot and after a successful image build.
   */
  async function reconcileComputerImages(): Promise<void> {
    if (useFakeComputer() || !sandbox.refreshImage) return;
    for (const computer of store.listComputers()) {
      // A paused task or private handoff still owns its browser session.
      if (store.activeTakeoverForComputer(computer.id) || store.listTasks().some((task) =>
        task.computer_id === computer.id && ["running", "paused"].includes(task.status))) continue;
      try {
        const refreshed = await sandbox.refreshImage(
          computer.id,
          JSON.parse(computer.capabilities) as ComputerCapability[],
        );
        if (!refreshed) continue;
        logInfo("computer recreated on a newer image", { computer_id: computer.id });
        const client = clients.get(computer.id);
        if (client) { await client.close().catch(() => undefined); clients.delete(computer.id); }
        computerMethods.delete(computer.id);
      } catch (err) {
        logInfo("computer image refresh failed", { computer_id: computer.id, err: String(err) });
      }
    }
  }

  function getClient(computerId: string): ComputerClient {
    let c = clients.get(computerId);
    if (!c) {
      c = useFakeComputer()
        ? createFakeComputerClient(computerId)
        : openComputerClient(computerId, {
            capabilities: JSON.parse(store.getComputer(computerId)?.capabilities ?? '["browser"]'),
          });
      function withWake<Args extends unknown[], Result>(
        call: (...args: Args) => Promise<Result>,
        shouldWake: (...args: Args) => boolean = () => true,
      ): (...args: Args) => Promise<Result> {
        return async (...args) => {
          if (shouldWake(...args)) await idlePause.wake(computerId);
          return call(...args);
        };
      }
      c.call = withWake(c.call.bind(c), (method) => method !== "takeover_status");
      const grant = c.grantTakeover.bind(c), release = c.releaseTakeover.bind(c), decline = c.declineTakeover.bind(c);
      const thawIfAgent = async () => {
        const state = await c!.call("takeover_status", {});
        if (state.ok && (state.data as { state?: string })?.state === "agent") await setGuestComputerPaused(computerId, false);
      };
      c.grantTakeover = withWake(id => changeControl(computerId, async () => {
        // Native shell/file tools bypass MCP. Stop them before acknowledging
        // human control; the computer's pause marker also blocks new processes.
        const native = hasGuestComputer(computerId);
        try {
          if (native) await setGuestComputerPaused(computerId, true);
          const result = await grant(id);
          if (native && result.ok && (result.data as { state?: string })?.state === "human") {
            for (const { scope } of scopedMcp.values())
              if (scope.active && scope.computerId === computerId) scope.waitGeneration++;
          }
          if (!result.ok && native) await thawIfAgent();
          return result;
        } catch (error) {
          // A failed scan may have stopped only some processes. Thaw only if
          // the authoritative browser gate already permits model access.
          if (native) await thawIfAgent().catch(() => {});
          throw error;
        }
      }));
      const returnNativeControl = async (call: typeof release, id: string) => {
        let result = await call(id);
        const native = hasGuestComputer(computerId);
        // The browser may have returned successfully before native thaw failed.
        // Retry that same lease without changing another person's control.
        if (!result.ok && native) {
          const status = await c!.call("takeover_status", { takeover_id: id });
          const data = status.ok ? status.data as { state?: string; takeover_id?: string } : undefined;
          if (data?.state === "agent" && data.takeover_id === id) result = status;
        }
        if (result.ok && (result.data as { state?: string })?.state === "agent" && native)
          await setGuestComputerPaused(computerId, false);
        return result;
      };
      c.releaseTakeover = withWake(id => changeControl(computerId, () => returnNativeControl(release, id)));
      const expire = c.expireTakeover.bind(c);
      c.expireTakeover = withWake(id => changeControl(computerId, () => expire(id)));
      c.declineTakeover = withWake(id => changeControl(computerId, () => returnNativeControl(decline, id)));
      const startLive = c.startLive.bind(c), stopLive = c.stopLive.bind(c);
      let liveGeneration = 0;
      c.startLive = (interval) => {
        const generation = ++liveGeneration;
        void idlePause.wake(computerId).then(() => {
          if (generation === liveGeneration) startLive(interval);
        }).catch(() => {
          if (generation === liveGeneration) for (const ws of liveSubs.get(computerId) ?? [])
            ws.send(JSON.stringify({ v: 1, t: "error", code: "E_IO", message: "The browser connection could not be opened. Try opening the task again." }));
        });
      };
      c.stopLive = () => { liveGeneration++; stopLive(); };
      clients.set(computerId, c);
      void probeComputerMethods(computerId);
      c.on("frame", (ev) => {
        const set = liveSubs.get(computerId);
        if (!set) return;
        const { mode, epoch } = liveControlState(computerId);
        if (ev.header.mode !== mode) return;
        const bytes = encodeLiveFrame({ ...ev.header, mode, epoch }, ev.payload);
        for (const ws of set) {
          if (ws.readyState === "open") {
            ws.send(bytes);
          }
        }
      });
      c.on("mode", (message) => {
        for (const ws of liveSubs.get(computerId) ?? []) {
          if (ws.readyState === "open") ws.send(JSON.stringify(message));
        }
      });
      if (liveSubs.get(computerId)?.size) c.startLive();
    }
    return c;
  }

  function liveControlState(computerId: string): LiveModeMsg {
    const takeover = store.latestTakeoverForComputer(computerId);
    const mode = takeover?.state === "human" ? "human"
      : takeover?.state === "resume_validating" || takeover?.state === "paused" ? "validating" : "agent";
    return { v: 1, t: "mode", mode, epoch: takeover?.epoch ?? 1 };
  }

  function sendLiveControl(computerId: string): void {
    const message = JSON.stringify(liveControlState(computerId));
    for (const ws of liveSubs.get(computerId) ?? []) {
      if (ws.readyState === "open") ws.send(message);
    }
    // The computer may emit its first static frame before the durable transition commits.
    if (liveSubs.get(computerId)?.size) {
      const computer = getClient(computerId);
      computer.stopLive();
      computer.startLive();
    }
  }

  const connectors =
    opts.connectorBroker ??
    new ConnectorBroker({
      dataDir: workspaceRoot,
      configs: opts.connectorConfigs ?? [],
      vault: opts.vault,
    });
  await connectors.init();

  const auditLog = opts.auditLog ?? new AuditLog({
    path: join(workspaceRoot, "audit.jsonl"),
    keyProvider: persistedAuditKey(join(workspaceRoot, "audit.key")),
  });
  let auditTail = Promise.resolve();
  const bootstrapHash = createHash("sha256").update(opts.bootstrapToken).digest("hex");
  store.registerBootstrapToken(
    bootstrapHash,
    new Date(Date.now() + 10 * 60_000).toISOString(),
    publicOrigin ?? null,
  );

  type TaskScope = { taskId: string; computerId: string; token: string; active: boolean; waitGeneration: number; awaitingMessage?: boolean };
  const scopedMcp = new Map<string, { scope: TaskScope; handler: ReturnType<typeof createMcpHttpHandler> }>();

  function takeOperatorMessages(taskId: string): string[] {
    return store.takeMessages(taskId);
  }

  function resolveMcpComputer(scope?: TaskScope): { id: string } | null {
    if (scope) {
      const computer = store.getComputer(scope.computerId);
      return scope.active && computer?.status === "running" && store.getTask(scope.taskId)?.status === "running"
        && store.getHarnessTaskBinding(scope.computerId)?.task_id === scope.taskId ? computer : null;
    }
    const running = store.listComputers().filter((computer) => computer.status === "running");
    return running.length === 1 ? running[0]! : null;
  }

  let toolDispatcher: ReturnType<typeof createToolDispatcher>;

  function makeMcpOptions(scope?: TaskScope): McpServerOptions {
    const permitted = (name: string, computerId: string) => {
      const capabilities = JSON.parse((scope ? store.getTask(scope.taskId)?.capabilities : null)
        ?? store.getComputer(computerId)?.capabilities ?? "[]") as string[];
      const byCapability = name === "shell_exec" || name.startsWith("files_") ? capabilities.includes("shell")
        : name.startsWith("browser_") || name.startsWith("computer_") ? capabilities.includes("browser") : true;
      // …and the computer has to be able to run it. `connector_call` is served
      // by the daemon itself, so it is never held to the container's list.
      const known = computerMethods.get(computerId);
      return byCapability && (name === "connector_call" || !known || known.has(name));
    };
    return {
    mcpToken: scope?.token ?? opts.mcpToken,
    port: scope ? mcpOpts.port : wantPort,
    path: scope ? `/mcp/tasks/${scope.taskId}` : "/mcp",
    backend: {
      get uiBaseUrl() {
        return publicOrigin ?? `http://${host === "::1" ? "[::1]" : host}:${mcpOpts.port}`;
      },
      get uiControlUrl() {
        const selected = resolveMcpComputer(scope);
        return `${this.uiBaseUrl}/#/live/${selected?.id ?? ""}`;
      },
      listTools() {
        const selected = resolveMcpComputer(scope);
        if (!selected) return [];
        return TOOL_CATALOGUE.filter((tool) => permitted(tool.name, selected.id)).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }));
      },
      async callTool(name: ToolName, args: Record<string, unknown>, _signal: AbortSignal) {
        const selected = resolveMcpComputer(scope);
        if (!selected) {
          return toolError(
            "E_CAPABILITY",
            scope ? "This task scope is no longer active" : "MCP requires exactly one running computer",
          );
        }
        const computerId = selected.id;
        if (scope && taskWaiting(scope.taskId, computerId)) scope.waitGeneration++;
        if (scope && !permitted(name, computerId)) return toolError("E_CAPABILITY", "Tool is outside this task's capabilities");
        if (scope && ((args.computer_id !== undefined && args.computer_id !== scope.computerId)
          || (args.task_id !== undefined && args.task_id !== scope.taskId)))
          return toolError("E_CAPABILITY", "Tool arguments cannot change this task's computer or task scope");
        if (scope && name === "done" && taskWaiting(scope.taskId, computerId)) {
          scope.waitGeneration++;
          return toolError("E_TAKEOVER_BUSY", "Resolve pending human control or approval before finishing");
        }
        const messageTask = scope?.taskId ?? store.getHarnessTaskBinding(computerId)?.task_id;
        const operatorMessages = messageTask ? takeOperatorMessages(messageTask) : [];
        if (operatorMessages.length) return toolError("E_STALE_REF",
          "This action was NOT executed. New messages from the operator: " + JSON.stringify(operatorMessages) +
          " Respond to these before deciding your next action. Messages do not grant approval or return computer control.");
        const binding = store.getHarnessTaskBinding(computerId);
        if (binding && store.getTask(binding.task_id)?.status !== "running") {
          return toolError("E_POLICY", "Harness task has ended; create a new task binding in the operator UI API");
        }
        harnessCallsInFlight.set(computerId, (harnessCallsInFlight.get(computerId) ?? 0) + 1);
        try {
          const spendDenied = await enforceHarnessMcpSpendCap({ store, emit }, computerId);
          if (spendDenied) return spendDenied;
          const taskId = store.getHarnessTaskBinding(computerId)?.task_id ?? `mcp:${computerId}`;
          const result = await toolDispatcher.dispatch(name, args, {
            taskId,
            computerId,
            mode: opts.mode,
            originSets: opts.declaredOrigins,
          });
          // The harness is the shipping execution mode: without this a dead
          // browser never raises `browser_unavailable` and never gets relaunched.
          noteBrowserHealth(computerId, name, result);
          if (scope && ((!result.ok && ["E_TAKEOVER_BUSY", "E_POLICY_PENDING"].includes(result.error.code))
            || (name === "request_takeover" && result.ok))) scope.waitGeneration++;
          if (
            name === "request_takeover" &&
            result &&
            typeof result === "object" &&
            (result as { ok?: boolean }).ok === true
          ) {
            const data = (result as { data?: Record<string, unknown> }).data ?? {};
            const takeoverId = recordTakeover(store, computerId, taskId, data);
            if (takeoverId) {
              emit(
                "takeover.requested",
                { takeover_id: takeoverId, reason: String(args.reason ?? "mcp") },
                { task_id: taskId, computer_id: computerId },
              );
              scheduleTakeoverExpiry(takeoverId);
            }
          }
          if (name === "done" && messageTask && store.pendingMessages(messageTask).length) {
            return toolError("E_STALE_REF", "Task remains open: new operator messages arrived before completion. " + JSON.stringify(takeOperatorMessages(messageTask)));
          }
          if (binding && name === "done" && (result as { ok?: boolean })?.ok) {
            const status = args.status === "fail" ? "failed" : args.status === "cancelled" ? "cancelled" : "completed";
            if (store.finishTask(binding.task_id, status)) {
              await emit(`task.${status}`, { execution: "harness", summary: String(args.summary ?? ""),
                ...(status === "failed" ? { failure_kind: "model_error" } : {}) },
                { task_id: binding.task_id, computer_id: computerId });
              // Freeze only now — the terminal event is in the audit log.
              store.freezeTaskSummary(binding.task_id);
              if (scope) scope.active = false;
            }
          }
          return result;
        } finally {
          const remaining = (harnessCallsInFlight.get(computerId) ?? 1) - 1;
          if (remaining) harnessCallsInFlight.set(computerId, remaining);
          else harnessCallsInFlight.delete(computerId);
        }
      },
      async releaseTakeover(takeoverId: string) {
        const selected = resolveMcpComputer(scope);
        if (!selected) {
          return toolError("E_SANDBOX_DEAD", "no running computer");
        }
        return getClient(selected.id).releaseTakeover(takeoverId);
      },
      async grantTakeover(takeoverId: string) {
        const selected = resolveMcpComputer(scope);
        if (!selected) {
          return toolError("E_SANDBOX_DEAD", "no running computer");
        }
        return getClient(selected.id).grantTakeover(takeoverId);
      },
      async declineTakeover(takeoverId: string) {
        const selected = resolveMcpComputer(scope);
        if (!selected) {
          return toolError("E_SANDBOX_DEAD", "no running computer");
        }
        return getClient(selected.id).declineTakeover(takeoverId);
      },
    } satisfies McpToolBackend,
  }; }
  const mcpOpts = makeMcpOptions();
  const mcpHttp = createMcpHttpHandler(mcpOpts);

  async function revokeRunner(id: string) {
    const running = scopedMcp.get(id);
    if (running) { running.scope.active = false; scopedMcp.delete(id); await running.handler.closeAll(); }
  }

  /**
   * A takeover row another task left open reads as "a person has this
   * computer", and a task that trusted it would wait for an answer nobody is
   * coming to give. The computer's own gate is the authority: when it says the
   * agent has control, the row is a leftover, so close it.
   */
  async function closeForeignTakeover(task: TaskRow): Promise<void> {
    await changeControl(task.computer_id, async () => {
      const stale = store.activeTakeoverForComputer(task.computer_id) ?? store.latestTakeoverForComputer(task.computer_id);
      if (!stale?.task_id || stale.task_id === task.id) return;
      const client = getClient(task.computer_id);
      let status = await client.call("takeover_status", { takeover_id: stale.id });
      const data = status.ok ? status.data as { state?: string; takeover_id?: string } : undefined;
      const owner = store.getTask(stale.task_id);
      if (!stale.granted_to && (!owner || ["completed", "failed", "cancelled"].includes(owner.status))
        && data?.takeover_id === stale.id && ["requested", "paused"].includes(data.state ?? "")) {
        // Nobody took this task's unanswered request. Its ended RPC session
        // must not leave the next task behind a requested computer gate.
        clients.delete(task.computer_id);
        await client.close();
        status = await getClient(task.computer_id).call("takeover_status", { takeover_id: stale.id });
      }
      if (!status.ok || (status.data as { state?: string })?.state !== "agent") return;
      if (hasGuestComputer(task.computer_id)) await setGuestComputerPaused(task.computer_id, false);
      if (stale.state === "agent" || stale.state === "terminated") return;
      store.updateTakeoverState(stale.id, "terminated");
      logInfo("closed a takeover another task left open", {
        takeover_id: stale.id, task_id: task.id, left_by: stale.task_id,
      });
    });
  }

  function taskWaiting(taskId: string, computerId: string) {
    // Expiry pauses control; only the operator can release the computer gate.
    return Boolean(store.activeTakeoverForComputer(computerId, taskId))
      || store.listApprovals("pending").some((approval) => approval.task_id === taskId);
  }

  async function pauseNativeForRestart(task: TaskRow): Promise<void> {
    if (!["running", "paused"].includes(task.status) || !["codex", "claude"].includes(task.adapter ?? "")) return;
    // The replacement computer-server has a fresh input epoch. Keep capture
    // blocked, and require a fresh operator grant instead of replaying input.
    const takeover = store.activeTakeoverForComputer(task.computer_id, task.id);
    if (takeover) store.updateTakeoverState(takeover.id, "paused");
    if (task.status !== "running" || !store.pauseTask(task.id)) return;
    await emit("task.step", { status: "paused", reason: "daemon_restart",
      detail: "BotHearth stopped. Your task and conversation are saved. Review the current page, then resume when ready." },
      { task_id: task.id, computer_id: task.computer_id });
  }

  async function cancelTask(id: string) {
    const before = store.getTask(id);
    if (!before || ["completed", "failed", "cancelled"].includes(before.status)) return before;
    const task = store.cancelTask(id)!;
    if (task.status !== "cancelled") return task;
    const computerId = task.computer_id;
    taskControllers.get(id)?.abort();
    if (computersCancelling.has(computerId)) { await revokeRunner(id); return task; }
    computersCancelling.add(computerId);
    try {
      await changeControl(computerId, async () => {
        await revokeRunner(id);
        // Return control must not thaw a cancelled child before it is killed.
        if (task.execution_location === "computer") await taskRuns.get(id)?.catch(error => {
          if (!(error instanceof Error) || error.message !== "Task cancelled") throw error;
        });
        // Explicit standalone tasks can share a computer. Retain the transport
        // while another active task still uses it.
        if (store.listTasks().some((other) => other.id !== id && other.computer_id === computerId
          && !["completed", "failed", "cancelled"].includes(other.status))) return;
        // Cancelling work does not cancel a person's control of the desktop.
        if (store.activeTakeoverForComputer(computerId)) return;
        const client = clients.get(computerId);
        const state = await client?.call("takeover_status", {});
        if (state && (!state.ok || !["agent", "requested", "terminated"].includes(String((state.data as { state?: string })?.state)))) return;
        clients.delete(computerId);
        await client?.close();
        if (hasGuestComputer(computerId)) {
          const fresh = await getClient(computerId).call("takeover_status", {
            takeover_id: store.latestTakeoverForComputer(computerId)?.id,
          });
          if (fresh.ok && (fresh.data as { state?: string })?.state === "agent") await setGuestComputerPaused(computerId, false);
        }
      });
      return task;
    } finally { computersCancelling.delete(computerId); }
  }

  /**
   * The wall clock this task's run may take, in seconds. 0 is no ceiling and is
   * the default: a run must end because the work is done, the budget or the
   * steps ran out, or a person stopped it — never because a clock nobody set
   * ran down. A resume may raise it for this task alone.
   */
  function taskMaxRuntimeSec(task: TaskRow): number {
    const sec = task.max_runtime_sec ?? opts.maxRuntimeSec ?? 0;
    return Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  }

  /** The pause a harness task's own budget imposed on it, or null if none did. */
  function harnessCapStop(taskId: string):
    { reason: "spend_cap" | "max_steps"; detail: string; steps: number; failure_kind: FailureKind } | null {
    const binding = store.harnessBindingForTask(taskId);
    const reason = binding?.denied ? harnessCapReason(binding) : null;
    if (!binding || !reason) return null;
    return {
      reason,
      detail: reason === "spend_cap"
        ? spendCapStopDetail(binding.spend_cap_usd)
        : maxStepsStopDetail(binding.max_steps),
      steps: binding.observed_tool_calls,
      failure_kind: classifyFailureKind(reason, null),
    };
  }

  function startStoredTask(task: TaskRow, origins?: string[], resume = false) {
    if (closing) {
      store.cancelTask(task.id);
      return Promise.reject(new Error("daemon is shutting down"));
    }
    const controller = new AbortController();
    taskControllers.set(task.id, controller);
    const run = runStoredTask(task, controller, origins, resume).catch(async (error) => {
      if (!controller.signal.aborted) {
        // The provider's own words are the only place a spent plan shows up:
        // remember it against the connection so the next screen says so, and
        // put the same reason on the task that died of it.
        const provider = task.adapter === "claude" || task.adapter === "codex" ? task.adapter : null;
        const limit = provider ? classifyProviderLimit(String(error)) : null;
        if (provider && limit) {
          providerLimits.record(provider, limit);
          runtimeProbe.invalidate();
        }
        // A harness task whose last tool call was refused by a budget did not go
        // wrong on this machine, and it is not over: it stopped exactly where
        // the standalone loop stops, in the same words, and a raised budget
        // resumes it. Failing it here is what made "Resume with a higher
        // budget" answer 409 on the one task that needed it.
        // A runtime ceiling is a cap like the other two, not a fault: the run
        // stops where it is, keeps its receipt, and a raised ceiling resumes it.
        const capped = harnessCapStop(task.id)
          ?? (error instanceof Error && error.message === MAX_RUNTIME_STOP
            ? { reason: "max_runtime" as const, detail: maxRuntimeStopDetail(taskMaxRuntimeSec(task)),
              steps: store.harnessBindingForTask(task.id)?.observed_tool_calls ?? 0,
              failure_kind: "max_runtime" as const }
            : null);
        if (capped) {
          if (store.pauseTask(task.id)) {
            await emit("task.step", { status: "paused", ...capped },
              { task_id: task.id, computer_id: task.computer_id });
          }
        } else if (store.finishTask(task.id, "failed")) {
          await emit("task.failed", { reason: "runner_error", summary: String(error), ...providerLimitFields(limit),
            failure_kind: classifyFailureKind("runner_error", limit) }, { task_id: task.id, computer_id: task.computer_id });
          store.freezeTaskSummary(task.id);
        }
      }
      throw error;
    }).finally(() => { taskControllers.delete(task.id); taskRuns.delete(task.id); });
    taskRuns.set(task.id, run);
    return run;
  }

  async function runStoredTask(task: TaskRow, controller: AbortController, origins?: string[], resume = false) {
    await closeForeignTakeover(task);
    const runnerProvider = task.adapter === "codex" || task.adapter === "claude" ? task.adapter : null;
    if (runnerProvider) {
      const scope: TaskScope = { taskId: task.id, computerId: task.computer_id, token: randomBytes(32).toString("hex"), active: true, waitGeneration: 0 };
      scopedMcp.set(task.id, { scope, handler: createMcpHttpHandler(makeMcpOptions(scope)) });
      try {
        const saved = resume ? store.db.prepare("SELECT body_json FROM steps WHERE task_id = ? AND kind = 'runner_session' ORDER BY rowid DESC LIMIT 1")
          .get(task.id) as { body_json: string } | undefined : undefined;
        const session = saved ? JSON.parse(saved.body_json) as { thread_id: string; provider: string } : undefined;
        const config = nativeRunnerConfig(runnerProvider);
        await runCodexTask({ ...config, execution_location: task.execution_location ?? "host",
          ...(task.model ? { model: task.model } : {}) }, task, {
          url: `http://${host === "::1" ? "[::1]" : host}:${mcpOpts.port}/mcp/tasks/${encodeURIComponent(task.id)}`,
          token: scope.token, signal: controller.signal,
          threadId: session?.provider === runnerProvider ? session.thread_id : undefined,
          onThread(thread_id) {
            store.insertStep(task.id, 0, "runner_session", { thread_id, provider: runnerProvider });
          },
          maxRuntimeSec: taskMaxRuntimeSec(task),
          onMessage(content) {
            if (controller.signal.aborted || store.getTask(task.id)?.status !== "running") return;
            store.insertStep(task.id, 0, "assistant", { role: "assistant", content });
            void emit("task.step", { status: "running", message: true }, { task_id: task.id, computer_id: task.computer_id })
              .catch((error) => logError("task event failed", { task_id: task.id, error: String(error) }));
          },
          onActivity(activity) {
            if (controller.signal.aborted || store.getTask(task.id)?.status !== "running") return;
            store.insertStep(task.id, 0, "native_tool", activity);
            void emit("native_tool", activity, { task_id: task.id, computer_id: task.computer_id })
              .catch(error => logError("task event failed", { error: String(error) }));
          },
          hasMessages: () => store.pendingMessages(task.id).length > 0,
          takeMessages: () => takeOperatorMessages(task.id),
          onWaitingForMessage(waiting) {
            scope.awaitingMessage = waiting;
            void emit("task.step", { status: "running", message: true }, { task_id: task.id, computer_id: task.computer_id })
              .catch(error => logError("task event failed", { error: String(error) }));
          },
          isWaiting: () => taskWaiting(task.id, task.computer_id),
          waitGeneration: () => scope.waitGeneration,
          isTerminal: () => ["completed", "failed", "cancelled"].includes(store.getTask(task.id)?.status ?? ""),
        });
        // The provider ran a whole task: whatever it refused before is over.
        providerLimits.clear(runnerProvider);
        runtimeProbe.invalidate();
        return { status: store.getTask(task.id)!.status, reason: "completed", steps: 0, usage: { tokens_in: 0, tokens_out: 0, steps: 0 } } as Awaited<ReturnType<typeof runAgentLoop>>;
      } finally { await revokeRunner(task.id); }
    }
    const agent = opts.agentLoop;
    if (!agent) throw new Error("routine execution requires a configured standalone provider");
    const declaredOrigins = origins ? { readable: origins, writable: origins } : agent.declaredOrigins;
    const adapterName = task.adapter ?? agent.adapter.kind;
    // Own properties only: `adapters["constructor"]` is `Object`, not an adapter.
    const named = agent.adapters;
    const adapter = named && Object.hasOwn(named, adapterName) ? named[adapterName]! : agent.adapter;
    const client = getClient(task.computer_id);
    const kind = (task.driver ?? "hybrid") as DriverKind;
    const driver = agent.createDriver?.(kind, client) ??
      (kind === "a11y"
        ? createA11yDriver(client)
        : kind === "vision"
          ? createVisionDriver(client)
          : createHybridDriver(client));
    const capabilities = task.capabilities
      ? (JSON.parse(task.capabilities) as string[])
      : (JSON.parse(store.getComputer(task.computer_id)?.capabilities ?? "[]") as string[]);
    return runAgentLoop({
      signal: controller.signal,
      supportedMethods: computerMethods.get(task.computer_id),
      hasMessages: () => store.pendingMessages(task.id).length > 0,
      isWaiting: () => taskWaiting(task.id, task.computer_id),
      waitForResume: (reason, result) => new Promise<boolean>((resolveWait) => {
        let timer: ReturnType<typeof setTimeout>;
        const finish = (resume: boolean) => {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", abort);
          resolveWait(resume);
        };
        const abort = () => finish(false);
        const check = () => {
          if (controller.signal.aborted || store.getTask(task.id)?.status === "cancelled" ||
              store.getComputer(task.computer_id)?.status !== "running") return finish(false);
          if (store.pendingMessages(task.id).length) return finish(true);
          if (reason === "approval") {
            const id = result && !result.ok ? result.error.details?.approval_id : undefined;
            const approval = typeof id === "string" ? store.getApproval(id) : undefined;
            if (!approval) return finish(false);
            const bind = JSON.parse(approval.bind_json) as { expires: string };
            if (Date.parse(bind.expires) <= Date.now()) return finish(false);
            if (approval.status !== "pending") return finish(approval.status === "approved");
          } else {
            const takeover = store.activeTakeoverForComputer(task.computer_id, task.id);
            if (!takeover) return finish(true);
          }
          timer = setTimeout(check, 100);
        };
        controller.signal.addEventListener("abort", abort, { once: true });
        check();
      }),
      taskId: task.id,
      computerId: task.computer_id,
      goal: task.goal,
      model: agent.models?.[adapterName] ?? agent.model,
      adapter,
      driver,
      computer: client,
      store,
      capabilities,
      declaredOrigins,
      mode: agent.mode,
      maxSteps: task.max_steps,
      resume,
      spendCapUsd: spendCap(task.spend_cap_usd),
      loopIdentical: agent.loopIdentical,
      stallSec: agent.stallSec,
      snapshotMaxBytes: agent.snapshotMaxBytes,
      compactAfterSteps: agent.compactAfterSteps,
      contextMaxBytes: agent.contextMaxBytes,
      compactAt: agent.compactAt,
      contextTokensMax: agent.contextTokensMax,
      tokenCapIn: agent.tokenCapIn,
      policyGate: agent.policyGate,
      dispatchTool: async (tool, args, context) => {
        if (store.pendingMessages(task.id).length) return toolError("E_STALE_REF", "Action not executed: read the new operator message before continuing.");
        const result = await toolDispatcher.dispatch(tool, args, {
          taskId: task.id,
          computerId: task.computer_id,
          origin: context.origin,
          signals: context.signals,
          mode: agent.mode,
          originSets: declaredOrigins,
        });
        noteBrowserHealth(task.computer_id, tool, result);
        return result;
      },
      stopAndAsk: agent.stopAndAsk,
      isCancelled: () => store.getTask(task.id)?.status === "cancelled",
      emit: (event) =>
        emit(event.type, event.body, {
          task_id: event.task_id,
          computer_id: event.computer_id,
        }),
    });
  }

  const routines = startRoutines({
    store,
    autoStart: false,
    createTask: async (input) => {
      if (closing) throw new Error("daemon is shutting down");
      if (!opts.agentLoop) throw new Error("routine execution requires a configured standalone provider");
      const computer = store.getComputer(input.computer_id);
      if (computer?.status !== "running") throw new Error("routine computer is not running");
      const task = store.insertTask({ ...input, max_steps: input.max_steps ?? defaultMaxSteps });
      await emit("task.started", { goal: task.goal }, { task_id: task.id, computer_id: task.computer_id });
      const result = await startStoredTask(task, input.origins);
      return {
        ok: result.status === "completed",
        task_id: task.id,
        cost_usd: result.usage.usd_est,
        ...(result.status !== "completed" ? { error: result.reason } : {}),
      };
    },
  });

  function emit(
    type: EventType,
    body: Record<string, unknown>,
    ids?: { task_id?: string; computer_id?: string },
  ): Promise<void> {
    if (type === "takeover.requested") body = takeoverContext(body);
    if (type.startsWith("takeover.") && ids?.computer_id) sendLiveControl(ids.computer_id);
    if (type === "takeover.requested" && typeof body.takeover_id === "string") scheduleTakeoverExpiry(body.takeover_id);
    const ev = makeEvent(type, body, ids);
    events.emitEvent(ev);
    const payload = JSON.stringify(ev);
    for (const ws of eventSubs) {
      if (ws.readyState === "open") ws.send(payload);
    }
    const append = auditTail.then(async () => {
      const sealed = await auditLog.append({
        type,
        body,
        task_id: ids?.task_id,
        computer_id: ids?.computer_id,
      });
      store.appendAuditRef({
        type,
        body: sealed.body,
        hash: sealed.hash,
        task_id: ids?.task_id,
        computer_id: ids?.computer_id,
      });
    });
    auditTail = append.catch(() => undefined);
    return append;
  }

  toolDispatcher = createToolDispatcher({
    store,
    getClient,
    emit,
    approvalTtlSec: opts.approvalTtlSec,
    onUnsupportedTool: forgetMethod,
    async execute(client, name, args, context) {
      if (name !== "connector_call") return client.call(name, args, context);
      const connectorId = String(args.connector_id ?? "");
      const connectorTool = String(args.tool ?? "");
      const connectorArgs = args.arguments == null
        ? null
        : (args.arguments as Record<string, unknown>);
      return connectors.call(connectorId, connectorTool, connectorArgs);
    },
  });

  async function expireTakeover(takeoverId: string): Promise<void> {
    takeoverTimers.delete(takeoverId);
    const current = store.getTakeover(takeoverId);
    if (!current || current.state === "agent" || current.state === "terminated" || current.state === "paused") return;
    if (!store.getComputer(current.computer_id)) {
      store.updateTakeoverState(takeoverId, "terminated");
      return;
    }
    const result = await getClient(current.computer_id).expireTakeover(takeoverId);
    if (!result.ok) return;
    store.updateTakeoverState(takeoverId, "paused");
    const t1 = new Date().toISOString();
    const t0 = takeoverGapStarts.get(takeoverId);
    if (t0) {
      await emit(
        "takeover.gap",
        { t0, t1, frames_suppressed: true },
        { computer_id: current.computer_id, task_id: current.task_id ?? undefined },
      );
      takeoverGapStarts.delete(takeoverId);
    }
    await emit(
      "takeover.expired",
      { takeover_id: takeoverId },
      { computer_id: current.computer_id, task_id: current.task_id ?? undefined },
    );
  }

  /**
   * Restart the human's lease. The clock runs from the moment control is
   * actually held, not from the moment the bot asked for it, and every relayed
   * input pushes it out again, so a human who is still working never loses the
   * computer to a timeout.
   */
  function renewTakeoverLease(takeoverId: string): void {
    store.setTakeoverExpiry(
      takeoverId,
      new Date(Date.now() + (opts.takeoverTtlSec ?? DEFAULT_TAKEOVER_TTL_SEC) * 1000).toISOString(),
    );
    scheduleTakeoverExpiry(takeoverId);
  }

  function scheduleTakeoverExpiry(takeoverId: string): void {
    const row = store.getTakeover(takeoverId);
    // Only a granted lease runs down. The question the bot asked waits.
    if (!row?.expires_at) return;
    const prior = takeoverTimers.get(takeoverId);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => {
      void expireTakeover(takeoverId).catch((error) =>
        logError("takeover expiry failed", { error: String(error) }),
      );
    }, Date.parse(row.expires_at) - Date.now());
    timer.unref?.();
    takeoverTimers.set(takeoverId, timer);
  }

  await restoreTakeoverExpiries(store, scheduleTakeoverExpiry, expireTakeover);

  async function callTool(
    computerId: string,
    method: string,
    params?: unknown,
  ): Promise<unknown> {
    if (!(TOOL_CATALOGUE.some((tool) => tool.name === method))) {
      return toolError("E_CAPABILITY", "method is not a catalogue tool");
    }
    return toolDispatcher.dispatch(
      method as ToolName,
      (params ?? {}) as Record<string, unknown>,
      { taskId: `direct:${computerId}`, computerId, mode: opts.mode },
    );
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolveBody, reject) => {
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) {
        reject(new RequestBodyTooLargeError());
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      const onData = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_REQUEST_BODY_BYTES) {
          req.off("data", onData);
          req.resume();
          reject(new RequestBodyTooLargeError());
          return;
        }
        chunks.push(Buffer.from(chunk));
      };
      req.on("data", onData);
      req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  function requireUiSession(
    req: IncomingMessage,
    res: ServerResponse,
    mutating: boolean,
  ): { sessionId: string; csrf: string } | null {
    if (isMcpToken(req.headers.authorization, opts.mcpToken)) {
      writeJson(res, 403, {
        error: "E_AUTH",
        message: "mcp_token not valid on UI routes",
      });
      return null;
    }
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies[SESSION_COOKIE];
    if (!sid) {
      writeJson(res, 401, { error: "E_AUTH", message: "missing session" });
      return null;
    }
    const session = store.touchSession(sid);
    if (!session || !sessionOriginMatches(req, session.origin)) {
      writeJson(res, 401, { error: "E_AUTH", message: "invalid session" });
      return null;
    }
    if (mutating) {
      const csrfHdr = req.headers[CSRF_HEADER];
      if (typeof csrfHdr !== "string" || csrfHdr !== session.csrf) {
        writeJson(res, 403, {
          error: "E_AUTH",
          message: "missing or invalid CSRF",
        });
        return null;
      }
    }
    return { sessionId: session.id, csrf: session.csrf };
  }

  function requestOrigin(req: IncomingMessage): string | null {
    const port = (server.address() as AddressInfo | null)?.port ?? wantPort;
    const authority = req.headers.host?.toLowerCase();
    if (publicOrigin && authority === new URL(publicOrigin).host.toLowerCase()) return publicOrigin;
    if (checkHost(authority, port)) return `http://${authority}`;
    if (authority && allowedHosts.some((host) => host.toLowerCase() === authority)) return `https://${authority}`;
    return null;
  }
  function sessionOriginMatches(req: IncomingMessage, origin: string | null): boolean {
    const current = requestOrigin(req);
    // Legacy sessions remain local; changing proxy configuration cannot migrate their authority.
    return origin ? current === origin : Boolean(current?.startsWith("http://"));
  }
  function closeSessionSockets(id: string): void {
    for (const connection of allConnections()) if (connection.loginSession() === id) void connection.cancel(false);
    for (const [ws, sessionId] of socketSessions) if (sessionId === id) ws.close(1008, "operator session revoked");
  }
  function gateHttp(req: IncomingMessage, res: ServerResponse): boolean {
    const portNum = (server.address() as AddressInfo | null)?.port ?? wantPort;
    if (!checkHost(req.headers.host, portNum, allowedHosts)) {
      writeJson(res, 403, { error: "E_AUTH", message: "bad Host" });
      return false;
    }
    const origin = req.headers.origin;
    const expected = requestOrigin(req);
    if (expected?.startsWith("https://") && origin !== undefined && origin !== expected) {
      writeJson(res, 403, { error: "E_AUTH", message: "bad Origin" }); return false;
    }
    if (
      checkApiOrigin(
        typeof origin === "string" ? origin : undefined,
        portNum,
        allowedHosts,
      ) ===
      "bad"
    ) {
      writeJson(res, 403, { error: "E_AUTH", message: "bad Origin" });
      return false;
    }
    return true;
  }

  function takeoverTarget(match: RegExpExecArray, res: ServerResponse) {
    const id = decodeURIComponent(match[1]!);
    const row = store.getTakeover(id);
    if (!row) {
      writeJson(res, 404, { error: "not_found" });
      return null;
    }
    return { id, row, client: getClient(row.computer_id) };
  }

  async function writeConnector(
    res: ServerResponse,
    run: () => Promise<ConnectorPublicView>,
  ): Promise<void> {
    try {
      writeJson(res, 200, { connector: await run() });
    } catch (e) {
      writeJson(res, 404, {
        error: "not_found",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function cancelTasksOn(computerId: string): Promise<void> {
    for (const task of store.listTasks()) {
      if (task.computer_id === computerId && task.status === "running") await cancelTask(task.id);
    }
  }

  async function handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const method = req.method ?? "GET";
    const path = url.pathname;

    if (path === "/healthz" && method === "GET") {
      writeJson(res, 200, { ok: true, version: "0.0.1" });
      return;
    }

    if (path === "/api/v1/session/bootstrap" && method === "GET") {
      writeJson(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
      return;
    }

    if (path === "/api/v1/session/bootstrap" && method === "POST") {
      if (!gateHttp(req, res)) return;
      if (typeof req.headers.origin !== "string") {
        writeJson(res, 403, { error: "E_AUTH", message: "Origin required" });
        return;
      }
      let token: string | undefined;
      let label = "Browser";
      const raw = await readBody(req);
      if (raw) {
        try {
          const body = JSON.parse(raw) as {
            token?: string;
            bootstrap_token?: string;
            label?: string;
          };
          token = body.token ?? body.bootstrap_token;
          if (body.label !== undefined) {
            if (typeof body.label !== "string" || !body.label.trim() || body.label.length > 80) throw new Error("invalid label");
            label = body.label.trim();
          }
        } catch {
          writeJson(res, 400, { error: "E_IO", message: "invalid JSON" });
          return;
        }
      }
      const origin = requestOrigin(req);
      if (typeof token !== "string" || !token || token.length > 256 || !origin || req.headers.origin !== origin) {
        writeJson(res, 401, {
          error: "E_AUTH",
          message: "invalid bootstrap token",
        });
        return;
      }
      const suppliedHash = createHash("sha256").update(token!).digest("hex");
      if (!store.consumeBootstrapToken(suppliedHash, undefined, origin)) {
        writeJson(res, 401, {
          error: "E_AUTH",
          message: "bootstrap token expired or already used",
        });
        return;
      }
      const session = store.createSession(undefined, origin, label);
      writeJson(
        res,
        200,
        { ok: true, csrf: session.csrf, mode: opts.mode ?? "supervised", ...executionInfo, licence: licenceState(store, opts.licencePolicy) },
        { "set-cookie": sessionCookieHeader(session.id, origin.startsWith("https://")) },
      );
      return;
    }

    if (path === "/api/v1/session/logout" && method === "POST") {
      if (!gateHttp(req, res)) return;
      const session = requireUiSession(req, res, true);
      if (!session) return;
      store.deleteSession(session.sessionId);
      closeSessionSockets(session.sessionId);
      writeJson(
        res,
        200,
        { ok: true },
        { "set-cookie": clearSessionCookieHeader(Boolean(requestOrigin(req)?.startsWith("https://"))) },
      );
      return;
    }

    if (path === "/api/v1/session" && method === "GET") {
      if (!gateHttp(req, res)) return;
      const session = requireUiSession(req, res, false);
      if (!session) return;
      if (opts.codexRunner) await connectionStatus();
      writeJson(res, 200, { ok: true, csrf: session.csrf, public_origin: publicOrigin ?? null, origin: requestOrigin(req), expires_at: store.getSession(session.sessionId)!.expires_at, mode: opts.mode ?? "supervised", ...executionInfo, licence: licenceState(store, opts.licencePolicy) });
      return;
    }

    if (path === "/api/v1/session/pairings" && method === "POST") {
      if (!gateHttp(req, res)) return;
      const issuer = requireUiSession(req, res, true);
      if (!issuer) return;
      const origin = publicOrigin ?? requestOrigin(req);
      if (!origin) { writeJson(res, 403, { error: "E_AUTH" }); return; }
      const pairing = store.createPairing(origin, issuer.sessionId);
      if (!pairing) { writeJson(res, 429, { error: "E_LIMIT", message: "Too many unused pairing links. Wait ten minutes before creating another." }); return; }
      writeJson(res, 201, pairing, { "cache-control": "no-store" });
      return;
    }
    if (path === "/api/v1/session/devices" && method === "GET") {
      if (!gateHttp(req, res)) return;
      const session = requireUiSession(req, res, false);
      if (!session) return;
      writeJson(res, 200, { devices: store.listSessions().map((device) => ({
        id: deviceId(device.id), label: device.label, created_at: device.created_at,
        expires_at: device.expires_at, current: device.id === session.sessionId,
      })) }, { "cache-control": "no-store" });
      return;
    }
    const deviceMatch = /^\/api\/v1\/session\/devices\/([a-f0-9]{32})$/.exec(path);
    if (deviceMatch && method === "DELETE") {
      if (!gateHttp(req, res)) return;
      if (!requireUiSession(req, res, true)) return;
      const device = store.listSessions().find((entry) => deviceId(entry.id) === deviceMatch[1]);
      if (device) { store.deleteSession(device.id); closeSessionSockets(device.id); }
      writeJson(res, 200, { ok: true });
      return;
    }

    const scopedPath = /^\/mcp\/tasks\/([^/]+)$/.exec(path);
    if (scopedPath) {
      const entry = scopedMcp.get(decodeURIComponent(scopedPath[1]!));
      if (!entry || !entry.scope.active) { writeJson(res, 401, { error: "E_AUTH" }); return; }
      if (!await entry.handler.handle(req, res)) writeJson(res, 404, { error: "not_found" });
      return;
    }

    if (path === "/mcp") {
      const handled = await mcpHttp.handle(req, res);
      if (!handled) {
        writeJson(res, 404, { error: "not_found" });
      }
      return;
    }

    if (!path.startsWith("/api/v1/")) {
      if (createUiStaticHandler()(req, res)) return;
      writeJson(res, 404, { error: "not_found" });
      return;
    }
    if (!gateHttp(req, res)) return;

    const mutating = method !== "GET" && method !== "HEAD";
    const session = requireUiSession(req, res, mutating);
    if (!session) return;

    if (path === "/api/v1/licence" && method === "GET") {
      writeJson(res, 200, licenceState(store, opts.licencePolicy), { "cache-control": "no-store" }); return;
    }
    if (path === "/api/v1/licence/activate" && method === "POST") {
      if (!opts.licencePolicy) { writeJson(res, 409, { error: "E_LICENCE", message: "This release uses its existing licence terms. No activation is required." }); return; }
      try {
        const body = JSON.parse(await readBody(req));
        if (typeof body?.certificate !== "string") throw new Error("Paste your BotHearth licence key.");
        const state = activateLicence(store, opts.licencePolicy, body.certificate);
        writeJson(res, 200, state, { "cache-control": "no-store" });
      } catch (error) {
        writeJson(res, 400, { error: "E_LICENCE", message: error instanceof SyntaxError ? "Send a licence key as JSON."
          : error instanceof Error ? error.message : "This key could not be verified." });
      }
      return;
    }

    if (path === "/api/v1/connection" && method === "GET") {
      const provider = url.searchParams.get("provider");
      if (provider && provider !== "codex" && provider !== "claude") { writeJson(res, 400, { error: "E_PROVIDER" }); return; }
      const computerId = url.searchParams.get("computer_id") ?? undefined;
      if (computerId && !store.getComputer(computerId)) { writeJson(res, 404, { error: "not_found" }); return; }
      writeJson(res, 200, await connectionStatus(provider === "claude" ? "claude" : provider === "codex" ? "codex" : undefined, session.sessionId, computerId), { "cache-control": "no-store" }); return;
    }
    const connectionAction = /^\/api\/v1\/connection\/(connect|sign-in|cancel|input)$/.exec(path);
    if (connectionAction && method === "POST") {
      let body: { model?: string; provider?: "codex" | "claude"; auth?: "subscription" | "console"; computer_id?: string; text?: string };
      try { body = JSON.parse(await readBody(req) || "{}"); }
      catch { writeJson(res, 400, { error: "E_IO", message: "Invalid connection request." }); return; }
      if (!body || typeof body !== "object") { writeJson(res, 400, { error: "E_IO", message: "Invalid connection request." }); return; }
      if (body.model !== undefined && (typeof body.model !== "string" || (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/@+\[\]-]{0,511}$/.test(body.model) && !(body.model === "" && (body.provider ?? opts.codexRunner?.provider) === "claude")))) {
        writeJson(res, 400, { error: "E_IO", message: "Enter a supported model name." }); return;
      }
      if ((body.provider !== undefined && !["codex", "claude"].includes(body.provider)) || (body.auth !== undefined && !["subscription", "console"].includes(body.auth))) { writeJson(res, 400, { error: "E_PROVIDER" }); return; }
      const provider = body.provider ?? opts.codexRunner?.provider ?? "codex";
      const action = connectionAction[1];
      if (body.computer_id !== undefined && (typeof body.computer_id !== "string" || !store.getComputer(body.computer_id))) {
        writeJson(res, 404, { error: "not_found", message: "Computer not found." }); return;
      }
      let computerId = body.computer_id ?? defaultComputer()?.id;
      if (guestExecution && (action === "sign-in" || action === "connect")) {
        try {
          computerId ??= (await resolveDefaultComputer()).id;
          if (sandbox.start) await sandbox.start(computerId);
          store.setComputerStatus(computerId, "running");
          await idlePause.wake(computerId);
        } catch {
          writeJson(res, 503, { error: "E_RUNTIME", message: "Your computer could not start. Complete computer setup, then try sign-in again." }); return;
        }
      }
      const connection = connectionFor(provider, computerId);
      if (!connection) { writeJson(res, 409, { error: "E_STATE", message: "Start sign-in first." }); return; }
      if (action === "input") {
        if (typeof body.text !== "string" || !connection.input(body.text, session.sessionId)) {
          writeJson(res, 409, { error: "E_STATE", message: "This sign-in is not waiting for a reply from this window." }); return;
        }
        writeJson(res, 202, { ok: true }, { "cache-control": "no-store" }); return;
      }
      if (action !== "cancel") await connectionFor(provider === "codex" ? "claude" : "codex", computerId)?.cancel(false);
      const result = action === "connect" ? await connection.connect(body.model || undefined, session.sessionId) :
        action === "sign-in" ? await connection.signIn(body.model || undefined, body.auth, session.sessionId) : await connection.cancel();
      writeJson(res, 200, { ...result, execution_location: guestExecution ? "computer" : "host", ...(computerId ? { computer_id: computerId } : {}) }, { "cache-control": "no-store" });
      return;
    }

    if (path === "/api/v1/runtime" && method === "GET") {
      const snapshot = await runtimeProbe.snapshot();
      const licence = licenceState(store, opts.licencePolicy);
      const blocked = licence.required && licence.status !== "active";
      writeJson(res, 200, { ...withoutBuildLog(snapshot), ...(blocked ? { task_start_available: false,
        blockers: [...snapshot.blockers, { id: "licence_required", title: "Add your licence key",
          detail: "Get your key from your BotHearth account, then add it in Settings.", action: { kind: "open_settings", url: "#/settings/licence" } }] } : {}), licence }, { "cache-control": "no-store" });
      return;
    }

    if (path === "/api/v1/runtime/prepare" && method === "POST") {
      // 409 only guards a run already in flight, so after a failure a
      // client could restart `docker build` in a tight loop. One attempt per
      // cooldown, whatever the outcome of the last one.
      const since = Date.now() - lastPrepareAt;
      if (since < PREPARE_COOLDOWN_MS) {
        writeJson(res, 429, { error: "E_BUSY", message: "Setup was just tried. Give it a moment before trying again.",
          retry_after_sec: Math.ceil((PREPARE_COOLDOWN_MS - since) / 1000) },
          { "retry-after": String(Math.ceil((PREPARE_COOLDOWN_MS - since) / 1000)) });
        return;
      }
      const attempt = imagePreparer.start();
      if (!attempt.started) {
        writeJson(res, 409, { error: "E_BUSY", message: "Setup is already running.", prepare: redactPrepare(attempt.state) });
        return;
      }
      lastPrepareAt = Date.now();
      runtimeProbe.invalidate();
      // A rebuilt tag is invisible to a container that already exists, so the
      // build only reaches the owner's computer once it is recreated from it.
      void imagePreparer.settled()?.then(async () => {
        if (imagePreparer.snapshot().state === "done") await reconcileComputerImages();
        runtimeProbe.invalidate();
      });
      writeJson(res, 202, { prepare: redactPrepare(attempt.state) }, { "cache-control": "no-store" });
      return;
    }

    if (path === "/api/v1/computers" && method === "GET") {
      const computers = store.listComputers();
      writeJson(res, 200, {
        default_computer_id: defaultComputer()?.id ?? null,
        will_create_default: !defaultComputer(),
        computers: computers.map((c) => ({
          id: c.id,
          name: c.name,
          capabilities: JSON.parse(c.capabilities) as ComputerCapability[],
          persistent: Boolean(c.persistent),
          status: c.status,
          created_at: c.created_at,
        })),
      });
      return;
    }

    if (path === "/api/v1/computers" && method === "POST") {
      const raw = await readBody(req);
      let body: CreateComputerBody;
      try {
        body = JSON.parse(raw) as CreateComputerBody;
      } catch {
        writeJson(res, 400, { error: "E_IO", message: "invalid JSON" });
        return;
      }
      if (!body?.name || !Array.isArray(body.capabilities)) {
        writeJson(res, 400, {
          error: "E_IO",
          message: "name and capabilities required",
        });
        return;
      }
      const computer = await provisionComputer(body);
      writeJson(res, 201, { computer: { id: computer.id, name: computer.name,
        capabilities: JSON.parse(computer.capabilities), status: computer.status } });
      return;
    }

    const defaultMatch = /^\/api\/v1\/computers\/([^/]+)\/default$/.exec(path);
    if (defaultMatch && method === "POST") {
      const computer = store.getComputer(decodeURIComponent(defaultMatch[1]!));
      if (!computer) { writeJson(res, 404, { error: "not_found", message: "Workspace not found." }); return; }
      if (!JSON.parse(computer.capabilities).includes("browser")) {
        writeJson(res, 400, { error: "E_CAPABILITY", message: "The default workspace needs a browser." }); return;
      }
      store.setDefaultComputerId(computer.id);
      writeJson(res, 200, { default_computer_id: computer.id });
      return;
    }

    if (path === "/api/v1/harness-bindings" && method === "POST") {
      const raw = await readBody(req);
      let body: CreateHarnessBindingBody;
      try {
        body = JSON.parse(raw) as CreateHarnessBindingBody;
      } catch {
        writeJson(res, 400, { error: "E_IO", message: "invalid JSON" });
        return;
      }
      const validCap = typeof body?.spend_cap_usd === "number" &&
        Number.isFinite(body.spend_cap_usd) && body.spend_cap_usd >= 0;
      const validSteps = Number.isInteger(body?.max_steps) && body.max_steps > 0;
      if (
        !body?.task_id || !body.computer_id || body.execution !== "harness" ||
        !validCap || !validSteps
      ) {
        writeJson(res, 400, {
          error: "E_IO",
          message: "task_id, computer_id, execution=harness, non-negative spend_cap_usd, and positive max_steps required",
        });
        return;
      }
      if (!store.getComputer(body.computer_id)) {
        writeJson(res, 404, { error: "not_found", message: "computer" });
        return;
      }
      const prior = store.getHarnessTaskBinding(body.computer_id);
      if ((prior && !["completed", "failed", "cancelled"].includes(store.getTask(prior.task_id)?.status ?? "")) ||
        harnessCallsInFlight.has(body.computer_id) || computersCancelling.has(body.computer_id)) {
        writeJson(res, 409, {
          error: "E_POLICY",
          message: "computer has an active harness task; finish or cancel it before rebinding",
        });
        return;
      }
      if (store.getTask(body.task_id)) {
        writeJson(res, 409, { error: "E_POLICY", message: "task_id has already been used" });
        return;
      }
      const proxyUsd = perCallUsd;
      if (!Number.isFinite(proxyUsd) || proxyUsd <= 0) {
        writeJson(res, 500, { error: "E_IO", message: "invalid daemon MCP proxy rate" });
        return;
      }
      const binding = store.insertHarnessTaskBinding({
        task_id: body.task_id,
        computer_id: body.computer_id,
        spend_cap_usd: body.spend_cap_usd,
        max_steps: body.max_steps,
        proxy_usd_per_tool_call: proxyUsd,
      });
      writeJson(res, 201, { binding });
      return;
    }

    const computerStart = /^\/api\/v1\/computers\/([^/]+)\/start$/.exec(path);
    if (computerStart && method === "POST") {
      const id = decodeURIComponent(computerStart[1]!);
      if (!store.getComputer(id)) {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      if (sandbox.start) await sandbox.start(id);
      store.setComputerStatus(id, "running");
      idlePause.track(id);
      await idlePause.wake(id);
      writeJson(res, 200, { ok: true, status: "running" });
      return;
    }

    const computerStop = /^\/api\/v1\/computers\/([^/]+)\/stop$/.exec(path);
    if (computerStop && method === "POST") {
      const id = decodeURIComponent(computerStop[1]!);
      if (!store.getComputer(id)) {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      await cancelTasksOn(id);
      await sandbox.stop(id);
      idlePause.forget(id);
      store.setComputerStatus(id, "stopped");
      emit("sandbox.stopped", { computer_id: id }, { computer_id: id });
      writeJson(res, 200, { ok: true, status: "stopped" });
      return;
    }

    const computerDel = /^\/api\/v1\/computers\/([^/]+)$/.exec(path);
    if (computerDel && method === "DELETE") {
      const id = decodeURIComponent(computerDel[1]!);
      if (!store.getComputer(id)) {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      await cancelTasksOn(id);
      await sandbox.destroy(id);
      idlePause.forget(id);
      const client = clients.get(id);
      if (client) {
        await client.close();
        clients.delete(id);
      }
      store.deleteComputer(id);
      writeJson(res, 200, { ok: true });
      return;
    }

    const computerFiles = /^\/api\/v1\/computers\/([^/]+)\/files$/.exec(path);
    // A receipt names a task and a path, never a computer, so anything reading
    // the API the way the receipt reads asks for the task's own file. Both
    // spellings resolve to the same computer, the same jail and the same 404;
    // only the id is looked up differently.
    const taskFiles = /^\/api\/v1\/tasks\/([^/]+)\/files$/.exec(path);
    // HEAD answers "is this file still there?" without moving the
    // bytes, so the Open button can say "this isn't here any more" instead of
    // doing nothing at all. Same route, same jail, same 404 — only the body is
    // dropped (node suppresses it for HEAD).
    if ((computerFiles || taskFiles) && (method === "GET" || method === "HEAD")) {
      const id = computerFiles
        ? decodeURIComponent(computerFiles[1]!)
        : store.getTask(decodeURIComponent(taskFiles![1]!))?.computer_id ?? "";
      if (!store.getComputer(id)) {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      if (id.includes("/") || id.includes("\\") || id.includes("..")) {
        writeJson(res, 403, { error: "E_POLICY", message: "invalid computer id" });
        return;
      }
      const rel = url.searchParams.get("path") ?? "";
      if (!rel || rel.includes("\0")) {
        writeJson(res, 400, { error: "E_POLICY", message: "path required" });
        return;
      }
      try {
        const configuredBase = sandbox.get?.(id)?.workspaceRoot ?? join(workspaceRoot, id);
        const lexicalBase = resolve(configuredBase);
        // Older receipts record a bare filename where newer ones record
        // `out/today.md`, and a bare name resolves to the
        // workspace root, where nothing is — so Open on an older receipt 404'd
        // on a file that is genuinely there. Both spellings are tried, and both
        // are jailed the same way; the shorthand is only ever `out/`, which is
        // the one directory a task writes into.
        const bare = !rel.includes("/") && !rel.includes("\\");
        const lexicalTarget =
          bare && !statSync(resolve(lexicalBase, rel), { throwIfNoEntry: false })?.isFile()
            ? resolve(lexicalBase, "out", rel)
            : resolve(lexicalBase, rel);
        if (
          lexicalTarget !== lexicalBase &&
          !lexicalTarget.startsWith(lexicalBase + sep)
        ) {
          writeJson(res, 403, { error: "E_POLICY", message: "path jail" });
          return;
        }
        const base = await realpath(lexicalBase);
        const target = await realpath(lexicalTarget);
        if (target !== base && !target.startsWith(base + sep)) {
          writeJson(res, 403, { error: "E_POLICY", message: "path jail" });
          return;
        }
        const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) throw new Error("not a file");
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": stat.size,
            "content-disposition": contentDisposition(rel),
            "x-content-type-options": "nosniff",
          });
          // Guest-created files can be large. Stream with backpressure and
          // stop at the advertised length even if the guest appends data.
          if (method === "HEAD" || stat.size === 0) res.end();
          else await pipeline(handle.createReadStream({ autoClose: false, end: stat.size - 1 }), res);
        } finally {
          await handle.close();
        }
      } catch {
        if (res.headersSent) res.destroy();
        else fileGone(req, res);
      }
      return;
    }

    const quarantineList = /^\/api\/v1\/computers\/([^/]+)\/quarantine$/.exec(path);
    if (quarantineList && method === "GET") {
      const id = decodeURIComponent(quarantineList[1]!);
      if (!store.getComputer(id)) {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      const result = await getClient(id).call("quarantine.list");
      writeJson(res, result.ok ? 200 : 409, result.ok ? result.data : result);
      return;
    }

    const quarantinePromote =
      /^\/api\/v1\/computers\/([^/]+)\/quarantine\/([^/]+)\/promote$/.exec(path);
    if (quarantinePromote && method === "POST") {
      const computerId = decodeURIComponent(quarantinePromote[1]!);
      const itemId = decodeURIComponent(quarantinePromote[2]!);
      if (!store.getComputer(computerId)) {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      const result = await getClient(computerId).call("quarantine.promote", { id: itemId });
      if (!result.ok) {
        writeJson(res, 409, result);
        return;
      }
      const promoted = result.data as Record<string, unknown>;
      await emit(
        "download.promoted",
        {
          approved_by: "human",
          ui_session_hash: createHash("sha256").update(session.sessionId).digest("hex"),
          item_id: itemId,
          item_name: promoted.name,
          computer_id: computerId,
          workspace_path: promoted.workspace_path,
        },
        { computer_id: computerId },
      );
      writeJson(res, 200, { download: promoted });
      return;
    }

    if (path === "/api/v1/tasks" && method === "GET") {
      writeJson(res, 200, { tasks: store.listTasks() });
      return;
    }

    if (path === "/api/v1/models" && method === "GET") {
      const requested = url.searchParams.get("provider");
      const computerId = url.searchParams.get("computer_id") ?? defaultComputer()?.id;
      if (computerId && !store.getComputer(computerId)) { writeJson(res, 404, { error: "not_found" }); return; }
      if (requested && requested !== "codex" && requested !== "claude") {
        writeJson(res, 400, { error: "E_PROVIDER", message: "Choose Codex or Claude Code." }); return;
      }
      // Opening the task composer is activity; ordinary status polls still leave idle computers asleep.
      if (guestExecution && computerId && !store.activeTakeoverForComputer(computerId)) await idlePause.wake(computerId);
      const providers = await Promise.all((requested ? [requested as NativeProvider] : ["codex", "claude"] as const).map(async (provider) => {
        const config = nativeRunnerConfig(provider);
        const [catalog, state] = await Promise.all([
          getNativeModelCatalog(provider, { home: config.codexHome, binary: config.binary, configuredModel: config.model,
            ...(guestExecution ? { computerId: computerId ?? "unprepared", spawn: (args: string[]) => computerId
              ? guestSpawn(computerId, provider, args) : Promise.reject(new Error("Computer not prepared")) } : {}) }),
          connectionStatus(provider, undefined, computerId),
        ]);
        const connected = state.status === "connected" || state.status === "signed_in";
        return { ...catalog, id: provider, label: provider === "codex" ? "Codex" : "Claude Code",
          connected, connection_status: state.status, limit: state.limit ?? null,
          start_available: connected && !state.limit };
      }));
      writeJson(res, 200, { providers });
      return;
    }

    if (path === "/api/v1/tasks" && method === "POST") {
      const licence = licenceState(store, opts.licencePolicy);
      if (licence.required && licence.status !== "active") {
        writeJson(res, 403, { error: "E_LICENCE_REQUIRED", message: "Add your BotHearth licence key in Settings to start a task." }); return;
      }
      const raw = await readBody(req);
      let body: CreateTaskBody;
      try {
        body = JSON.parse(raw) as CreateTaskBody;
      } catch {
        writeJson(res, 400, { error: "E_IO", message: "invalid JSON" });
        return;
      }
      if (typeof body?.goal !== "string" || !body.goal.trim() ||
          (body.computer_id !== undefined && (typeof body.computer_id !== "string" || !body.computer_id))) {
        writeJson(res, 400, { error: "E_IO", message: "Describe the task you want completed." }); return;
      }
      const native = Boolean(opts.codexRunner) || body.adapter === "codex" || body.adapter === "claude";
      let nativeSettings: NativeTaskSettings | undefined;
      if (native) {
        try {
          const adapter = opts.codexRunner?.provider ?? "codex";
          nativeSettings = resolveNativeTaskSettings(body, { adapter, model: nativeRunnerConfig(adapter).model,
            models: { codex: nativeRunnerConfig("codex").model, claude: nativeRunnerConfig("claude").model } });
        } catch (error) {
          writeJson(res, 400, { error: "E_MODEL", message: error instanceof Error ? error.message : "Invalid model selection." }); return;
        }
        const selectedComputer = body.computer_id ?? defaultComputer()?.id;
        if (guestExecution && selectedComputer) {
          if (!store.getComputer(selectedComputer)) { writeJson(res, 404, { error: "not_found", message: "Computer not found." }); return; }
          if (store.activeTakeoverForComputer(selectedComputer)) { writeJson(res, 409, { error: "E_STATE", message: "Return control of this computer before starting another task." }); return; }
          if (sandbox.start) await sandbox.start(selectedComputer);
          await idlePause.wake(selectedComputer);
        }
        const state = await connectionStatus(nativeSettings.adapter, session.sessionId, body.computer_id);
        if (state.status !== "connected" && state.status !== "signed_in") {
          writeJson(res, 503, { error: "E_PROVIDER_UNAVAILABLE", message: `Connect ${nativeSettings.adapter === "codex" ? "Codex" : "Claude Code"} before starting.`,
            provider: nativeSettings.adapter, status: state.status }); return;
        }
        if (nativeSettings.executor && nativeSettings.executor.adapter !== nativeSettings.adapter) {
          const executorState = await connectionStatus(nativeSettings.executor.adapter, session.sessionId, body.computer_id);
          if (executorState.status !== "connected" && executorState.status !== "signed_in") {
            writeJson(res, 503, { error: "E_PROVIDER_UNAVAILABLE", message: "Connect the selected executor before starting orchestration.",
              provider: nativeSettings.executor.adapter, status: executorState.status }); return;
          }
        }
      } else if (!executionInfo.task_start_available) {
        writeJson(res, 503, { error: "E_PROVIDER_UNAVAILABLE", message: "Configure a task runner before starting a task." }); return;
      }
      if (body.max_steps !== undefined && (!Number.isInteger(body.max_steps) || body.max_steps < 1)) {
        writeJson(res, 400, { error: "E_LIMIT", message: "max_steps must be a positive integer" }); return;
      }
      if (body.spend_cap_usd !== undefined &&
          (typeof body.spend_cap_usd !== "number" || !Number.isFinite(body.spend_cap_usd) || body.spend_cap_usd < 0)) {
        writeJson(res, 400, { error: "E_LIMIT", message: "spend_cap_usd must be a non-negative number" }); return;
      }
      if (typeof body.spend_cap_usd === "number" && body.spend_cap_usd > spendCapMax()) {
        writeJson(res, 400, { error: "E_LIMIT",
          message: `spend_cap_usd must not exceed the configured cap of ${spendCapMax()}` }); return;
      }
      // An unvalidated adapter name is later looked up on a plain object,
      // where "constructor" resolves to `Object` — truthy, so it survives every
      // fallback and fails deep inside the run instead of here.
      if (body.adapter !== undefined && !native) {
        const known = new Set(Object.keys(opts.agentLoop?.adapters ?? {}));
        if (opts.agentLoop) known.add(opts.agentLoop.adapter.kind);
        if (typeof body.adapter !== "string" || !known.has(body.adapter)) {
          writeJson(res, 400, { error: "E_IO",
            message: `Unknown adapter. Available: ${[...known].sort().join(", ") || "none"}.` });
          return;
        }
      }
      const automatic = body.computer_id === undefined;
      if (automatic && body.capabilities !== undefined && (!Array.isArray(body.capabilities) || body.capabilities.length !== 1 || body.capabilities[0] !== "browser")) {
        writeJson(res, 400, { error: "E_CAPABILITY", message: "Choose a workspace in Advanced to customize its tools." }); return;
      }
      let computer: ComputerRow | undefined;
      try { computer = automatic ? await resolveDefaultComputer() : store.getComputer(body.computer_id!); }
      catch {
        writeJson(res, 503, { error: "E_SANDBOX", message: "Your workspace could not be prepared. Check the browser setup in Advanced, then try again." }); return;
      }
      if (!computer) { writeJson(res, 404, { error: "not_found", message: "Workspace not found." }); return; }
      const computerId = computer.id;
      const available = JSON.parse(computer.capabilities) as ComputerCapability[];
      const capabilities: ComputerCapability[] = body.capabilities ?? (automatic ? ["browser"] : available);
      if (!Array.isArray(capabilities) || !capabilities.length || capabilities.some((cap) => !available.includes(cap))) {
        writeJson(res, 400, { error: "E_CAPABILITY", message: "Task capabilities must belong to the selected computer" }); return;
      }
      const rejectBusy = () => {
        const activeTask = store.listTasks().find((task) => task.computer_id === computerId && ["running", "paused"].includes(task.status));
        if (!computersCancelling.has(computerId) && (!(automatic || native) || (!harnessCallsInFlight.has(computerId) && !activeTask))) return false;
        writeJson(res, 409, { error: "E_TASK_ACTIVE", message: "Your current task is still working. Open it to continue or stop it before starting another.", task_id: activeTask?.id });
        return true;
      };
      if (rejectBusy()) return;
      if (computer.status !== "running") {
        try {
          if (!sandbox.start) throw new Error("start unavailable");
          await sandbox.start(computerId); store.setComputerStatus(computerId, "running");
          if (rejectBusy()) return;
        } catch {
          writeJson(res, 503, { error: "E_SANDBOX", message: "Your workspace could not be started. Check its setup in Advanced, then try again." }); return;
        }
      }
      if (closing) { writeJson(res, 503, { error: "E_IO", message: "The application is restarting. Try again shortly." }); return; }
      if (automatic) store.setDefaultComputerId(computerId);
      let task: TaskRow;
      if (nativeSettings) {
        const taskId = `task_${randomBytes(12).toString("hex")}`;
        store.insertHarnessTaskBinding({ task_id: taskId, computer_id: computerId,
          spend_cap_usd: spendCap(body.spend_cap_usd), max_steps: body.max_steps ?? defaultMaxSteps,
          proxy_usd_per_tool_call: perCallUsd });
        store.db.prepare("UPDATE tasks SET goal = ?, adapter = ?, capabilities = ? WHERE id = ?")
          .run(body.goal, nativeSettings.adapter, JSON.stringify(capabilities), taskId);
        store.insertStep(taskId, 0, "native_settings", { ...nativeSettings, execution_location: guestExecution ? "computer" : "host" });
        task = store.getTask(taskId)!;
      } else task = store.insertTask({
        computer_id: computerId,
        goal: body.goal,
        adapter: body.adapter,
        driver: body.driver as DriverKind | undefined,
        capabilities,
        max_steps: body.max_steps ?? defaultMaxSteps,
        // Resolved now, not at each read: the task carries the figure it will
        // actually be stopped at, so nothing downstream has to guess.
        spend_cap_usd: spendCap(body.spend_cap_usd),
      });
      emit(
        "task.started",
        { goal: task.goal },
        { task_id: task.id, computer_id: task.computer_id },
      );
      emit(
        "usage",
        { tokens_in: 0, tokens_out: 0, usd_est: 0, steps: 0 },
        { task_id: task.id, computer_id: task.computer_id },
      );
      if (nativeSettings || executionInfo.task_start_available) void startStoredTask(task).catch((error) => logError("task execution failed", { task_id: task.id, error: String(error) }));
      writeJson(res, 201, { task });
      return;
    }

    const resultPath = /^\/api\/v1\/tasks\/([^/]+)\/results\/([1-9][0-9]*)$/.exec(path);
    if (resultPath && method === "GET") {
      const id = decodeURIComponent(resultPath[1]!);
      const seq = Number(resultPath[2]);
      const result = store.getTask(id) && Number.isSafeInteger(seq) ? taskResult(store, id, seq) : null;
      if (!result) { writeJson(res, 404, { error: "not_found" }); return; }
      writeJson(res, 200, result);
      return;
    }

    const taskDetail = /^\/api\/v1\/tasks\/([^/]+)$/.exec(path);
    if (taskDetail && method === "GET") {
      const task = store.getTask(decodeURIComponent(taskDetail[1]!));
      if (!task) { writeJson(res, 404, { error: "not_found" }); return; }
      // Where this task's saved files actually live on this Mac, so the native
      // shell can reveal the folder in Finder instead of the app having to
      // guess the workspace layout.
      const workspace = sandbox.get?.(task.computer_id)?.workspaceRoot ?? join(workspaceRoot, task.computer_id);
      const results_dir = join(workspace, "out");
      // The frozen receipt is a snapshot, and a snapshot can outlive
      // the files it names — a task that finished before the receipt learned to
      // read outcomes froze files that were never written at all. Nothing may
      // be offered for opening that is not there, so the list is checked
      // against the disk on the way out, once per path.
      writeJson(res, 200, {
        task: {
          ...verifiedArtifacts(task, workspace),
          results_dir,
          awaiting_message: scopedMcp.get(task.id)?.scope.awaitingMessage === true,
          ...taskBudget(store, task, spendCapDefault()),
        },
        ...taskActivity(store, task.id),
      });
      return;
    }

    const taskMessage = /^\/api\/v1\/tasks\/([^/]+)\/messages$/.exec(path);
    if (taskMessage && method === "POST") {
      const task = store.getTask(decodeURIComponent(taskMessage[1]!));
      if (!task) { writeJson(res, 404, { error: "not_found" }); return; }
      if (task.status !== "running") { writeJson(res, 409, { error: "Task must be running to receive a message" }); return; }
      let body: { text?: unknown } | null;
      try { body = JSON.parse(await readBody(req)); }
      catch { writeJson(res, 400, { error: "Invalid JSON" }); return; }
      if (!body || typeof body.text !== "string" || !body.text.trim() || body.text.length > 8000) {
        writeJson(res, 400, { error: "Message must contain 1–8000 characters" }); return;
      }
      if (store.pendingMessages(task.id).length >= 20) {
        writeJson(res, 429, { error: "Wait for the bot to read your queued messages" }); return;
      }
      store.insertStep(task.id, 0, "user", { role: "user", content: body.text.trim() });
      await emit("task.step", { status: "running", message: true }, { task_id: task.id, computer_id: task.computer_id });
      writeJson(res, 202, { queued: true });
      return;
    }

    const taskResume = /^\/api\/v1\/tasks\/([^/]+)\/resume$/.exec(path);
    if (taskResume && method === "POST") {
      const id = decodeURIComponent(taskResume[1]!);
      const task = store.getTask(id);
      if (!task) { writeJson(res, 404, { error: "not_found" }); return; }
      const raw = (await readBody(req)).trim();
      let raise: number | undefined;
      let steps: number | undefined;
      let runtimeSec: number | undefined;
      try {
        const body = raw ? JSON.parse(raw) as { spend_cap_usd?: number; max_steps?: number; max_runtime_sec?: number } : {};
        if (body.spend_cap_usd !== undefined) {
          if (typeof body.spend_cap_usd !== "number" || !Number.isFinite(body.spend_cap_usd) || body.spend_cap_usd < 0) {
            writeJson(res, 400, { error: "E_LIMIT", message: "spend_cap_usd must be a non-negative number" });
            return;
          }
          if (body.spend_cap_usd > spendCapMax()) {
            writeJson(res, 400, { error: "E_LIMIT",
              message: `spend_cap_usd must not exceed the configured cap of ${spendCapMax()}` });
            return;
          }
          raise = body.spend_cap_usd;
        }
        if (body.max_steps !== undefined) {
          if (!Number.isInteger(body.max_steps) || body.max_steps < 1) {
            writeJson(res, 400, { error: "E_LIMIT", message: "max_steps must be a positive integer" });
            return;
          }
          steps = body.max_steps;
        }
        if (body.max_runtime_sec !== undefined) {
          if (!Number.isInteger(body.max_runtime_sec) || body.max_runtime_sec < 0) {
            writeJson(res, 400, { error: "E_LIMIT", message: "max_runtime_sec must be a non-negative integer" });
            return;
          }
          runtimeSec = body.max_runtime_sec;
        }
      } catch {
        writeJson(res, 400, { error: "E_IO", message: "invalid JSON" });
        return;
      }
      if (task.status !== "paused") {
        writeJson(res, 409, { error: "E_STATE", message: "Only a paused task can be resumed.", status: task.status });
        return;
      }
      // Budget and step count are totals for the task, not an allowance every
      // click re-buys. A task that stopped on one can only go on against a
      // bigger one. `taskBudget` reads whichever counter actually stopped it:
      // the harness path meters in MCP tool calls, the standalone loop in model
      // turns, and a refusal that read the wrong one would let a capped harness
      // task resume with nothing left to spend.
      const budget = taskBudget(store, task, spendCapDefault());
      const cap = raise ?? budget.spend_cap_usd;
      const used = store.taskUsage(id);
      const spent = budget.spend_usd ?? 0;
      if (task.status === "paused" && spent >= cap) {
        writeJson(res, 409, { error: "E_SPEND_CAP",
          message: `It reached the $${cap.toFixed(2)} budget set for this task, so there is nothing left to spend. Give it a bigger budget to carry on.`,
          spend_cap_usd: cap, spend_usd: spent });
        return;
      }
      const maxSteps = steps ?? task.max_steps;
      const usedSteps = store.harnessBindingForTask(id)?.observed_tool_calls ?? used?.steps ?? 0;
      if (task.status === "paused" && usedSteps >= maxSteps) {
        writeJson(res, 409, { error: "E_LIMIT",
          message: `It used every one of the ${maxSteps} steps set for this task. Give it more steps to carry on.`,
          max_steps: maxSteps, steps: usedSteps });
        return;
      }
      // A host reboot can stop the browser while its durable row still says
      // running. Resume starts the existing containers and retains the profile.
      if (task.status === "paused" && sandbox.start && (!useFakeComputer() || opts.sandbox)) {
        try {
          await sandbox.start(task.computer_id);
          store.setComputerStatus(task.computer_id, "running");
        } catch (error) {
          logError("resume computer start failed", { computer_id: task.computer_id, error: String(error) });
          writeJson(res, 503, { error: "E_RUNTIME", message: "Couldn’t restart this computer. Check that Docker is running on BotHearth’s host, then try Resume again." });
          return;
        }
      }
      const takeover = store.activeTakeoverForComputer(task.computer_id);
      if (takeover) {
        if (takeover.task_id !== id || takeover.state !== "paused") {
          writeJson(res, 409, { error: "E_TAKEOVER_BUSY", message: "Return control of this computer before resuming the task." });
          return;
        }
        // Resume is an explicit return of this task's expired control. Check
        // for private input even if the old lease never recorded its holder.
        const client = getClient(task.computer_id);
        const observation = await client.call("takeover.masked-observation", {});
        if (!observation.ok || (observation.data as { still_sensitive?: unknown })?.still_sensitive !== false) {
          writeJson(res, 409, { error: "E_TAKEOVER_BUSY",
            message: "Take control, finish or clear any private input, then return control before resuming." });
          return;
        }
        const current = store.activeTakeoverForComputer(task.computer_id);
        if (current?.id !== takeover.id || current.state !== "paused" || store.getTask(id)?.status !== "paused") {
          writeJson(res, 409, { error: "E_TAKEOVER_BUSY", message: "Control changed while resuming. Check the computer and try again." });
          return;
        }
        const released = await client.declineTakeover(takeover.id);
        if (!released.ok) { writeJson(res, 409, released); return; }
        // This returns control; it does not declare a sensitive field safe.
        store.updateTakeoverState(takeover.id, "agent");
        clearTimeout(takeoverTimers.get(takeover.id));
        takeoverTimers.delete(takeover.id);
        takeoverGapStarts.delete(takeover.id);
        await emit("takeover.released", { takeover_id: takeover.id, actor: deviceId(session.sessionId) },
          { task_id: id, computer_id: task.computer_id });
      }
      if (!store.resumeTask(id)) {
        writeJson(res, 409, { error: "E_STATE", message: "Only a paused task can be resumed.", status: task.status });
        return;
      }
      if (raise !== undefined) store.setTaskSpendCap(id, raise);
      if (steps !== undefined) store.setTaskMaxSteps(id, steps);
      if (runtimeSec !== undefined) store.setTaskMaxRuntimeSec(id, runtimeSec);
      await emit("task.resumed", {}, { task_id: id, computer_id: task.computer_id });
      void startStoredTask(store.getTask(id)!, undefined, true)
        .catch((error) => logError("task resume failed", { task_id: id, error: String(error) }));
      writeJson(res, 202, { ok: true, status: "running" });
      return;
    }

    const taskCancel = /^\/api\/v1\/tasks\/([^/]+)\/cancel$/.exec(path);
    if (taskCancel && method === "POST") {
      const id = decodeURIComponent(taskCancel[1]!);
      const start = Date.now();
      const before = store.getTask(id);
      const wasActive = before && !["completed", "failed", "cancelled"].includes(before.status);
      const task = await cancelTask(id);
      if (!task) {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      if (wasActive && task.status === "cancelled") {
        await emit("task.cancelled", { cancelled_in_ms: Date.now() - start }, { task_id: id });
        store.freezeTaskSummary(id);
      }
      writeJson(res, 200, {
        ok: true,
        task,
        cancelled_in_ms: Date.now() - start,
      });
      return;
    }

    if (path === "/api/v1/approvals" && method === "GET") {
      writeJson(res, 200, { approvals: store.listApprovals() });
      return;
    }

    if (path === "/api/v1/takeovers" && method === "GET") {
      // `holder` is the device that took control: the page compares it against
      // its own device id to tell "I am driving" from "someone else is".
      writeJson(res, 200, { takeovers: store.listTakeovers().map(({ granted_to, ...row }) =>
        ({ ...row, holder: granted_to })) });
      return;
    }

    const approvalMatch = /^\/api\/v1\/approvals\/([^/]+)$/.exec(path);
    if (approvalMatch && method === "GET") {
      const id = decodeURIComponent(approvalMatch[1]!);
      const a = store.getApproval(id);
      if (!a) {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      writeJson(res, 200, { approval: a });
      return;
    }

    if (approvalMatch && method === "POST") {
      const id = decodeURIComponent(approvalMatch[1]!);
      const raw = await readBody(req);
      let decision: ApprovalDecision;
      let suppliedBind: ApprovalBind;
      try {
        const body = JSON.parse(raw) as { decision?: ApprovalDecision; bind?: ApprovalBind };
        decision = body.decision as ApprovalDecision;
        suppliedBind = body.bind as ApprovalBind;
      } catch {
        writeJson(res, 400, { error: "E_IO", message: "invalid JSON" });
        return;
      }
      if (
        decision !== "allow_once" &&
        decision !== "allow_task" &&
        decision !== "deny" &&
        decision !== "kill"
      ) {
        writeJson(res, 400, { error: "E_IO", message: "invalid decision" });
        return;
      }
      const stored = store.getApproval(id);
      if (!stored) {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      if (!suppliedBind || typeof suppliedBind !== "object") {
        writeJson(res, 400, { error: "E_POLICY", message: "approval binding required" });
        return;
      }
      const request: ApprovalRequest = {
        approval_id: stored.id,
        tool: stored.tool as ToolName,
        args: JSON.parse(stored.args_json) as Record<string, unknown>,
        gate: stored.gate as ApprovalRequest["gate"],
        bind: JSON.parse(stored.bind_json) as ApprovalBind,
        created_at: stored.created_at,
      };
      const memory = { request, status: stored.status };
      const checked = decideBoundApproval(
        {
          get: (approvalId) => approvalId === id ? memory : undefined,
          set: () => undefined,
        },
        {
          approval_id: id,
          decision,
          actor: "human",
          task_id: suppliedBind.task_id,
          control_epoch: suppliedBind.control_epoch,
          origin: suppliedBind.origin,
          action_hash: suppliedBind.action_hash,
        },
      );
      if (!checked.ok) {
        if (checked.status === "expired") {
          store.setApprovalStatusIf(id, "pending", "expired", null);
          await emit("approval.expired", { approval_id: id }, { task_id: stored.task_id });
        }
        writeJson(res, 409, { error: "E_POLICY", message: checked.reason });
        return;
      }
      const updated = store.setApprovalStatusIf(
        id,
        "pending",
        checked.status as ApprovalStatus,
        decision,
      );
      if (!updated) {
        writeJson(res, 409, { error: "E_POLICY", message: "approval state changed" });
        return;
      }
      if (decision === "kill") await cancelTask(updated.task_id);
      // "Always allow this site for this task": the grant is durable the moment
      // the operator says so, not when the tool that asked happens to be retried,
      // so a retry that arrives after a redirect still finds it.
      //
      // Only a `new_domain` ask offers that choice, and it is the only ask
      // whose card names the site being remembered. The dispatcher already
      // gates on it (dispatcher.ts); this route must too, or an `allow_task` on
      // a `sensitive_action` or `upload` approval — which the operator answered
      // about one action, not one site — silently buys a task-lifetime origin
      // grant they were never shown.
      // The bind's origin is the origin the gate named, so a card raised by a
      // keystroke on an already-open page remembers the site it was on — the
      // same set the dispatcher records when it consumes the approval.
      const remembered = decision === "allow_task" && stored.gate === "new_domain"
        ? approvalGrantOrigins(stored.tool, request.args,
          (request.bind as ApprovalBind & { navigation_url?: string }).navigation_url,
          request.bind.origin)
        : [];
      // The per-task cap can refuse a grant, so the event reports what actually
      // stuck rather than what was asked for, and a refusal is audited.
      const held = new Set(store.taskGrantedOrigins(updated.task_id));
      const granted = remembered.length
        ? store.grantTaskOrigins(updated.task_id, remembered, updated.id)
        : [];
      const kept = remembered.filter((origin) => granted.includes(origin) || held.has(origin));
      const refused = remembered.filter((origin) => !kept.includes(origin));
      if (refused.length) {
        await emit("policy.denied", { reason: "origin_grant_cap", approval_id: updated.id,
          origins: refused, cap: MAX_TASK_ORIGIN_GRANTS }, { task_id: updated.task_id });
      }
      await emit("approval.decided", { decision, bind: suppliedBind,
        ...(kept.length ? { remembered_origins: kept } : {}) },
        { task_id: updated.task_id });
      writeJson(res, 200, { approval: updated });
      return;
    }

    if (path === "/api/v1/takeover/request" && method === "POST") {
      const raw = await readBody(req);
      let body: { computer_id?: string; reason?: string; task_id?: string };
      try {
        body = JSON.parse(raw) as {
          computer_id?: string;
          reason?: string;
          task_id?: string;
        };
      } catch {
        writeJson(res, 400, { error: "E_IO", message: "invalid JSON" });
        return;
      }
      if (!body.computer_id) {
        writeJson(res, 400, {
          error: "E_IO",
          message: "computer_id required",
        });
        return;
      }
      const computer = store.getComputer(body.computer_id);
      if (!computer) { writeJson(res, 404, { error: "not_found" }); return; }
      if (body.task_id !== undefined && (typeof body.task_id !== "string" ||
          store.getTask(body.task_id)?.computer_id !== body.computer_id)) {
        writeJson(res, 400, { error: "E_POLICY", message: "task does not belong to this computer" });
        return;
      }
      if (computer.status !== "running") { writeJson(res, 409, { error: "E_SANDBOX_DEAD" }); return; }
      let prior = store.activeTakeoverForComputer(body.computer_id);
      const lapsed = (row?: { expires_at: string | null }): boolean =>
        row?.expires_at != null && Date.parse(row.expires_at) <= Date.now();
      if (prior && lapsed(prior) && prior.state !== "paused") {
        await expireTakeover(prior.id);
        prior = store.activeTakeoverForComputer(body.computer_id);
        if (prior && prior.state !== "paused" && lapsed(prior)) {
          writeJson(res, 409, { error: "E_TAKEOVER_BUSY", message: "Expired control could not be renewed" });
          return;
        }
      }
      if (prior?.state === "takeover_requested" || prior?.state === "human") {
        writeJson(res, 200, { takeover: { takeover_id: prior.id, state: toWireState(prior.state),
          expires_at: prior.expires_at, epoch: prior.epoch } });
        return;
      }
      if (prior?.state === "resume_validating") {
        writeJson(res, 409, { error: "E_TAKEOVER_BUSY", message: "Takeover release is being validated" });
        return;
      }
      const client = getClient(body.computer_id);
      const result = await client.call("takeover.request", {
        reason: body.reason ?? "ui",
      });
      if (!result.ok) {
        writeJson(res, 409, result);
        return;
      }
      const data = result.data as { takeover_id: string; epoch?: number };
      if (prior?.state === "paused") {
        store.updateTakeoverState(prior.id, "terminated");
        clearTimeout(takeoverTimers.get(prior.id));
        takeoverTimers.delete(prior.id);
        takeoverGapStarts.delete(prior.id);
      }
      // A question nobody has answered yet has no deadline of its own: the
      // lease clock starts at the grant, whatever the computer reported.
      const takeover = store.insertTakeover({
        id: data.takeover_id,
        computer_id: body.computer_id,
        task_id: body.task_id ?? prior?.task_id ?? null,
        state: "takeover_requested",
        expires_at: null,
        epoch: takeoverEpochFromData(data),
      });
      if (prior?.state === "paused" && prior.granted_to) {
        // Renewal still covers the previous human's private desktop until a
        // fresh grant or an explicit return. Keep that provenance on cancel.
        store.grantTakeoverTo(takeover.id, prior.granted_to);
        store.updateTakeoverState(takeover.id, "takeover_requested");
      }
      await emit(
        "takeover.requested",
        { takeover_id: data.takeover_id, reason: body.reason ?? "ui" },
        { computer_id: body.computer_id, task_id: body.task_id },
      );
      writeJson(res, 200, { takeover: { takeover_id: takeover.id, state: toWireState(takeover.state),
        expires_at: takeover.expires_at, epoch: takeover.epoch } });
      return;
    }

    const takeoverStatus = /^\/api\/v1\/takeover\/([^/]+)\/status$/.exec(path);
    if (takeoverStatus && method === "GET") {
      const target = takeoverTarget(takeoverStatus, res);
      if (!target) return;
      const { id, row, client } = target;
      const result = await client.call("takeover_status", { takeover_id: id });
      writeJson(res, 200, {
        takeover: result.ok ? result.data : result,
        store: row,
      });
      return;
    }

    const takeoverAcquire =
      /^\/api\/v1\/takeover\/([^/]+)\/(acquire|grant)$/.exec(path);
    if (takeoverAcquire && method === "POST") {
      const target = takeoverTarget(takeoverAcquire, res);
      if (!target) return;
      const { id, row, client } = target;
      const result = await client.grantTakeover(id);
      if (!result.ok) {
        writeJson(res, 409, result);
        return;
      }
      store.grantTakeoverTo(id, deviceId(session.sessionId));
      renewTakeoverLease(id);
      const grantedEpoch = takeoverEpochFromData(result.data);
      if (grantedEpoch > 0) store.updateTakeoverEpoch(id, grantedEpoch);
      const gapStart = new Date().toISOString();
      takeoverGapStarts.set(id, gapStart);
      await emit(
        "takeover.started",
        { takeover_id: id, actor: deviceId(session.sessionId) },
        { computer_id: row.computer_id, task_id: row.task_id ?? undefined },
      );
      writeJson(res, 200, { takeover: result.data });
      return;
    }

    const takeoverRelease = /^\/api\/v1\/takeover\/([^/]+)\/release$/.exec(path);
    if (takeoverRelease && method === "POST") {
      const target = takeoverTarget(takeoverRelease, res);
      if (!target) return;
      const { id, row, client } = target;
      const result = await client.releaseTakeover(id);
      if (!result.ok) {
        writeJson(res, 409, result);
        return;
      }
      const next = durableStateAfterRelease(result.data);
      store.updateTakeoverState(id, next);
      sendLiveControl(row.computer_id);
      if (next !== "agent") {
        writeJson(res, 200, { takeover: result.data });
        return;
      }
      const timer = takeoverTimers.get(id);
      if (timer) clearTimeout(timer);
      takeoverTimers.delete(id);
      const t1 = new Date().toISOString();
      const t0 = takeoverGapStarts.get(id) ?? row.created_at;
      takeoverGapStarts.delete(id);
      await emit(
        "takeover.gap",
        { t0, t1, frames_suppressed: true },
        { computer_id: row.computer_id, task_id: row.task_id ?? undefined },
      );
      await emit(
        "takeover.released",
        { takeover_id: id, actor: deviceId(session.sessionId) },
        { computer_id: row.computer_id, task_id: row.task_id ?? undefined },
      );
      writeJson(res, 200, { takeover: result.data });
      return;
    }

    const takeoverDecline = /^\/api\/v1\/takeover\/([^/]+)\/decline$/.exec(path);
    if (takeoverDecline && method === "POST") {
      const target = takeoverTarget(takeoverDecline, res);
      if (!target) return;
      const { id, row, client } = target;
      const result = await client.declineTakeover(id);
      if (!result.ok) {
        writeJson(res, 409, result);
        return;
      }
      store.declineTakeover(id);
      const timer = takeoverTimers.get(id);
      if (timer) clearTimeout(timer);
      takeoverTimers.delete(id);
      takeoverGapStarts.delete(id);
      await emit(
        "takeover.declined",
        { takeover_id: id },
        { computer_id: row.computer_id },
      );
      writeJson(res, 200, { takeover: result.data });
      return;
    }

    if (path === "/api/v1/audit" && method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? "100");
      writeJson(res, 200, {
        records: store.listAuditRefs(Number.isFinite(limit) ? limit : 100),
      });
      return;
    }

    if (path === "/api/v1/connectors" && method === "GET") {
      writeJson(res, 200, { connectors: connectors.list() });
      return;
    }

    const connectorDiscover = /^\/api\/v1\/connectors\/([^/]+)\/discover$/.exec(
      path,
    );
    if (connectorDiscover && method === "POST") {
      await writeConnector(res, () =>
        connectors.discover(decodeURIComponent(connectorDiscover[1]!)));
      return;
    }

    const connectorApprove = /^\/api\/v1\/connectors\/([^/]+)\/approve$/.exec(
      path,
    );
    if (connectorApprove && method === "POST") {
      const id = decodeURIComponent(connectorApprove[1]!);
      const raw = await readBody(req);
      let body: { tools?: string[] };
      try {
        body = JSON.parse(raw) as { tools?: string[] };
      } catch {
        writeJson(res, 400, { error: "E_IO", message: "invalid JSON" });
        return;
      }
      if (!Array.isArray(body.tools)) {
        writeJson(res, 400, {
          error: "E_IO",
          message: "tools string[] required",
        });
        return;
      }
      await writeConnector(res, () => connectors.approve(id, body.tools as string[]));
      return;
    }

    if (path.startsWith("/api/v1/routines")) {
      if (!standaloneAvailable && method === "POST" &&
          (path === "/api/v1/routines" || /^\/api\/v1\/routines\/[^/]+\/run$/.test(path))) {
        writeJson(res, 503, { error: "E_CAPABILITY", message: "Routines require a configured standalone provider. Codex tasks can be started from the workspace." });
        return;
      }
      const handled = await routines.handleApi(
        req,
        res,
        path,
        method,
        () => readBody(req),
      );
      if (handled) return;
    }

    writeJson(res, 404, { error: "not_found" });
  }

  function handleUpgrade(
    req: IncomingMessage,
    socket: import("node:net").Socket,
    head: Buffer,
  ): void {
    const portNum = (server.address() as AddressInfo | null)?.port ?? wantPort;
    if (!checkHost(req.headers.host, portNum, allowedHosts)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    const origin = req.headers.origin;
    if (!origin || checkApiOrigin(origin, portNum, allowedHosts) === "bad") {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    if (isMcpToken(req.headers.authorization, opts.mcpToken)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies[SESSION_COOKIE];
    const session = sid ? store.getSession(sid) : undefined;
    if (!session || !sessionOriginMatches(req, session.origin) || origin !== requestOrigin(req)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const liveMatch = /^\/api\/v1\/live\/([^/]+)$/.exec(url.pathname);
    const isEvents = url.pathname === "/api/v1/events";
    if (!liveMatch && !isEvents) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    const computerId = liveMatch ? decodeURIComponent(liveMatch[1]!) : undefined;

    const ws = acceptWebSocket(req, socket, head);
    if (!ws) return;
    socketSessions.set(ws, session.id);
    ws.onClose(() => socketSessions.delete(ws));
    const send = ws.send.bind(ws);
    ws.send = (data) => { if (authorizeSocket(ws)) send(data); };

    if (isEvents) {
      eventSubs.add(ws);
      ws.onClose(() => {
        eventSubs.delete(ws);
      });
      const hello: UiEvent = makeEvent("usage", {
        tokens_in: 0,
        tokens_out: 0,
        steps: 0,
      });
      ws.send(JSON.stringify(hello));
      return;
    }

    if (!computerId) return;
    if (!store.getComputer(computerId)) {
      ws.close(1008, "unknown computer");
      return;
    }
    const computer = getClient(computerId);
    let set = liveSubs.get(computerId);
    if (!set) {
      set = new Set();
      liveSubs.set(computerId, set);
    }
    set.add(ws);
    ws.send(JSON.stringify(liveControlState(computerId)));
    // A static page may not emit again while another subscriber is still connected.
    computer.stopLive();
    computer.startLive();
    ws.onClose(() => {
      set!.delete(ws);
      if (set!.size === 0) {
        computer.stopLive();
        liveSubs.delete(computerId);
      }
    });
    let relayTail = Promise.resolve();
    ws.onMessage((data, isBinary) => {
      if (!authorizeSocket(ws) || isBinary) return;
      try {
        const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown> & {
          t?: string;
        };
        if (msg.t === "pointer" || msg.t === "key" || msg.t === "text") {
          const lease = validateLiveRelayFrame(store, computerId, msg, deviceId(session.id))
            ? store.activeTakeoverForComputer(computerId)
            : undefined;
          if (lease) {
            renewTakeoverLease(lease.id);
            const sender = ws;
            relayTail = relayTail.then(async () => {
              const sendFail = (code: string, message: string) => {
                if (sender.readyState === "open") {
                  sender.send(JSON.stringify({ v: 1, t: "error", code, message }));
                }
              };
              try {
                if (!authorizeSocket(sender)) return;
                await idlePause.wake(computerId);
                if (!authorizeSocket(sender)) return;
                const frame = validateLiveRelayFrame(store, computerId, msg, deviceId(session.id));
                if (!frame) return;
                const result = await getClient(computerId).relayInput(frame);
                if (
                  result &&
                  typeof result === "object" &&
                  result.ok === false
                ) {
                  sendFail(result.error.code, result.error.message);
                }
              } catch (e) {
                sendFail("E_IO", e instanceof Error ? e.message : String(e));
              }
            });
          }
        }
      } catch {
        // ignore bad control frames
      }
    });
  }

  const server = createServer((req, res) => {
    if (closing) {
      writeJson(res, 503, { error: "E_UNAVAILABLE", message: "daemon is shutting down" });
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    } catch {
      writeJson(res, 400, { error: "E_IO", message: "invalid request URL or Host" });
      return;
    }
    handleApi(req, res, url).catch((err) => {
      if (res.headersSent) return;
      if (err instanceof RequestBodyTooLargeError) {
        writeJson(res, 413, { error: "E_LIMIT", message: "request body too large" });
      } else {
        logError("request failed", { err: String(err) });
        writeJson(res, 500, { error: "E_IO", message: "internal" });
      }
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const netSocket = socket as import("node:net").Socket;
    try {
      if (closing) rejectUpgrade(netSocket, 503, "Service Unavailable");
      else handleUpgrade(req, netSocket, head);
    } catch (err) {
      logError("upgrade rejected", { err: String(err) });
      if (!netSocket.destroyed) rejectUpgrade(netSocket, 400, "Bad Request");
    }
  });

  if (opts.listen !== false) {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(wantPort, host, () => resolveListen());
    });
  }

  const port = (server.address() as AddressInfo | null)?.port ?? wantPort;
  mcpOpts.port = port;
  // Recover only after binding: a second start that loses the port must not
  // pause the original daemon's task. A rebooted task needs an explicit Resume.
  for (const task of store.listTasks()) await pauseNativeForRestart(task);
  routines.routines.recoverInterrupted();
  if (opts.schedulerEnabled !== false) routines.scheduler.start();
  // Only the daemon that owns the port may refresh idle computers.
  void reconcileComputerImages();
  if (server.listening) logInfo("daemon listening", { host, port });

  return {
    server,
    store,
    events,
    port,
    host,
    baseUrl: `http://${host === "::1" ? "[::1]" : host}:${port}`,
    async close() {
      closing = true;
      // Stop accepting connections first. A graceful close takes seconds, and
      // until the listening socket is gone a restart cannot tell a daemon that
      // is on its way out from one that is serving. The callback still waits for
      // the sockets closed below.
      const listenerClosed = server.listening
        ? new Promise<void>((resolveClose) => server.close(() => resolveClose()))
        : Promise.resolve();
      clearInterval(socketSessionTimer);
      idlePause.stop();
      routines.stop();
      for (const [id, controller] of taskControllers) {
        const task = store.getTask(id);
        if (task && ["codex", "claude"].includes(task.adapter ?? "")) await pauseNativeForRestart(task);
        else store.cancelTask(id);
        controller.abort();
      }
      await Promise.all(allConnections().map(connection => connection.close()));
      await connectors.close().catch(() => undefined);
      for (const ws of eventSubs) ws.close();
      eventSubs.clear();
      for (const set of liveSubs.values()) {
        for (const ws of set) ws.close();
      }
      liveSubs.clear();
      for (const c of clients.values()) await c.close();
      clients.clear();
      await Promise.allSettled(taskRuns.values());
      await routines.scheduler.drain();
      await mcpHttp.closeAll().catch(() => undefined);
      await listenerClosed;
      for (const timer of takeoverTimers.values()) clearTimeout(timer);
      clearInterval(approvalExpiryTimer);
      await auditTail;
      store.close();
      logInfo("daemon closed", {});
    },
    callTool,
    auditLog,
  };
}
