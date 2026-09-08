import type {
  McpToolDescriptor,
  ToolName,
  ToolResult,
} from "../types/contracts.ts";

/** Injected by daemon/tests — MCP never owns computer transport. */
export interface McpToolBackend {
  callTool(
    name: ToolName,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolResult>;

  /** Loopback UI base for takeover URLs (no secrets). */
  uiBaseUrl: string;
  /** Exact operator control view when this backend is bound to a computer. */
  uiControlUrl?: string;

  /** Dynamic, capability-filtered manifest for the selected computer. */
  listTools?(): McpToolDescriptor[];

  releaseTakeover?(takeoverId: string): Promise<ToolResult>;
  grantTakeover?(takeoverId: string): Promise<ToolResult>;
  declineTakeover?(takeoverId: string): Promise<ToolResult>;
}

export interface McpServerOptions {
  /** Immutable mount path for a task-scoped server; defaults to /mcp. */
  path?: string;
  mcpToken: string;
  port: number;
  backend: McpToolBackend;
  /** Tool call timeout (ms). Default 300_000. */
  toolTimeoutMs?: number;
  /** Allowed Host values beyond loopback (tailnet). */
  allowedHosts?: string[];
  serverName?: string;
  serverVersion?: string;
}

export interface McpStandaloneHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}
