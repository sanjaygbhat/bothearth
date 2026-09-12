import { createHash, randomBytes } from "node:crypto";
import { signalsFromObservation } from "../policy/signals.ts";
import type {
  ApprovalBind,
  ApprovalDecision,
  ErrorCode,
  Mode,
  PolicyGate,
  ToolName,
  ToolResult,
} from "../types/contracts.ts";
import type { ComputerClient, ComputerCallContext } from "../computer-client/types.ts";
import { toolError } from "../protocol/errors.ts";
import { isTakeoverBusy, isTakeoverExemptTool, toWireState } from "../protocol/takeover.ts";
import { approvalGrantOrigins, createApproval, computeActionHash } from "../policy/approvals.ts";
import { evaluateGate, originMatchesPattern, type EffectSignals, type OriginSets } from "../policy/index.ts";
import { APPROVAL_TTL_SEC } from "../types/contracts.ts";
import { harnessCapReason, Store, takeoverEpochFromData } from "./store.ts";
import type { EmitEvent } from "./events.ts";
import { logError } from "./log.ts";

export interface DispatchContext {
  taskId: string;
  computerId: string;
  controlEpoch?: number;
  origin?: string;
  signals?: EffectSignals;
  mode?: Mode;
  originSets?: Partial<OriginSets>;
  timeoutMs?: number;
}

export interface DispatcherOptions {
  store: Store;
  getClient(computerId: string): ComputerClient;
  emit: EmitEvent;
  execute?(
    client: ComputerClient,
    tool: ToolName,
    args: Record<string, unknown>,
    context?: ComputerCallContext,
  ): Promise<ToolResult>;
  /** Schema `policy.approval_ttl_sec`. */
  approvalTtlSec?: number;
  /**
   * Schema `policy.gates`. Omitted = every optional gate is armed (in-process
   * tests of matching). Empty = none of them fire. Mutating this array is how
   * Settings live-updates the evaluator without rebuilding the dispatcher.
   */
  enabledGates?: PolicyGate[];
  /** Schema `policy.kill_switch`. True → evaluateGate denies every tool call. */
  killSwitch?: boolean;
  /**
   * Called when the computer answers "unknown method" for a tool the daemon
   * advertised. The daemon drops the tool from that computer's offer, so the
   * model cannot be handed it again this session.
   */
  onUnsupportedTool?(computerId: string, tool: ToolName): void;
}

function normalizedOrigin(value: string): string {
  try {
    const origin = new URL(value).origin;
    // A blank or sandboxed document has an opaque origin, which `URL` reports
    // as the literal string "null". Passed on as an origin it landed in the
    // readable AND writable sets, so a page with no origin at all read as one
    // the task was already trusted on.
    return origin === "null" ? "about:blank" : origin;
  } catch {
    return value || "about:blank";
  }
}

function safeNavigation(tool: ToolName, args: Record<string, unknown>): ToolResult | null {
  const raw = tool === "browser_navigate"
    ? args.url
    : tool === "browser_tabs" && args.action === "new"
      ? args.url
      : undefined;
  if (raw === undefined || raw === null || raw === "") return null;
  try {
    const url = new URL(String(raw));
    if (url.protocol === "http:" || url.protocol === "https:") return null;
    return toolError("E_POLICY", `navigation scheme not allowed: ${url.protocol}`);
  } catch {
    return toolError("E_POLICY", "invalid navigation URL");
  }
}

/** What is on screen right now, as the model is given it. */
interface Page {
  url: string;
  title?: string;
  snapshot: string;
  hash: string;
}

/**
 * What of the page the model is shown when an ask is answered with it. The
 * whole 16 kB observation went into the error details and into `takeover_status`
 * — twice per handback, and larger than the snapshot the model asks for itself.
 */
const PAGE_SNAPSHOT_MAX = 4_000;

function pageFrom(snapshot: ToolResult): Page | undefined {
  if (!snapshot.ok) return undefined;
  const data = snapshot.data as { url?: unknown; title?: unknown; yaml?: unknown } | null;
  if (typeof data?.url !== "string" || typeof data.yaml !== "string") return undefined;
  return {
    url: data.url,
    ...(typeof data.title === "string" ? { title: data.title } : {}),
    snapshot: data.yaml.slice(0, PAGE_SNAPSHOT_MAX),
    hash: createHash("sha256").update(`${data.url}\n${data.yaml}`).digest("hex").slice(0, 16),
  };
}

function sameReason(a: string, b: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
  return normalize(a) === normalize(b) && normalize(a) !== "";
}

const CONTROL_RETURNED = "The person gave control back.";

