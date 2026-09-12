/**
 * Shared ModelBot contracts. Most of this file is ordinary code: change it
 * like any other type.
 *
 * The exceptions are the shapes `tests/contracts/fields.test.ts` builds as
 * literals — `ApprovalBind`, `BrowserSnapshotOutput`, `BrowserScreenshotOutput`,
 * `CreateTaskBody`, `FilesDownloadQuery`, `PolicyPendingDetails` and
 * `UsageEventBody`. Removing or renaming one of their fields breaks that test,
 * and for `ApprovalBind` so does adding one: its exact key set is asserted
 * because the approval binding is hashed and compared byte for byte.
 *
 * Everything that crosses a wire or lands on disk — `ScreencastFrameHeader`,
 * `ComputerJsonRpc*`, `ToolResult`, the takeover states, `ErrorCode`,
 * `EventType`, `AuditRecord`, `ModelbotConfig` — is a compatibility surface for
 * older clients and stored data, so change those additively.
 */

export type SideEffect = "read" | "act" | "gated";
export type ToolDriver = "a11y" | "vision" | "both" | "system";

export const TOOL_NAMES = [
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_scroll",
  "browser_select",
  "browser_upload",
  "browser_tabs",
  "browser_screenshot",
  "browser_wait",
  "browser_restart",
  "computer_mouse",
  "computer_key",
  "computer_type",
  "shell_exec",
  "files_list",
  "files_read",
  "files_write",
  "files_delete",
  "write_file",
  "request_takeover",
  "takeover_status",
  "connector_call",
  "done",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface JsonSchema {
  $schema?: string;
  $id?: string;
  title?: string;
  description?: string;
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  minItems?: number;
  [k: string]: unknown;
}

export interface ToolCatalogueEntry {
  name: ToolName;
  description: string;
  inputSchema: JsonSchema;
  sideEffect: SideEffect;
  driver: ToolDriver;
}

export interface ToolErrorBody {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type ToolResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: ToolErrorBody };

export interface BrowserSnapshotOutput {
  snapshot_id: string;
  yaml: string;
  truncated: boolean;
  refs: string[];
  url: string;
  title: string;
  omitted?: { nodes: number; chars: number };
}

export interface BrowserScreenshotOutput {
  image_id: string;
  mime: string;
  width: number;
  height: number;
  css_width: number;
  css_height: number;
  scale: number;
  scroll_x: number;
  scroll_y: number;
}

export interface ShellExecOutput {
  exit_code: number;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

/** Durable FSM (ARCH §1), including TTL→paused. */
export type TakeoverState =
  | "agent"
  | "takeover_requested"
  | "human"
  | "resume_validating"
  | "paused"
  | "terminated";

/** Wire values for takeover_status. */
export type TakeoverWireState =
  | "requested"
  | "human"
  | "validating"
  | "agent"
  | "paused"
  | "expired"
  | "terminated";

export type TakeoverEvent =
  | "request"
  | "grant"
  | "release"
  | "decline"
  | "validated"
  | "still_sensitive"
  | "ttl"
  | "stop";

export interface TakeoverTransition {
  from: TakeoverState;
  event: TakeoverEvent;
  to: TakeoverState;
}

export type LiveMode = "agent" | "human" | "validating";

export interface ScreencastFrameHeader {
  v: 1;
  seq: number;
  ts: number;
  mime: "image/jpeg" | "image/png";
  mode: LiveMode;
  epoch: number;
  target: string;
  viewport: { w: number; h: number; dpr: number };
  meta: {
    offsetTop: number;
    pageScaleFactor: number;
    deviceWidth: number;
    deviceHeight: number;
    scrollOffsetX: number;
    scrollOffsetY: number;
  };
}

export interface ApprovalBind {
  task_id: string;
  control_epoch: number;
  origin: string;
  action_hash: string;
  expires: string;
}

export interface ApprovalRequest {
  approval_id: string;
  tool: ToolName;
  args: Record<string, unknown>;
  gate: PolicyGate;
  bind: ApprovalBind;
  created_at: string;
}

/**
 * `allow_task` is `allow_once` plus a remembered grant for the rest of this
 * task ("always allow this site for this task"); it never outlives the task.
 */
export type ApprovalDecision = "allow_once" | "allow_task" | "deny" | "kill";

/** Optional MCP-tool approval classes. Empty by default; force-human stops (including payment-card entry) are not in this list. `payment` is an extra confirm for checkout without a card field. */
export const OPTIONAL_POLICY_GATES = [
  "external_send",
  "payment",
  "upload",
  "delete",
  "secret_entry",
  "new_domain",
] as const;

export type PolicyGate = (typeof OPTIONAL_POLICY_GATES)[number];

/** ARCH §6 event enum (shared with audit). */
export type EventType =
  | "native_tool"
  | "task.started"
  | "task.step"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "task.resumed"
  | "tool.call"
  | "tool.result"
  | "tool.error"
  | "approval.requested"
  | "approval.decided"
  | "approval.expired"
  | "download.promoted"
  | "takeover.requested"
  | "takeover.started"
  | "takeover.gap"
  | "takeover.released"
  | "takeover.declined"
  | "takeover.expired"
  | "policy.denied"
  | "sandbox.started"
  | "sandbox.stopped"
  | "sandbox.oom"
  | "sandbox.error"
  | "usage"
  | "notify.sent"
  | "error";

export const EVENT_TYPES = [
  "native_tool",
  "task.started",
  "task.step",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.resumed",
  "tool.call",
  "tool.result",
  "tool.error",
  "approval.requested",
  "approval.decided",
  "approval.expired",
  "download.promoted",
  "takeover.requested",
  "takeover.started",
  "takeover.gap",
  "takeover.released",
  "takeover.declined",
  "takeover.expired",
  "policy.denied",
  "sandbox.started",
  "sandbox.stopped",
  "sandbox.oom",
  "sandbox.error",
  "usage",
  "notify.sent",
  "error",
] as const satisfies readonly EventType[];

export interface UiEvent {
  type: EventType;
  ts: string;
  task_id?: string;
  computer_id?: string;
  body: Record<string, unknown>;
}

export interface AuditRecord {
  v: 1;
  seq: number;
  ts: string;
  type: EventType;
  task_id?: string;
  computer_id?: string;
  body: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export type AuditHashPayload = Omit<AuditRecord, "hash">;

/** ARCH §4 common errors. */
export type ErrorCode =
  | "E_AUTH"
  | "E_CAPABILITY"
  | "E_SPEND_CAP"
  | "E_POLICY"
  | "E_POLICY_PENDING"
  | "E_STALE_REF"
  | "E_TIMEOUT"
  | "E_TAKEOVER_BUSY"
  | "E_TAKEOVER_EXPIRED"
  | "E_SANDBOX_DEAD"
  | "E_IO"
  | "E_LIMIT";

export interface McpToolDescriptor {
  name: ToolName;
  description: string;
  inputSchema: JsonSchema;
}

/** Providers that ship with ModelBot. */
export type BuiltinAdapterKind = "openai_compat" | "anthropic";
/**
 * Any registered adapter name. Built-ins keep their literal types (and editor
 * completion); a third-party provider registers whatever name it likes.
 */
export type AdapterKind = BuiltinAdapterKind | (string & {});

export interface AdapterMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | AdapterContentPart[];
  tool_call_id?: string;
  name?: string;
}

export type AdapterContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image_id: string; mime: string };

export interface AdapterToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AdapterCompleteRequest {
  signal?: AbortSignal;
  system: string;
  messages: AdapterMessage[];
  tools: McpToolDescriptor[];
  model: string;
}

export interface AdapterCompleteResponse {
  content?: string;
  tool_calls: AdapterToolCall[];
  usage: { tokens_in: number; tokens_out: number; usd_est?: number };
}

export interface ProviderAdapter {
  readonly kind: AdapterKind;
  complete(req: AdapterCompleteRequest): Promise<AdapterCompleteResponse>;
}

export type LadderRung =
  | "A11Y_FULL"
  | "A11Y_SCOPED"
  | "ELEMENT_SHOT"
  | "VISION_COORDS"
  | "TAKEOVER";

export type DriverKind = "a11y" | "vision" | "hybrid";

export interface DriverObserveResult {
  rung: LadderRung;
  observation: unknown;
  observation_hash: string;
}

export interface Driver {
  readonly kind: DriverKind;
  observe(computerId: string): Promise<DriverObserveResult>;
}

export type SandboxRuntimeKind = "auto" | "orbstack" | "colima" | "docker" | "podman";
export type ComputerCapability = "browser" | "shell";

export interface SandboxCreateOpts {
  name: string;
  capabilities: ComputerCapability[];
  persistent?: boolean;
}

export interface SandboxHandle {
  computer_id: string;
  name: string;
  capabilities: ComputerCapability[];
}

export interface SandboxRuntime {
  detect(): Promise<Exclude<SandboxRuntimeKind, "auto">>;
  create(opts: SandboxCreateOpts): Promise<SandboxHandle>;
  stop(computerId: string): Promise<void>;
  destroy(computerId: string): Promise<void>;
}

export interface ComputerJsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

export interface ComputerJsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface CreateComputerBody {
  name: string;
  capabilities: ComputerCapability[];
  persistent?: boolean;
}

/** Trusted harness-runner binding; accepted only on the authenticated UI API. */
export interface CreateHarnessBindingBody {
  task_id: string;
  computer_id: string;
  execution: "harness";
  spend_cap_usd: number;
  max_steps: number;
}

export type NativeProvider = "codex" | "claude";

export interface NativeTaskSettings {
  adapter: NativeProvider;
  model: string;
  execution_mode: "executor" | "orchestrator";
  reasoning_effort?: "low" | "medium" | "high";
  execution_location?: "computer" | "host";
  executor?: { adapter: NativeProvider; model: string };
}

export interface CreateTaskBody {
  /** Omit to use the operator's default browser workspace. */
  computer_id?: string;
  goal: string;
  adapter?: string;
  model?: string;
  execution_mode?: NativeTaskSettings["execution_mode"];
  reasoning_effort?: NativeTaskSettings["reasoning_effort"];
  executor?: NativeTaskSettings["executor"];
  /** Internal ladder hint only — never a user-facing driver picker. */
  driver?: DriverKind;
  capabilities?: ComputerCapability[];
  max_steps?: number;
  /** Overrides `agent.spend_cap_usd` for an API-adapter task. Ignored for native Codex / Claude Code tasks. */
  spend_cap_usd?: number;
}

/**
 * GET /api/v1/computers/:id/files?path=
 * Stream workspace file; path must realpath-jail under /workspace.
 */
export interface FilesDownloadQuery {
  path: string;
}

/** EventType "usage" body (ARCH §7 loop emit). */
export interface UsageEventBody {
  tokens_in: number;
  tokens_out: number;
  usd_est?: number;
  steps: number;
}

/**
 * What one task has spent and what it may spend, on `GET /api/v1/tasks/:id`.
 * Read from the counter the cap enforcer itself reads, so the meter on screen
 * and the limit that stops the task can never disagree.
 */
export interface TaskBudget {
  /** Spent so far. Null only when nothing has priced this task's work yet. */
  spend_usd: number | null;
  /** The cap this task runs against. Null when nothing here will stop it. */
  spend_cap_usd: number | null;
  /** Tool calls the cap has counted. */
  calls: number;
  /**
   * Tool calls left before something stops the task: the lower of what
   * `spend_cap_usd` buys at the per-call price and the step budget, both of
   * which a harness run counts in tool calls. Null when there is no tool-call
   * ceiling — a standalone run (provider estimate, model-turn steps) or a
   * native run that BotHearth does not cap.
   */
  calls_cap: number | null;
}

/**
 * Frozen-at-completion receipt for a task, computed once from the durable
 * event log. Re-reading a finished task returns byte-identical values.
 */
export interface TaskSummary {
  /** Agent steps the loop actually ran. Same figure as the live view: tool calls. */
  steps: number;
  /** Hostnames the task visited, first contact first. */
  sites: string[];
  /** Approvals and takeovers the task asked the operator for. */
  asks: number;
  /** Workspace paths the task wrote or promoted. */
  files_saved: string[];
  /** Estimated provider spend; null when the provider priced nothing. */
  cost_usd: number | null;
  /**
   * Set when `files_saved` has been corrected against what is actually on
   * disk — a file the frozen receipt named is gone, or was never written.
   * It tells a reader that this list, not anything the feed remembers, is the
   * whole truth about what the task saved.
   */
  repaired?: boolean;
}

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "consumed"
  | "denied"
  | "expired"
  | "killed";

/** Non-blocking approval poll (REST/UI; not an MCP tool). */
export interface ApprovalStatusView {
  approval_id: string;
  status: ApprovalStatus;
  bind: ApprovalBind;
}

/** E_POLICY_PENDING details — mutating tools blocked while pending. */
export interface PolicyPendingDetails {
  approval_id: string;
  bind: ApprovalBind;
}

/** Default approval lease (seconds) when bind.expires omitted by issuer. */
export const APPROVAL_TTL_SEC = 120 as const;

export type Mode = "supervised" | "strict";

export interface AdapterEndpointConfig {
  base_url?: string;
  model: string;
  api_key_vault?: string;
  api_key_env?: string;
  price_per_mtok_in?: number;
  price_per_mtok_out?: number;
  extra?: Record<string, unknown>;
}

/** Mirrors modelbot.schema.json / ARCH §3. */
export interface ModelbotConfig {
  version: 1;
  bind: string;
  port: number;
  auth: { mcp_token_env: string };
  data_dir: string;
  updates: { check: boolean };
  mode: Mode;
  policy: {
    gates: PolicyGate[];
    categories_path: string;
    tos_risk_path: string;
    strict_allowlist: string[];
    kill_switch: boolean;
    /** Seconds an approval stays answerable before it expires. */
    approval_ttl_sec: number;
  };
  sandbox: {
    runtime: SandboxRuntimeKind;
    image_browser: string;
    image_shell: string;
    memory: string;
    cpus: number;
    shm_size: string;
    max_computers: number;
    idle_pause_min: number;
    workspace_root: string;
    capabilities: ComputerCapability[];
  };
  browser: {
    max_tabs: number;
    default_tabs: number;
    snapshot_max_chars: number;
    screenshot_max: number;
    screenshot_jpeg_q: number;
  };
  agent: {
    /** API-adapter loop only; each step is a paid API call. 0 = no cap. Native tasks ignore this. */
    max_steps: number;
    loop_identical: number;
    stall_sec: number;
    /** What one API-adapter task is given when the request names no budget. 0 = no cap. Native tasks have no BotHearth spend cap. */
    spend_cap_usd: number;
    /** The most an API-adapter request or resume may ask for; 0 = no maximum. Above a positive ceiling the daemon refuses. */
    spend_cap_max_usd: number;
    /** Seconds one run may take before it pauses; 0 means no time limit. */
    max_runtime_sec: number;
    context_tokens_max: number;
    compact_at: number;
    token_cap_in: number | null;
    token_cap_out: number | null;
  };
  adapters: {
    default: AdapterKind;
    openai_compat: AdapterEndpointConfig;
    anthropic?: AdapterEndpointConfig;
  };
  mcp: {
    server: {
      http_path: string;
      stdio_bridge: boolean;
      tool_timeout_sec: number;
    };
    connectors: unknown[];
  };
  takeover: { ttl_sec: number; notify: string[] };
  scheduler: {
    enabled: boolean;
    routines: Array<{
      id: string;
      cron: string;
      task: string;
      notify_on: Array<"fail" | "done">;
    }>;
  };
  remote: { access: string; allowed_hosts?: string[]; public_origin?: string };
  audit: { path: string };
  vault: { path: string; keychain: "auto" | "passphrase" };
}
