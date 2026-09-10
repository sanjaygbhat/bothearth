/**
 * Real ComputerClient over docker exec stdio JSON-RPC.
 * Browser tools → browser container; shell/files → shell container.
 */
import { EventEmitter } from "node:events";
import { execTransport, type ExecTransportOpts } from "../sandbox/exec.ts";
import type { JsonRpcClient } from "../sandbox/client.ts";
import { toolError } from "../protocol/errors.ts";
import { encodeLiveFrame, liveRelayMethod } from "../protocol/live.ts";
import {
  applyTakeoverTransition,
  fromWireState,
} from "../protocol/takeover.ts";
import type {
  ComputerCapability,
  TakeoverState,
  TakeoverWireState,
  ToolResult,
} from "../types/contracts.ts";
import type { ComputerCallContext, ComputerClient, LiveFrameEvent } from "./types.ts";

const WIRE_STATES: ReadonlySet<TakeoverWireState> = new Set([
  "requested",
  "human",
  "validating",
  "agent",
  "paused",
  "expired",
  "terminated",
]);

function statusData(result: ToolResult): Record<string, unknown> {
  return result.ok && result.data && typeof result.data === "object"
    ? (result.data as Record<string, unknown>)
    : {};
}

function statusTakeoverId(result: ToolResult): string {
  return String(statusData(result).takeover_id ?? "");
}

function statusTakeoverState(result: ToolResult): TakeoverState | null {
  const w = statusData(result).state;
  if (typeof w !== "string" || !WIRE_STATES.has(w as TakeoverWireState)) {
    return null;
  }
  return fromWireState(w as TakeoverWireState);
}

function idMismatch(result: ToolResult, takeoverId: string): boolean {
  const current = statusTakeoverId(result);
  return Boolean(current && current !== takeoverId);
}

function canDeclineState(state: TakeoverState | null): boolean {
  return (
    state === "agent" ||
    (state != null && applyTakeoverTransition(state, "decline") != null)
  );
}

const SHELL_METHODS = new Set([
  "shell_exec",
  "files_list",
  "files_read",
  "files_write",
  "files_delete",
]);

interface ExecComputerOpts extends ExecTransportOpts {
  capabilities?: ComputerCapability[];
}

export class ExecComputerClient extends EventEmitter implements ComputerClient {
  readonly computerId: string;
  private readonly opts: ExecComputerOpts;
  private browser: JsonRpcClient | null = null;
  private shell: JsonRpcClient | null = null;
  private closed = false;
  private liveWanted = false;
  private liveClient: JsonRpcClient | null = null;
  private liveTail = Promise.resolve();
  private connecting = new Map<"browser" | "shell", Promise<JsonRpcClient>>();

  constructor(computerId: string, opts: ExecComputerOpts = {}) {
    super();
    this.computerId = computerId;
    this.opts = opts;
  }

  protected async rpc(role: "browser" | "shell"): Promise<JsonRpcClient> {
    if (this.closed) throw new Error("computer client closed");
    const existing = this[role];
    if (existing && !existing.closed) return existing;
    const pending = this.connecting.get(role);
    if (pending) return pending;
    // Replace a failed transport for the next call; never replay an action whose
    // execution may already have reached the browser.
    const connection = (async () => {
      if (existing) { this[role] = null; await existing.close(); }
      return execTransport(this.computerId, role, {
      ...this.opts,
      // Live frames are operator-only events, never RPC results or model artifacts.
      onLiveFrame: role === "browser" ? (header, payload) => {
        if (this.liveWanted && !this.closed) this.emit("frame", {
          header, payload, bytes: encodeLiveFrame(header, payload),
        } satisfies LiveFrameEvent);
      } : undefined,
    });
    })().then(async (client) => {
      if (this.closed) { await client.close(); throw new Error("computer client closed"); }
      this[role] = client;
      if (existing && role === "browser" && this.liveWanted) {
        try { await this.subscribeLive(client); }
        catch { this.emit("mode", { v: 1, t: "error", code: "E_IO", message: "Browser view could not reconnect." }); }
      }
      return client;
    }).finally(() => this.connecting.delete(role));
    this.connecting.set(role, connection);
    return connection;
  }

  private async optionalShellRpc(): Promise<JsonRpcClient | null> {
    return this.opts.capabilities && !this.opts.capabilities.includes("shell")
      ? null
      : this.rpc("shell");
  }

  private roleFor(method: string): "browser" | "shell" {
    return SHELL_METHODS.has(method) ? "shell" : "browser";
  }