function resultOrigin(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const url = (data as { url?: unknown }).url;
  return typeof url === "string" ? normalizedOrigin(url) : undefined;
}

/**
 * Insert the takeover row the computer just minted, unless it is already
 * known. Returns the id when a row was written, so the caller can announce it.
 * A pending ask has no deadline — the clock starts when the human takes
 * control — so the row is written with a null expiry whatever the container says.
 */
export function recordTakeover(
  store: Store,
  computerId: string,
  taskId: string,
  data: Record<string, unknown>,
): string | null {
  const takeoverId = String(data.takeover_id ?? "");
  if (!takeoverId || store.getTakeover(takeoverId)) return null;
  store.insertTakeover({
    id: takeoverId,
    computer_id: computerId,
    task_id: taskId,
    state: "takeover_requested",
    expires_at: null,
    epoch: takeoverEpochFromData(data),
  });
  return takeoverId;
}

const TAKEOVER_OBSERVE_MS = 2_000;
const TAKEOVER_EXECUTE_MS = 2_000;

const pendingTakeoverComputerSync = new Set<string>();

export function takeoverNeedsComputerSync(id: string): boolean {
  return pendingTakeoverComputerSync.has(id);
}

export function markTakeoverComputerPending(id: string): void {
  pendingTakeoverComputerSync.add(id);
}

export function markTakeoverComputerSynced(id: string): void {
  pendingTakeoverComputerSync.delete(id);
}

/** Re-issue request_takeover with the daemon lease id, then grant. */
export async function syncAndGrantTakeover(
  client: ComputerClient,
  takeoverId: string,
  grant: (id: string) => Promise<ToolResult> = (id) => client.grantTakeover(id),
): Promise<ToolResult> {
  let asked: ToolResult;
  try {
    asked = await raceTimeout(
      client.call("request_takeover", { takeover_id: takeoverId, reason: "reconcile" }),
      TAKEOVER_EXECUTE_MS,
    );
  } catch (err) {
    return toolError("E_TIMEOUT", err instanceof Error ? err.message : String(err));
  }
  if (!asked.ok) return asked;
  const granted = await grant(takeoverId);
  if (granted.ok) pendingTakeoverComputerSync.delete(takeoverId);
  return granted;
}

async function raceFallback<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  void promise.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  void promise.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error("Operation timed out."), { code: "E_TIMEOUT" as const }));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Fail-closed result for a denied bound harness call, else null.
 *
 * The estimate this charges is also the estimate it reports: one `usage` event
 * per counted call, carrying the running total. A meter reading a different
 * counter from the enforcer is how a task died at its $2 cap with $0.00 on
 * screen. A binding with `spend_cap_usd` / `max_steps` of 0 (native tasks) is
 * counted and reported but never denied — the proxy is not a bill.
 */
export async function enforceHarnessMcpSpendCap(
  opts: { store: Store; emit: EmitEvent },
  computerId: string,
): Promise<ToolResult | null> {
  const attempt = opts.store.observeHarnessToolCall(computerId);
  if (!attempt) return null;
  const spendUsd = attempt.proxy_estimate_usd;
  if (attempt.counted) {
    await opts.emit(
      "usage",
      // A harness run counts steps in tool calls; reporting 0 made Settings →
      // Usage show every harness task as no work for a real dollar figure.
      { tokens_in: 0, tokens_out: 0, usd_est: spendUsd, steps: attempt.binding.observed_tool_calls },
      { task_id: attempt.binding.task_id, computer_id: computerId },
    );
  }
  if (!attempt.denied) return null;

  const binding = attempt.binding;
  // Both budgets are counted in tool calls, so the counter that refused this
  // call also says which one did: the model is told `E_LIMIT` for a step cap
  // and `E_SPEND_CAP` for a budget, never one wearing the other's name.
  const reason = harnessCapReason(binding) ?? "spend_cap";
  if (attempt.emit_denial_audit) {
    try {
      await opts.emit(
        "policy.denied",
        {
          reason,
          budget_kind: "mcp_tool_call_proxy",
          cap_usd: binding.spend_cap_usd,
          spend_usd: spendUsd,
          proxy_estimate_usd: spendUsd,
          proxy_usd_per_tool_call: binding.proxy_usd_per_tool_call,
          observed_tool_calls: binding.observed_tool_calls,
          max_steps: binding.max_steps,
          execution: binding.execution,
        },
        { task_id: binding.task_id, computer_id: binding.computer_id },
      );
      opts.store.finishHarnessDenialAudit(computerId, true);
    } catch (error) {
      opts.store.finishHarnessDenialAudit(computerId, false);
      logError("harness spend-cap audit append failed", {
        task_id: binding.task_id,
        error: String(error),
      });
    }
  }
  return toolError(reason === "max_steps" ? "E_LIMIT" : "E_SPEND_CAP", undefined, {
    budget_kind: "mcp_tool_call_proxy",
    cap_usd: binding.spend_cap_usd,
    spend_usd: spendUsd,
    proxy_estimate_usd: spendUsd,
    observed_tool_calls: binding.observed_tool_calls,
    task_id: binding.task_id,
  });
}

