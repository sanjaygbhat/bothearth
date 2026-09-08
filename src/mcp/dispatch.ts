import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_CATALOGUE } from "../tools/catalog.ts";
import { TOOL_NAMES, type ToolName, type ToolResult } from "../types/contracts.ts";
import { toolError } from "../protocol/errors.ts";
import { isTakeoverExemptTool } from "../protocol/takeover.ts";
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
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    let result = await Promise.race([
      backend.callTool(name, args, ac.signal),
      new Promise<ToolResult>((_, reject) => {
        ac.signal.addEventListener(
          "abort",
          () =>
            reject(
              Object.assign(new Error("tool timeout"), { code: "E_TIMEOUT" }),
            ),
          { once: true },
        );
      }),
    ]);

    if (name === "request_takeover" && result.ok) {
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
    if (
      msg.includes("timeout") ||
      (e as { code?: string }).code === "E_TIMEOUT"
    ) {
      return toolResultToMcp(
        toolError("E_TIMEOUT", `tool exceeded ${timeoutMs}ms`),
      );
    }
    return toolResultToMcp(toolError("E_IO", msg));
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
