import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toolError } from "../protocol/errors.ts";
import { isTakeoverExemptTool } from "../protocol/takeover.ts";
import { TOOL_CATALOGUE } from "../tools/catalog.ts";
import { TOOL_NAMES, type ToolName, type ToolResult } from "../types/contracts.ts";
import type { McpToolBackend } from "./types.ts";

export function catalogueAsMcpTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return TOOL_CATALOGUE.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as unknown as Record<string, unknown>,
  }));
}

export function isCatalogueTool(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

function stripImagePayload(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const obj = { ...(data as Record<string, unknown>) };
  delete obj.jpeg_base64;
  delete obj.png_base64;
  delete obj.base64;
  delete obj.bytes;
  return obj;
}

function isMcpToolTimeoutReason(reason: unknown): boolean {
  if (reason === "mcp_tool_timeout") return true;
  return Boolean(
    reason &&
      typeof reason === "object" &&
      (reason as { cause?: unknown }).cause === "mcp_tool_timeout",
  );
}

function extractImage(
  data: unknown,
): { mimeType: string; data: string } | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  const b64 =
    (typeof obj.jpeg_base64 === "string" && obj.jpeg_base64) ||
    (typeof obj.png_base64 === "string" && obj.png_base64) ||
    (typeof obj.base64 === "string" && obj.base64) ||
    null;
  if (!b64) return null;
  const mime =
    typeof obj.mime === "string"
      ? obj.mime
      : typeof obj.mimeType === "string"
        ? obj.mimeType
        : obj.png_base64
          ? "image/png"
          : "image/jpeg";
  return { mimeType: mime, data: b64 };
}

function enrichTakeoverResult(
  data: Record<string, unknown>,
  uiControlUrl: string,
): Record<string, unknown> {
  // Plain UI URL only — never embed tokens or capability secrets.
  return data.takeover_id ? { ...data, url: uiControlUrl } : data;
}

export function toolResultToMcp(result: ToolResult): CallToolResult {
  if (!result.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      isError: true,
    };
  }
  const image = extractImage(result.data);
  const textPayload = {
    ok: true as const,
    data: stripImagePayload(result.data),
  };
  const content: CallToolResult["content"] = [
    { type: "text", text: JSON.stringify(textPayload) },
  ];
  if (image) {
    content.push({
      type: "image",
      data: image.data,
      mimeType: image.mimeType,
    });
  }
  return { content, isError: false };
}

export async function dispatchToolCall(
  backend: McpToolBackend,
  name: string,
  args: Record<string, unknown>,
  opts: { toolTimeoutMs: number; signal?: AbortSignal },
): Promise<CallToolResult> {
  if (!isCatalogueTool(name)) {
    return toolResultToMcp(
      toolError("E_CAPABILITY", `unknown tool: ${name}`),
    );
  }

  const timeoutMs = opts.toolTimeoutMs;
  const ac = new AbortController();
  let timedOut = false;
  const abortChild = (reason: unknown) => {
    if (!ac.signal.aborted) ac.abort(reason);
  };
  const onAbort = () => abortChild({ cause: "abort" });
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    abortChild({ cause: "mcp_tool_timeout", timeout_ms: timeoutMs });
  }, timeoutMs);

  const timeoutResult = () =>
    toolError("E_TIMEOUT", `tool exceeded ${timeoutMs}ms`, {
      cause: "mcp_tool_timeout",
      timeout_ms: timeoutMs,
    });
  const abortResult = () => toolError("E_TIMEOUT", "tool call aborted", { cause: "abort" });

  try {
    const timeoutWait = new Promise<ToolResult>((resolve) => {
      const fail = () => {
        resolve(
          timedOut || isMcpToolTimeoutReason(ac.signal.reason) ? timeoutResult() : abortResult(),
        );
      };
      if (ac.signal.aborted) fail();
      else ac.signal.addEventListener("abort", fail, { once: true });
    });

    let result = await Promise.race([backend.callTool(name, args, ac.signal), timeoutWait]);

    if (timedOut) result = timeoutResult();
    else if (name === "request_takeover" && result.ok) {
      const data = enrichTakeoverResult(
        result.data as Record<string, unknown>,
        backend.uiControlUrl ?? `${backend.uiBaseUrl.replace(/\/$/, "")}/#/live`,
      );
      for (const k of Object.keys(data)) {
        if (/token|secret|capability|bootstrap/i.test(k) && k !== "url") {
          delete data[k];
        }
      }
      result = { ok: true, data };
    }

    return toolResultToMcp(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (timedOut || isMcpToolTimeoutReason(ac.signal.reason))
      return toolResultToMcp(timeoutResult());
    if (
      opts.signal?.aborted ||
      ac.signal.aborted ||
      (e as { code?: string }).code === "E_TIMEOUT"
    ) {
      return toolResultToMcp(abortResult());
    }
    return toolResultToMcp(toolError("E_IO", msg));
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