function bindingOf(row: { bind_json: string }): (ApprovalBind & { navigation_url?: string }) | null {
  try {
    return JSON.parse(row.bind_json) as ApprovalBind & { navigation_url?: string };
  } catch {
    return null;
  }
}

function snapshotYamlOf(result: ToolResult): string | undefined {
  if (!result.ok || !result.data || typeof result.data !== "object") return undefined;
  const yaml = (result.data as { yaml?: unknown }).yaml;
  return typeof yaml === "string" ? yaml : undefined;
}

/** Audit / live events never need the literal typed string — only its length. */
function auditArguments(
  tool: string,
  args: Record<string, unknown>,
  signals: EffectSignals,
): Record<string, unknown> {
  const sensitive = Boolean(signals.password_field || signals.otp_field || signals.payment_field);
  const maskText =
    typeof args.text === "string" &&
    (tool === "browser_type" || (sensitive && tool === "computer_type"));
  const maskKey =
    sensitive &&
    typeof args.key === "string" &&
    (tool === "browser_press" || tool === "computer_key");
  if (!maskText && !maskKey) return args;
  return {
    ...args,
    ...(maskText ? { text: `<${(args.text as string).length} chars>` } : {}),
    ...(maskKey ? { key: `<${(args.key as string).length} chars>` } : {}),
  };
}

/** No-effect failures must not spend Allow once. Timeouts and I/O might have. */
const NO_EFFECT: ReadonlySet<ErrorCode> = new Set([
  "E_STALE_REF",
  "E_POLICY",
  "E_POLICY_PENDING",
  "E_SANDBOX_DEAD",
  "E_CAPABILITY",
  "E_TAKEOVER_BUSY",
  "E_AUTH",
]);

function spendOnceGrant(result: ToolResult): boolean {
  return result.ok || !NO_EFFECT.has(result.error.code);
}

