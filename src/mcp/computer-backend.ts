import type { ComputerClient } from "../computer-client/types.ts";
import { toolError } from "../protocol/errors.ts";
import type { ToolName, ToolResult } from "../types/contracts.ts";
import type { McpToolBackend } from "./types.ts";

interface ComputerBackendOpts {
  client: ComputerClient;
  uiBaseUrl: string;
}

/** Adapt a ComputerClient into the MCP tool backend. */
export function createComputerMcpBackend(opts: ComputerBackendOpts): McpToolBackend {
  const { client } = opts;
  return {
    uiBaseUrl: opts.uiBaseUrl,
    async callTool(
      name: ToolName,
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<ToolResult> {
      const aborted = () => toolError("E_TIMEOUT", "tool call aborted", { cause: "abort" });
      if (signal.aborted) return aborted();
      return new Promise<ToolResult>((resolve, reject) => {
        const onAbort = () => resolve(aborted());
        signal.addEventListener("abort", onAbort, { once: true });
        client.call(name, args).then(
          (result) => {
            signal.removeEventListener("abort", onAbort);
            resolve(signal.aborted ? aborted() : result);
          },
          (error) => {
            signal.removeEventListener("abort", onAbort);
            if (signal.aborted) resolve(aborted());
            else reject(error);
          },
        );
      });
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
