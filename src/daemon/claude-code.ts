/** The installed, unmodified Claude Code CLI owns all Anthropic authentication. */
export function claudeEnvironment(configDir: string): NodeJS.ProcessEnv {
  // Preserve native API/cloud/helper authentication. Never pass ModelBot's vault or general bearer.
  const daemonOnly = new Set(["CREDENTIALS_DIRECTORY", "NOTIFY_SOCKET", "LISTEN_FDS", "LISTEN_PID", "LISTEN_FDNAMES"]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MODELBOT_") && !daemonOnly.has(key)));
  // Even the default directory spelled explicitly changes native keychain identity on macOS.
  return { ...env, PATH: [dirname(process.execPath), env.PATH].filter(Boolean).join(delimiter),
    ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}), ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
}

export function claudeTaskArgs(model: string, url: string, resume?: string): string[] {
  return ["--print", "--output-format", "stream-json", "--verbose", ...(model ? ["--model", model] : []),
    "--tools", "", "--disable-slash-commands", "--no-chrome", "--strict-mcp-config",
    "--permission-mode", "manual", "--settings", JSON.stringify({ disableAllHooks: true }),
    "--allowedTools", "mcp__modelbot__*", "--mcp-config", JSON.stringify({ mcpServers: {
      modelbot: { type: "http", url, headers: { Authorization: "Bearer ${MODELBOT_SCOPED_TOKEN}" } },
    } }), ...(resume ? ["--resume", resume] : [])];
}

/** Normalize only documented display/result events; never render raw diagnostics/tool input. */
export function claudeEvent(event: any): any {
  if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string")
    return { type: "thread.started", thread_id: event.session_id };
  if (event.type === "assistant" && !event.parent_tool_use_id) {
    const text = Array.isArray(event.message?.content) ? event.message.content
      .filter((part: any) => part.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n") : "";
    return { type: "item.completed", item: { type: "agent_message", text } };
  }
  if (event.type === "result") return event.is_error || event.subtype !== "success"
    ? { type: "turn.failed", error: { message: "Claude Code could not finish this turn. Check its native sign-in, model access, and usage limits; review any completed actions before retrying." } }
    : { type: "turn.completed" };
  return {};
}
import { delimiter, dirname } from "node:path";