export function createToolDispatcher(opts: DispatcherOptions): {
  dispatch(
    tool: ToolName,
    args: Record<string, unknown>,
    context: DispatchContext,
  ): Promise<ToolResult>;
} {
  const knownOrigins = new Map<string, string>();
  // A person is holding this computer, and the reason they were asked for.
  const held = new Map<string, string>();
  // Control is back with the model, and the page it was handed back on.
  const returned = new Map<string, {
    reason: string; page?: Page; answered?: boolean; declined?: boolean;
  }>();

  // Fields a person waved through ("not needed, continue"), by task and origin,
  // then by the page and the ask they answered. Keyed on the origin at the top
  // level because that is all a caller-supplied origin can be matched against:
  // an origin with a declined field is worth one observation to place the page.
  const declinedFields = new Map<string, Set<string>>();
  const declinedOn = (taskId: string, origin: string): string => `${taskId}\0${origin}`;
  const declinedAsk = (url: string, reason: string): string =>
    `${url}\0${reason.trim().toLowerCase()}`;

  /** A person is being asked for this computer; the previous return is over. */
  function askedFor(computerId: string, reason: string): void {
    held.set(computerId, reason);
    returned.delete(computerId);
  }

  async function busyAfterTakeoverFailure(
    context: DispatchContext,
    args: Record<string, unknown>,
    ids: { task_id: string; computer_id: string },
    takeoverId: string,
  ): Promise<ToolResult> {
    const recorded =
      recordTakeover(opts.store, context.computerId, context.taskId, {
        takeover_id: takeoverId,
        field: null,
      }) ?? takeoverId;
    pendingTakeoverComputerSync.add(recorded);
    askedFor(context.computerId, String(args.reason ?? ""));
    await opts.emit(
      "takeover.requested",
      {
        takeover_id: recorded,
        reason: String(args.reason ?? "model"),
        field: null,
      },
      ids,
    );
    const lease = opts.store.activeTakeoverForComputer(context.computerId, context.taskId);
    return toolError(
      "E_TAKEOVER_BUSY",
      undefined,
      lease
        ? {
            takeover_id: lease.id,
            state: toWireState(lease.state),
          }
        : { takeover_id: recorded, state: "requested" },
    );
  }

  async function observe(
    client: ComputerClient,
    context: DispatchContext,
    navigationOrigins: string[],
    needYaml = false,
  ): Promise<{ origin: string; signals: EffectSignals; page?: Page; yaml?: string; navigationDenied?: ToolResult }> {
    // The standalone loop always names an origin, so short-circuiting on it
    // meant no page was ever produced there and the whole no-phantom-re-ask
    // path was dead outside the harness. A computer a person just handed back
    // is worth the one snapshot; nothing else is.
    const shortCircuit = Boolean(context.origin) && !returned.has(context.computerId) &&
      !declinedFields.has(declinedOn(context.taskId, normalizedOrigin(context.origin!)));
    if (shortCircuit && !needYaml) {
      return {
        origin: normalizedOrigin(context.origin!),
        signals: context.signals ?? {},
      };
    }
    const snapshot = await client.call("browser_snapshot", {
      scope: null,
      interactive_only: false,
      depth: 8,
      max_chars: 16_000,
    }, { navigationOrigins, allowPublicNavigation: context.mode !== "strict" });
    const yaml = snapshotYamlOf(snapshot);
    if (shortCircuit) {
      const page = pageFrom(snapshot);
      return {
        origin: normalizedOrigin(context.origin!),
        signals: context.signals ?? signalsFromObservation(snapshot),
        yaml,
        ...(page ? { page } : {}),
      };
    }
    const origin = resultOrigin(snapshot) ??
      (context.origin ? normalizedOrigin(context.origin) : undefined) ??
      knownOrigins.get(context.computerId) ?? "about:blank";
    knownOrigins.set(context.computerId, origin);
    const page = pageFrom(snapshot);
    return { origin, signals: signalsFromObservation(snapshot), yaml, ...(page ? { page } : {}),
      ...(!snapshot.ok && typeof snapshot.error.details?.navigation_url === "string" ? { navigationDenied: snapshot } : {}) };
  }

  async function requestConsent(tool: ToolName, args: Record<string, unknown>, gate: PolicyGate,
    context: DispatchContext, origin: string, reason: string, navigationUrl?: string,
    gateOrigin?: string, snapshotYaml?: string): Promise<ToolResult> {
    const request = createApproval({ tool, args, gate, task_id: context.taskId,
      control_epoch: context.controlEpoch ?? 0, origin, dest: navigationUrl ?? gateOrigin,
      ttl_sec: opts.approvalTtlSec ?? APPROVAL_TTL_SEC, snapshotYaml });
    const bind = { ...request.bind, ...(navigationUrl ? { navigation_url: navigationUrl } : {}) };
    opts.store.insertApproval({ id: request.approval_id, task_id: context.taskId,
      tool, args: request.args, gate, bind });
    // `bind` is a frozen shape, so the deadline and the offer of a remembered
    // grant ride on the event body: the card needs both to draw a countdown and
    // an "always allow for this task" choice.
    const grants = gate === "new_domain" ? approvalGrantOrigins(tool, request.args, navigationUrl, gateOrigin) : [];
    await opts.emit("approval.requested", { ...request, bind, tool, args: request.args, gate, reason,
      expires_at: bind.expires, can_remember: grants.length > 0,
      ...(grants.length ? { remember_origins: grants } : {}) },
      { task_id: context.taskId, computer_id: context.computerId });
    return toolError("E_POLICY_PENDING", reason, { approval_id: request.approval_id, bind });
  }

  function newDomainArmed(): boolean {
    return opts.enabledGates === undefined || opts.enabledGates.includes("new_domain");
  }

  function navigationConsent(
    tool: ToolName,
    args: Record<string, unknown>,
    blocked: ToolResult,
    url: string,
    initialPopup: boolean,
    context: DispatchContext,
    snapshotYaml?: string,
  ): Promise<ToolResult> | ToolResult {
    if (context.mode === "strict" || initialPopup) return blocked;
    if (!newDomainArmed()) return blocked;
    const origin = normalizedOrigin(url);
    return requestConsent(tool, { action: args, navigation_url: url }, "new_domain",
      context, origin, `Navigation to ${origin} was blocked before contact`, url, undefined, snapshotYaml);
  }

  async function dispatch(
    tool: ToolName,
    args: Record<string, unknown>,
    context: DispatchContext,
  ): Promise<ToolResult> {
    const cancelled = () => opts.store.getTask(context.taskId)?.status === "cancelled" ||
      opts.store.listApprovals("killed").some((approval) => approval.task_id === context.taskId);
    if (cancelled()) return toolError("E_POLICY", "task cancelled");
    const ids = { task_id: context.taskId, computer_id: context.computerId };
    const computer = opts.store.getComputer(context.computerId);
    if (!computer || computer.status !== "running") {
      return toolError("E_SANDBOX_DEAD", "computer is not running");
    }
    const capabilities = JSON.parse(computer.capabilities) as string[];
    if (!capabilities.includes("shell") && (tool === "shell_exec" || tool.startsWith("files_"))) {
      return toolError("E_CAPABILITY", "shell capability is not enabled");
    }

    const active = opts.store.activeTakeoverForComputer(context.computerId, context.taskId);
    if (tool === "takeover_status" && active && isTakeoverBusy(active.state)) {
      if (args.takeover_id != null && args.takeover_id !== "" && args.takeover_id !== active.id) {
        return toolError("E_IO", "unknown takeover_id");
      }
      // The durable model gate survives a restarted computer's fresh AGENT FSM.
      return { ok: true, data: { takeover_id: active.id, state: toWireState(active.state),
        expires_at: active.expires_at, epoch: active.epoch } };
    }
    if (active && isTakeoverBusy(active.state) && !isTakeoverExemptTool(tool)) {
      return toolError("E_TAKEOVER_BUSY", undefined, {
        takeover_id: active.id,
        state: toWireState(active.state),
      });
    }
    // The person has handed control back. Until the page moves, every status
    // poll answers with what is on screen, and asking for control again over
    // the same unchanged page is answered with that page instead of parking
    // the task on a screen nobody can see.
    const heldReason = active && isTakeoverBusy(active.state)
      ? undefined
      : held.get(context.computerId);
    if (heldReason !== undefined) {
      held.delete(context.computerId);
      const declined = opts.store.latestTakeoverForComputer(context.computerId)?.declined === 1;
      returned.set(context.computerId, { reason: heldReason, declined });
    }

    const unsafeNavigation = safeNavigation(tool, args);
    if (unsafeNavigation) {
      await opts.emit("policy.denied", { tool, reason: "navigation_scheme" }, ids);
      return unsafeNavigation;
    }

    const client = opts.getClient(context.computerId);
    const approvals = opts.store.listApprovals().filter((a) => a.task_id === context.taskId && a.gate === "new_domain");
    // Grants are durable rows, not a re-reading of which approvals happen to be
    // spent. Deriving them from `consumed` approvals meant burning an approval
    // also burned the grant it stood for, so the retry the operator had just
    // authorised asked all over again.
    const grantedOrigins = opts.store.taskGrantedOrigins(context.taskId);
    await opts.emit("tool.call", { name: tool }, ids);
    if (cancelled()) {
      const cancelledResult = toolError("E_POLICY", "task cancelled");
      await opts.emit("tool.error", { name: tool, result: cancelledResult }, ids);
      return cancelledResult;
    }

    let cause: "observe" | "execute" = "observe";
    let observed: Awaited<ReturnType<typeof observe>>;
    const observation = observe(client, context, [...(context.originSets?.readable ?? []),
      ...(context.originSets?.writable ?? []), ...grantedOrigins], typeof args.ref === "string");
    const blankObserved = {
      origin: (context.origin ? normalizedOrigin(context.origin) : undefined)
        ?? knownOrigins.get(context.computerId) ?? "about:blank",
      signals: context.signals ?? {},
    };
    try {
      if (tool === "request_takeover") {
        observed = await raceFallback(
          observation, context.timeoutMs ?? TAKEOVER_OBSERVE_MS, blankObserved,
        );
      } else if (context.timeoutMs != null) {
        observed = await raceTimeout(observation, context.timeoutMs);
      } else {
        observed = await observation;
      }
    } catch (err) {
      const result = toolError(
        "E_TIMEOUT",
        err instanceof Error ? err.message : String(err),
        { cause },
      );
      await opts.emit("tool.error", { name: tool, result, cause }, ids);
      return result;
    }
    if (observed.navigationDenied && !observed.navigationDenied.ok) {
      const url = String(observed.navigationDenied.error.details!.navigation_url);
      const initialPopup = observed.navigationDenied.error.details?.initial_popup === true;
      if (newDomainArmed() || context.mode === "strict" || initialPopup) {
        return navigationConsent(tool, args, observed.navigationDenied, url, initialPopup, context);
      }
    }
    const back = returned.get(context.computerId);
    if (back && observed.page) {
      back.page ??= observed.page;
      // A page that moved is a new observation: the next ask is a real one.
      if (back.page.hash !== observed.page.hash) returned.delete(context.computerId);
    }
    const onReturnedPage = returned.get(context.computerId) === back ? back : undefined;
    // "Not needed, continue" is an answer about this field on this page.
    // declinedFields only deflects a repeat model request_takeover for the
    // same ask on the same URL. The URL, not the snapshot hash, is the page
    // identity here — typing into the field that was waved through moves the hash.
    if (onReturnedPage?.declined && observed.page) {
      const key = declinedOn(context.taskId, observed.origin);
      const asks = declinedFields.get(key) ?? new Set<string>();
      asks.add(declinedAsk(observed.page.url, onReturnedPage.reason));
      declinedFields.set(key, asks);
    }
    /**
     * Answer the first repeat of the ask a person has already answered with
     * the page itself. A model that asks again after reading it means it,
     * so that one goes through.
     */
    const deflectRepeatAsk = (reason: string): ToolResult | undefined => {
      if (!onReturnedPage?.page || onReturnedPage.answered) return undefined;
      if (!sameReason(reason, onReturnedPage.reason)) return undefined;
      onReturnedPage.answered = true;
      return toolError("E_POLICY", CONTROL_RETURNED, { page: onReturnedPage.page });
    };
    // A remembered site covers everything the task does there. Keeping grants
    // out of `writable` made the grant tool-scoped in practice: mail.google.com
    // was allowed, and then every keystroke and Enter on it was asked again as
    // a first visit.
    const originSets: OriginSets = {
      readable: [...(context.originSets?.readable ?? (observed.origin === "about:blank" ? [] : [observed.origin])), ...grantedOrigins],
      writable: [...(context.originSets?.writable ?? (observed.origin === "about:blank" ? [] : [observed.origin])), ...grantedOrigins],
    };
    let decision = evaluateGate({
      call: { tool, args },
      signals: { ...observed.signals, ...context.signals },
      origin: observed.origin,
      mode: context.mode ?? "supervised",
      origin_sets: originSets,
      enabled_gates: opts.enabledGates,
      kill_switch: opts.killSwitch,
    });

    let approvalArgs = args;
    let approvalOrigin = observed.origin;
    let navigationUrl: string | undefined;
    let gateOrigin = decision.decision === "require_approval" ? decision.origin : undefined;
    if (decision.decision === "require_approval" && decision.origin && navigationUrl === undefined) {
      navigationUrl = decision.origin;
    }
    const originalHash = computeActionHash({
      tool, args, gate: "new_domain", origin: observed.origin, snapshotYaml: observed.yaml,
    });
    // Pending redirect approvals from an older daemon must not re-gate a
    // public GET. Keep their history; only effectful calls still consume them.
    const navigationApproval = context.mode !== "strict" &&
      (tool === "browser_navigate" || (tool === "browser_tabs" && args.action === "new"))
      ? undefined : approvals.find((a) => {
        const approved = JSON.parse(a.args_json) as Record<string, unknown>;
        return a.tool === tool && typeof (JSON.parse(a.bind_json) as { navigation_url?: unknown }).navigation_url === "string" &&
          approved.action && typeof approved.action === "object" &&
          computeActionHash({
            tool, args: approved.action as Record<string, unknown>, gate: "new_domain", origin: observed.origin,
          }) === originalHash;
      });
    if (navigationApproval && decision.decision === "allow") {
      const navArgs = JSON.parse(navigationApproval.args_json) as Record<string, unknown>;
      const target = normalizedOrigin(String(navArgs.navigation_url));
      if (![...originSets.readable, ...originSets.writable].some((p) => originMatchesPattern(target, p))) {
        approvalArgs = navArgs;
        approvalOrigin = target;
        navigationUrl = String((JSON.parse(navigationApproval.bind_json) as { navigation_url: string }).navigation_url);
        gateOrigin = target;
        decision = context.mode === "strict" ? { decision: "deny", reason: `strict_origin_denied:${target}` }
          : newDomainArmed()
            ? { decision: "require_approval", gate: "new_domain", reason: `navigate_new_origin:${target}`, origin: target }
            : { decision: "allow" };
      }
    }

    if (decision.decision === "deny") {
      await opts.emit("policy.denied", { tool, reason: decision.reason }, ids);
      const denied = toolError("E_POLICY", decision.reason);
      await opts.emit("tool.error", { name: tool, result: denied }, ids);
      return denied;
    }

    let pendingOnce: { id: string; decided: ApprovalDecision; remembered: string[] } | undefined;
    if (decision.decision === "require_approval") {
      const gate = decision.gate as PolicyGate;
      const controlEpoch = context.controlEpoch ?? 0;
      const dest = navigationUrl ?? gateOrigin;
      const actionHash = computeActionHash({
        tool,
        args: approvalArgs,
        gate,
        origin: approvalOrigin,
        dest,
        snapshotYaml: observed.yaml,
      });
      const previous = opts.store.findApprovalByAction(context.taskId, actionHash);
      const existing = previous?.status === "expired" || previous?.status === "consumed" ? undefined : previous;
      if (existing) {
        const bind = bindingOf(existing);
        const exact = bind &&
          bind.task_id === context.taskId &&
          bind.control_epoch === controlEpoch &&
          normalizedOrigin(bind.origin) === approvalOrigin &&
          bind.action_hash === actionHash;
        if (exact) {
          if (Date.parse(bind.expires) <= Date.now()) {
            opts.store.setApprovalStatusIf(existing.id, existing.status, "expired", null);
            await opts.emit("approval.expired", { approval_id: existing.id }, ids);
            return toolError("E_POLICY", "approval expired");
          }
          if (existing.status === "pending") {
            const pending = toolError("E_POLICY_PENDING", undefined, {
              approval_id: existing.id,
              bind,
            });
            await opts.emit("tool.error", { name: tool, result: pending }, ids);
            return pending;
          }
          if (existing.status !== "approved") {
            const rejected = toolError("E_POLICY", `approval ${existing.status}`);
            await opts.emit("tool.error", { name: tool, result: rejected }, ids);
            return rejected;
          }
          const decided = (existing.decision as ApprovalDecision | null) ?? "allow_once";
          const storedArgs = JSON.parse(existing.args_json) as Record<string, unknown>;
          const grants = gate === "new_domain"
            ? approvalGrantOrigins(tool, storedArgs, bind.navigation_url)
            : [];
          // "Allow once" buys this one call: the origin is reachable for it and
          // nothing is written down. Only "allow for this task" records a grant,
          // and only a grant makes the origin writable for the rest of the run —
          // otherwise one dismissed card silently authorised every later submit.
          const remembered = decided === "allow_task" ? grants : [];
          if (remembered.length) opts.store.grantTaskOrigins(context.taskId, remembered, existing.id);
          originSets.readable.push(...grants);
          originSets.writable.push(...remembered);
          pendingOnce = { id: existing.id, decided, remembered };
        }
      }
      if (!pendingOnce) {
        const consent = await requestConsent(tool, approvalArgs, gate, context, approvalOrigin, decision.reason,
          navigationUrl, gateOrigin, observed.yaml);
        await opts.emit("tool.error", { name: tool, result: consent }, ids);
        return consent;
      }
    }

    if (tool === "request_takeover") {
      const reason = String(args.reason ?? "");
      const settled = deflectRepeatAsk(reason) ??
        (observed.page && declinedFields.get(declinedOn(context.taskId, observed.origin))
          ?.has(declinedAsk(observed.page.url, reason))
          ? toolError("E_POLICY", CONTROL_RETURNED, { page: observed.page })
          : undefined);
      if (settled) {
        await opts.emit("policy.denied", { tool, reason: "control_already_returned" }, ids);
        await opts.emit("tool.error", { name: tool, result: settled }, ids);
        return settled;
      }
    }

    if (cancelled()) {
      const cancelledResult = toolError("E_POLICY", "task cancelled");
      await opts.emit("tool.error", { name: tool, result: cancelledResult }, ids);
      return cancelledResult;
    }
    const callContext = /^(browser_|computer_)/.test(tool)
      ? { navigationOrigins: [...originSets.readable, ...originSets.writable], allowPublicNavigation: context.mode !== "strict" } : undefined;
    const commitOnce = (result: ToolResult): void => {
      if (!pendingOnce || !spendOnceGrant(result)) return;
      opts.store.consumeApprovalWithGrant(
        pendingOnce.id, "approved", context.taskId, pendingOnce.remembered, pendingOnce.decided,
      );
    };
    cause = "execute";
    const leaseId = tool === "request_takeover" ? `tk_${randomBytes(6).toString("hex")}` : undefined;
    const executeArgs = leaseId ? { ...args, takeover_id: leaseId } : args;
    let result: ToolResult;
    try {
      const running = opts.execute
        ? opts.execute(client, tool, executeArgs, callContext)
        : client.call(tool, executeArgs, callContext);
      if (tool === "request_takeover") {
        result = await raceTimeout(running, context.timeoutMs ?? TAKEOVER_EXECUTE_MS);
      } else if (context.timeoutMs != null) {
        result = await raceTimeout(running, context.timeoutMs);
      } else {
        result = await running;
      }
    } catch (err) {
      // raceTimeout rejects with code E_TIMEOUT. Any other throw never reached
      // the computer; rethrow so allow-once is not spent as if it had.
      if ((err as { code?: string }).code !== "E_TIMEOUT") throw err;
      result = toolError(
        "E_TIMEOUT",
        err instanceof Error ? err.message : String(err),
        { cause },
      );
    }
    if (!result.ok && result.error.code === "E_TIMEOUT") {
      commitOnce(result);
      await opts.emit("tool.error", {
        name: tool,
        arguments: auditArguments(tool, args, { ...observed.signals, ...context.signals }),
        result,
        cause,
      }, ids);
      if (tool === "request_takeover" && leaseId) {
        return busyAfterTakeoverFailure(context, args, ids, leaseId);
      }
      return result;
    }
    if (callContext && !result.ok && typeof result.error.details?.navigation_url === "string") {
      const url = result.error.details.navigation_url;
      const initialPopup = result.error.details.initial_popup === true;
      if (context.mode !== "strict" && !initialPopup && !newDomainArmed()) {
        const dest = normalizedOrigin(url);
        const retryContext = {
          navigationOrigins: [...new Set([...callContext.navigationOrigins, dest])],
          allowPublicNavigation: callContext.allowPublicNavigation,
        };
        result = opts.execute
          ? await opts.execute(client, tool, args, retryContext)
          : await client.call(tool, args, retryContext);
      } else {
        await opts.emit("tool.error", { name: tool, result }, ids);
        await opts.emit("policy.denied", { tool, reason: "navigation_blocked", url }, ids);
        return navigationConsent(tool, args, result, url, initialPopup, context, observed.yaml);
      }
    }
    if (result.ok && tool === "request_takeover") {
      const data = result.data as Record<string, unknown>;
      const takeoverId = recordTakeover(opts.store, context.computerId, context.taskId, data);
      askedFor(context.computerId, String(args.reason ?? ""));
      if (takeoverId) {
        const rawKind = data.field && typeof data.field === "object"
          ? (data.field as { kind?: unknown }).kind
          : undefined;
        const field = rawKind === "password" || rawKind === "otp" ? { kind: rawKind } : undefined;
        await opts.emit("takeover.requested", {
          takeover_id: takeoverId,
          reason: String(args.reason ?? "model"),
          ...(field ? { field } : {}),
        }, ids);
      }
    }
    // First tool the model reaches for once control comes back. Answer it with
    // the page, so the next turn reasons from the screen and not from a step
    // the task text mentioned.
    if (result.ok && tool === "takeover_status" && onReturnedPage?.page) {
      result = { ok: true, data: { ...(result.data as Record<string, unknown>), page: onReturnedPage.page } };
    }
    if (result.ok) {
      const nextOrigin = resultOrigin(result);
      if (nextOrigin) knownOrigins.set(context.computerId, nextOrigin);
    }
    // A saved file is only useful once the human can see and open it. The
    // workspace is bind-mounted, so the file is already on the host the moment
    // write_file returns; "promotion" here is announcing it on the same
    // download.promoted event the results view already listens for, with the
    // workspace-relative path GET /api/v1/computers/:id/files serves by.
    if (result.ok && tool === "write_file") {
      const data = result.data as Record<string, unknown>;
      if (typeof data?.path === "string") {
        await opts.emit("download.promoted", {
          approved_by: "policy",
          source: "write_file",
          path: data.path,
          item_name: data.path,
          bytes: data.bytes,
          sha256: data.sha256,
          computer_id: context.computerId,
          workspace_path: data.path,
        }, ids);
      }
    }
    // The computer is older than this build of the daemon and does not have
    // the tool at all. Say so once, in words, and stop offering it — retrying
    // cannot make an absent method appear.
    if (!result.ok && result.error.code === "E_CAPABILITY" && /unknown method/i.test(result.error.message)) {
      opts.onUnsupportedTool?.(context.computerId, tool);
      result = {
        ok: false,
        error: {
          ...result.error,
          message:
            `This computer cannot ${tool === "write_file" || tool === "files_write" ? "save files" : `run ${tool}`} yet. ` +
            `It was built before that was added, and needs an update before it can. Do not try this again.`,
        },
      };
    }
    commitOnce(result);
    await opts.emit(result.ok ? "tool.result" : "tool.error", {
      name: tool,
      arguments: auditArguments(tool, args, { ...observed.signals, ...context.signals }),
      result: result.ok ? { ok: true } : result,
    }, ids);
    return result;
  }

  return { dispatch };
}
