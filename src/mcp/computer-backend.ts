import type { ComputerClient } from "../computer-client/types.ts";
import type { ToolName, ToolResult } from "../types/contracts.ts";
import type { McpToolBackend } from "./types.ts";

interface ComputerBackendOpts {
  client: ComputerClient;
  uiBaseUrl: string;
}

/** Adapt a ComputerClient into the MCP tool backend. */
export function createComputerMcpBackend(
  opts: ComputerBackendOpts,
): McpToolBackend {
  const { client } = opts;
  return {
    uiBaseUrl: opts.uiBaseUrl,
    async callTool(
      name: ToolName,
      args: Record<string, unknown>,
      _signal: AbortSignal,
    ): Promise<ToolResult> {
      return client.call(name, args);
    },
    async releaseTakeover(takeoverId: string): Promise<ToolResult> {
      return client.releaseTakeover(takeoverId);
    },
    async grantTakeover(takeoverId: string): Promise<ToolResult> {
      return client.grantTakeover(takeoverId);
    },
    async declineTakeover(takeoverId: string): Promise<ToolResult> {
      return client.declineTakeover(takeoverId);
    },
  };
}