  async call(method: string, params?: unknown, context?: ComputerCallContext): Promise<ToolResult> {
    if (this.closed) return toolError("E_SANDBOX_DEAD");
    try {
      const client = await this.rpc(this.roleFor(method));
      const result = context
        ? await client.request("policy.call", { method, params, navigation_origins: context.navigationOrigins,
          ...(context.allowPublicNavigation ? { allow_public_navigation: true } : {}) })
        : await client.request(method, params);
      return result as ToolResult;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not running|no such container|E_SANDBOX/i.test(msg)) {
        return toolError("E_SANDBOX_DEAD", msg);
      }
      return toolError("E_IO", msg);
    }
  }

  /**
   * Drive one takeover step on both containers. All-or-nothing: the browser
   * decides, and the shell is only touched once the browser has accepted, so
   * the two sides can never disagree about who holds control.
   */
  private async both(method: string, params: Record<string, unknown>): Promise<ToolResult> {
    const browser = await this.rpc("browser");
    const shell = await this.optionalShellRpc();
    const browserResult = await browser.request(method, params) as ToolResult;
    if (!browserResult.ok || !shell) return browserResult;
    const shellResult = await shell.request(method, params) as ToolResult;
    return shellResult.ok ? browserResult : shellResult;
  }

  async grantTakeover(takeoverId: string): Promise<ToolResult> {
    const params = { takeover_id: takeoverId };
    const browser = await this.rpc("browser");
    const status = await browser.request("takeover_status", params) as ToolResult;
    if (!status.ok) return status;
    // Bind id and legality before takeover.sync: a stale id must not rewrite
    // the shell session.
    const state = statusTakeoverState(status);
    if (
      statusTakeoverId(status) !== takeoverId ||
      !state ||
      !applyTakeoverTransition(state, "grant")
    ) {
      return toolError("E_POLICY", "invalid takeover grant");
    }
    const shell = await this.optionalShellRpc();
    if (shell) {
      const synced = await shell.request("takeover.sync", {
        ...params,
        expires_at: statusData(status).expires_at,
        state: "requested",
      }) as ToolResult;
      if (!synced.ok) return synced;
    }
    return this.both("takeover.grant", params);
  }

  async declineTakeover(takeoverId: string): Promise<ToolResult> {
    const params = { takeover_id: takeoverId };
    const browser = await this.rpc("browser");
    const shell = await this.optionalShellRpc();
    const [bStatus, sStatus] = await Promise.all([
      browser.request("takeover_status", params) as Promise<ToolResult>,
      shell?.request("takeover_status", params) as Promise<ToolResult> | undefined,
    ]);
    if (!bStatus.ok) return bStatus;
    if (sStatus && !sStatus.ok) return sStatus;
    // If either side cannot reach agent, touch nothing. A shell already in
    // agent is legal — it never received request_takeover.
    if (
      idMismatch(bStatus, takeoverId) ||
      (sStatus && idMismatch(sStatus, takeoverId)) ||
      !canDeclineState(statusTakeoverState(bStatus)) ||
      (sStatus && !canDeclineState(statusTakeoverState(sStatus)))
    ) {
      return toolError("E_POLICY", "invalid takeover decline");
    }
    return this.both("takeover.decline", params);
  }

  async releaseTakeover(takeoverId: string): Promise<ToolResult> {
    const params = { takeover_id: takeoverId };
    const browser = await this.rpc("browser");
    const shell = await this.optionalShellRpc();
    const [bStatus, sStatus] = await Promise.all([
      browser.request("takeover_status", params) as Promise<ToolResult>,
      shell?.request("takeover_status", params) as Promise<ToolResult> | undefined,
    ]);
    if (!bStatus.ok) return bStatus;
    if (sStatus && !sStatus.ok) return sStatus;
    if (idMismatch(bStatus, takeoverId) || (sStatus && idMismatch(sStatus, takeoverId))) {
      return toolError("E_POLICY", "invalid takeover release");
    }
    const released = await this.both("takeover.release", params);
    if (!released.ok) return released;
    const observation = await browser.request("takeover.masked-observation", {}) as ToolResult;
    if (!observation.ok) return observation;
    return this.both("takeover.validate", {
      ...params,
      still_sensitive: Boolean((observation.data as Record<string, unknown>).still_sensitive),
    });
  }

  async expireTakeover(takeoverId: string): Promise<ToolResult> {
    return this.both("takeover.ttl", { takeover_id: takeoverId });
  }

  async relayInput(msg: unknown): Promise<ToolResult> {
    if (this.closed) return toolError("E_SANDBOX_DEAD");
    const method = liveRelayMethod(msg);
    try {
      const c = await this.rpc("browser");
      const result = (await c.request(method, msg)) as ToolResult;
      if (result && typeof result === "object" && "ok" in result) return result;
      return { ok: true, data: { relayed: true } };
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      return toolError("E_IO", err);
    }
  }

  private async subscribeLive(client: JsonRpcClient): Promise<void> {
    if (!this.liveWanted || this.closed || this.liveClient === client) return;
    this.liveClient = client;
    try {
      const result = await client.request("screencast.subscribe", {}) as ToolResult;
      if (!result.ok) throw new Error(result.error.message);
    } catch (error) {
      if (this.liveClient === client) this.liveClient = null;
      throw error;
    }
  }

  startLive(_intervalMs?: number): void {
    if (this.liveWanted || this.closed) return;
    this.liveWanted = true;
    this.liveTail = this.liveTail.then(async () => {
      if (!this.liveWanted || this.closed) return;
      const c = await this.rpc("browser");
      await this.subscribeLive(c);
    }).catch((error) => {
      this.liveWanted = false;
      this.emit("mode", { v: 1, t: "error", code: "E_IO", message: String(error) });
    });
  }

  stopLive(): void {
    this.liveWanted = false;
    this.liveTail = this.liveTail.then(async () => {
      // A queued startup may have subscribed since stopLive was called.
      this.liveClient = null;
      await this.browser?.request("screencast.unsubscribe", {});
    }).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopLive();
    await Promise.all([
      this.browser?.close().catch(() => undefined),
      this.shell?.close().catch(() => undefined),
    ]);
    this.browser = null;
    this.shell = null;
    this.removeAllListeners();
  }
}

export function createExecComputerClient(
  computerId: string,
  opts?: ExecComputerOpts,
): ExecComputerClient {
  return new ExecComputerClient(computerId, opts);
}
