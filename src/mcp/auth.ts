import type { IncomingMessage } from "node:http";
import {
  checkHost,
  checkMcpOrigin,
  isMcpToken,
} from "../daemon/auth.ts";

export type McpAuthFailure = {
  status: 401 | 403;
  error: string;
};

/**
 * /mcp auth gate (ARCH §6 + DECISIONS R2):
 * Bearer mcp_token required; any Origin rejected; Host must be loopback (or allowedHosts).
 */
export function authorizeMcpRequest(
  req: IncomingMessage,
  opts: { mcpToken: string; port: number; allowedHosts?: string[] },
): McpAuthFailure | null {
  if (checkMcpOrigin(req.headers.origin) === "bad") {
    return { status: 403, error: "browser Origin not allowed on /mcp" };
  }
  if (!checkHost(req.headers.host, opts.port, opts.allowedHosts ?? [])) {
    return { status: 403, error: "invalid Host" };
  }
  if (!isMcpToken(req.headers.authorization, opts.mcpToken)) {
    return { status: 401, error: "missing or invalid bearer token" };
  }
  return null;
}
