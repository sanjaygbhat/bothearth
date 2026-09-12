import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { modelbotHome } from "../cli/paths.ts";
import { claudeEnvironment, claudeTaskArgs, claudeEvent } from "./claude-code.ts";
import { classifyProviderLimit } from "./provider-limit.ts";
import { toolPath } from "./resolve-tool.ts";
import { startGuestNativeTask } from "./guest-native.ts";
import type { NativeTaskSettings } from "../types/contracts.ts";

export interface CodexRunnerConfig {
  provider?: "codex" | "claude";
  codexHome: string;
  model: string;
  binary?: string;
  runsRoot?: string;
  /** Host is an explicit compatibility path for pre-migration sessions only. */
  execution_location?: "computer" | "host";
}

type NativeTask = { id: string; computer_id: string; goal: string;
  reasoning_effort?: NativeTaskSettings["reasoning_effort"];
  execution_mode?: NativeTaskSettings["execution_mode"]; executor?: NativeTaskSettings["executor"] };
type StdioMcp = { command: string; args: string[] };

/** Codex MCP client default is 60s; match the daemon's 300s tool timeout. */
const MODELBOT_MCP_TOOL_TIMEOUT_SEC = 300;

function nativeToolName(item: { tool?: unknown; name?: unknown; type?: unknown }): string {
  return String(item.tool ?? item.name ?? item.type ?? "").split("__").pop() ?? "";
}

/** Last MCP/native tool result failed when Codex/Claude marks isError, failed, or E_TIMEOUT. */
function toolItemError(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const rec = item as Record<string, unknown>;
  const result = rec.result && typeof rec.result === "object" ? rec.result as Record<string, unknown> : undefined;
  const errObj = rec.error && typeof rec.error === "object" ? rec.error as { code?: unknown; message?: unknown } : undefined;
  const resultErr = result?.error && typeof result.error === "object" ? result.error as { code?: unknown; message?: unknown } : undefined;
  const timeout = errObj?.code === "E_TIMEOUT" || resultErr?.code === "E_TIMEOUT"
    || (typeof errObj?.message === "string" && errObj.message.includes("E_TIMEOUT"))
    || (typeof resultErr?.message === "string" && resultErr.message.includes("E_TIMEOUT"));
  const failed = rec.isError === true || rec.is_error === true
    || rec.status === "failed" || rec.status === "error"
    || rec.error != null
    || result?.isError === true || result?.is_error === true
    || timeout;
  if (!failed) return undefined;
  const message = typeof errObj?.message === "string" ? errObj.message
    : typeof resultErr?.message === "string" ? resultErr.message
      : timeout ? "E_TIMEOUT" : "tool error";
  return message.slice(0, 1000);
}

/** Stock native tools remain enabled inside the externally isolated computer. */
export function guestTaskArgs(provider: "codex" | "claude", model: string, task: Pick<NativeTask, "execution_mode" | "executor" | "reasoning_effort">, mcp: StdioMcp, threadId?: string): string[] {
  const orchestrator = task.execution_mode === "orchestrator";
  const nativeDelegation = orchestrator && (!task.executor || task.executor.adapter === provider);
  const executor = orchestrator && task.executor?.adapter === provider ? task.executor.model : model;
  if (provider === "claude") return ["--print", "--output-format", "stream-json", "--verbose", ...(model ? ["--model", model] : []),
    "--permission-mode", "bypassPermissions", "--settings", JSON.stringify({ fallbackModel: [], switchModelsOnFlag: false,
      env: { CLAUDE_CODE_SUBAGENT_MODEL: executor } }),
    ...(!nativeDelegation ? ["--disallowedTools", "Agent"] : []),
    "--mcp-config", JSON.stringify({ mcpServers: { modelbot: { type: "stdio", ...mcp } } }),
    ...(threadId ? ["--resume", threadId] : [])];
  return ["exec", "--json", "--skip-git-repo-check", "--color", "never", ...(model ? ["-m", model] : []),
    "-s", "danger-full-access", "-c", 'approval_policy="never"',
    "-c", `features.multi_agent=${nativeDelegation}`, "-c", `model_reasoning_effort=${JSON.stringify(task.reasoning_effort ?? "medium")}`,
    ...(nativeDelegation ? ["-c", `agents.default_subagent_model=${JSON.stringify(executor)}`, "-c", 'agents.default_subagent_reasoning_effort="medium"'] : []),
    "-c", `mcp_servers.modelbot.command=${JSON.stringify(mcp.command)}`,
    "-c", `mcp_servers.modelbot.args=${JSON.stringify(mcp.args)}`,
    "-c", "mcp_servers.modelbot.required=true", "-c", 'mcp_servers.modelbot.default_tools_approval_mode="approve"',
    "-c", `mcp_servers.modelbot.tool_timeout_sec=${MODELBOT_MCP_TOOL_TIMEOUT_SEC}`,
    ...(threadId ? ["resume", threadId, "-"] : ["-"])];
}

function executionInstruction(task: NativeTask, provider: "codex" | "claude", mcp?: StdioMcp): string {
  if (task.execution_mode !== "orchestrator") return "Execute this task directly in executor mode. Do not spawn or delegate to subagents.\n";
  if (!task.executor || task.executor.adapter === provider)
    return `Orchestration is enabled for this task. Use native subagents when useful, using the selected executor model ${task.executor?.model ?? "of this session"}.\n`;
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const executorArgs = mcp ? guestTaskArgs(task.executor.adapter, task.executor.model, { execution_mode: "executor" }, mcp) : [];
  return `Orchestration is enabled. The selected executor is ${task.executor.adapter} model ${task.executor.model}. Delegate only bounded work to that exact model through its stock CLI inside this computer; never substitute another model or account. Use this native command, supplying its task on stdin: ${[task.executor.adapter, ...executorArgs].map(quote).join(" ")}. Review its output yourself.\n`;
}

/**
 * The one wall clock that may end a run, and it never fails the task: the
 * server turns this message into a `max_runtime` pause that a raised
 * `agent.max_runtime_sec` resumes. Nothing else here is time-limited.
 */
export const MAX_RUNTIME_STOP = "Task reached its maximum runtime";

/** Native first-turn or restart-resume stdin. Wait/resume only; no when-to-ask. */
export function nativeTaskPrompt(
  task: { id: string; computer_id: string; goal: string },
  inComputer: boolean,
  threadId?: string,
): string {
  if (threadId) {
    return `Continue the existing BotHearth task ${task.id} on ${task.computer_id} after a runner restart. The scoped MCP connection has been renewed. Preserve prior findings and do not duplicate submissions. Check takeover_status before any computer action. If human control or approval is pending, end your turn to wait. Otherwise observe the actual page and continue the original task. Call done only after verifying the outcome.`;
  }
  return `${inComputer ? "You are running inside the user's separate BotHearth computer. Use your native tools, files, commands, skills and the scoped BotHearth browser/control tools to complete the task. Save useful results in /workspace/out so the operator can open them." : "Perform this user task through the BotHearth MCP tools. Do not use host files, coding tools, other MCP servers, or web search to perform the task."} Your task is ${task.id} on computer ${task.computer_id}; the server enforces the MCP scope.
Never ask for credentials in chat or expose them through model tools.
A stale ref (E_STALE_REF) means the page changed — take a new snapshot and continue. If human control or approval is pending, stop browser actions and wait; this application resumes you after the operator responds.
If the task produces anything the user should keep — a list, a table, a report, a summary — ${inComputer ? "save final text deliverables with BotHearth write_file so they appear in the task’s saved files; use /workspace/out for other native files" : "save it with BotHearth write_file"} before finishing. The user opens /workspace/out files from the task's results. Mention the file you saved in your summary.
Ending your turn keeps this conversation open for the operator's response. Use BotHearth done only when ready to close the task, with a truthful success/fail/cancelled status and useful summary. Do not call done while human control or approval is pending.
User task:\n${task.goal}`;
}

export const NATIVE_AFTER_HOLD_PROMPT = "The operator has resolved the pending control or approval request. Call BotHearth takeover_status, then browser_snapshot, and work from what the page actually shows. Continue the original task and finish with BotHearth done only after verifying the outcome.";

export async function runCodexTask(config: CodexRunnerConfig, task: NativeTask, options: {
  url: string; token: string; signal: AbortSignal;
  /** Seconds of wall clock this run may take. 0 means no ceiling. */
  maxRuntimeSec: number;
  onMessage(text: string): void;
  onActivity?(event: { type: string; name: string; status: "started" | "completed" }): void;
  threadId?: string;
  onThread?(id: string): void;
  onWaitingForMessage?(waiting: boolean): void;
  onTurnEnded?(info: { hadDone: boolean; lastToolError?: string }): void | Promise<void>;
  hasMessages?(): boolean;
  takeMessages?(): string[];
  isWaiting(): boolean;
  waitGeneration(): number;
  isTerminal(): boolean;
}) {
  const root = config.runsRoot ?? join(modelbotHome(), "task-runs");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const provider = config.provider ?? "codex";
  const inComputer = config.execution_location !== "host";
  const cwd = await mkdtemp(join(root, provider + "-"));
  const diagnostic = await open(join(cwd, "runner.log"), "a", 0o600);
  const runtimeMs = options.maxRuntimeSec > 0 ? options.maxRuntimeSec * 1000 : 0;
  let deadline = runtimeMs > 0 ? Date.now() + runtimeMs : Infinity;
  let threadId = options.threadId;
  let prompt = nativeTaskPrompt(task, inComputer, threadId);
  try {
    do {
      if (options.signal.aborted) throw new Error("Task cancelled");
      if (inComputer && options.isWaiting()) {
        const waitStarted = Date.now();
        while (options.isWaiting()) {
          if (options.signal.aborted) throw new Error("Task cancelled");
          if (options.isTerminal()) return;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        deadline += Date.now() - waitStarted;
      }
      const waitGeneration = options.waitGeneration();
      const waitingAtStart = options.isWaiting();
      let mcp: StdioMcp | undefined;
      let guest: Awaited<ReturnType<typeof startGuestNativeTask>> | undefined;
      try {
        guest = inComputer ? await startGuestNativeTask({ computerId: task.computer_id, provider, url: options.url, token: options.token, signal: options.signal,
          args(connection) { mcp = connection; return guestTaskArgs(provider, config.model, task, connection, threadId); } }) : undefined;
      } catch (error) {
        // A takeover can stop the pipe before native startup. Retry only this
        // untouched setup; the loop still waits for private control to return.
        if (inComputer && !threadId && options.waitGeneration() !== waitGeneration) continue;
        throw error;
      }
      const args = provider === "claude" ? claudeTaskArgs(config.model, options.url, threadId) : ["exec", "--json", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--color", "never",
        "-m", config.model, "-s", "read-only",
        "-c", "approval_policy=\"never\"", "-c", "features.shell_tool=false",
        "-c", "features.multi_agent=false", "-c", `model_reasoning_effort=${JSON.stringify(task.reasoning_effort ?? "medium")}`, "-c", "web_search=\"disabled\"",
        "-c", `mcp_servers.modelbot.url=${JSON.stringify(options.url)}`,
        "-c", "mcp_servers.modelbot.bearer_token_env_var=\"MODELBOT_SCOPED_TOKEN\"",
        "-c", "mcp_servers.modelbot.default_tools_approval_mode=\"approve\"",
        "-c", `mcp_servers.modelbot.tool_timeout_sec=${MODELBOT_MCP_TOOL_TIMEOUT_SEC}`,
        ...(threadId ? ["resume", threadId, "-"] : ["-"])];
      const env: NodeJS.ProcessEnv = provider === "claude" ? { ...claudeEnvironment(config.codexHome), MODELBOT_SCOPED_TOKEN: options.token } : {
        PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter), HOME: homedir(), TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG, CODEX_HOME: config.codexHome, MODELBOT_SCOPED_TOKEN: options.token,
      };
      const child = guest?.child ?? spawn(config.binary ?? toolPath(provider), args, { cwd, env, detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", diagnostic.fd] });
      let buffer = "", failure = "", ended = false, nativeOutput = false, hadDone = false;
      let lastToolError: string | undefined;
      const claudeTools = new Map<string, string>();
      let forceKill: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals) => {
        if (guest) { void guest.stop().catch(() => {}); return; }
        if (!child.pid) return;
        try { process.platform === "win32" ? child.kill(signal) : process.kill(-child.pid, signal); } catch { /* Already exited. */ }
      };
      const stop = () => {
        kill("SIGTERM");
        forceKill ??= setTimeout(() => kill("SIGKILL"), 2000);
      };
      let lastTick = Date.now();
      const timeout = Number.isFinite(deadline) ? (guest ? setInterval(() => {
        const now = Date.now();
        if (options.isWaiting()) deadline += now - lastTick;
        lastTick = now;
        if (now >= deadline) { failure = MAX_RUNTIME_STOP; stop(); }
      }, 100) : setTimeout(() => { failure = MAX_RUNTIME_STOP; stop(); }, Math.max(1, deadline - Date.now()))) : undefined;
      options.signal.addEventListener("abort", stop, { once: true });
      child.stdin!.on("error", () => {});
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        nativeOutput ||= chunk.length > 0;
        buffer += chunk;
        if (buffer.length > 16 * 1024 * 1024) { failure = "Task runner output exceeded its limit"; stop(); return; }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            let event = JSON.parse(line);
            if (provider === "claude" && event.type === "assistant") {
              for (const part of event.message?.content ?? []) if (part.type === "tool_use" && typeof part.name === "string") {
                const name = part.name.slice(0, 120);
                if (typeof part.id === "string") claudeTools.set(part.id, name);
                options.onActivity?.({ type: "tool_use", name, status: "started" });
              }
            } else if (provider === "claude" && event.type === "user") {
              for (const part of event.message?.content ?? []) if (part.type === "tool_result" && claudeTools.has(part.tool_use_id)) {
                const name = claudeTools.get(part.tool_use_id)!;
                options.onActivity?.({ type: "tool_use", name, status: "completed" });
                lastToolError = toolItemError(part);
                if (nativeToolName({ name }) === "done" && !lastToolError) hadDone = true;
                claudeTools.delete(part.tool_use_id);
              }
            } else if ((event.type === "item.started" || event.type === "item.completed") && event.item?.type !== "agent_message" && typeof event.item?.type === "string") {
              options.onActivity?.({ type: event.item.type, name: String(event.item.tool ?? event.item.type).slice(0, 120), status: event.type === "item.started" ? "started" : "completed" });
              if (event.type === "item.completed"
                && (event.item.type === "mcp_tool_call" || event.item.type === "command_execution")) {
                lastToolError = toolItemError(event.item);
                if (nativeToolName(event.item) === "done" && !lastToolError) hadDone = true;
              }
            }
            if (provider === "claude") event = claudeEvent(event);
            if (event.type === "thread.started" && typeof event.thread_id === "string") {
              threadId = event.thread_id;
              options.onThread?.(threadId!);
            }
            if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string" && event.item.text.trim())
              options.onMessage(event.item.text.slice(0, 16000));
            if (event.type === "turn.failed" || event.type === "error") failure = String(event.error?.message ?? event.message ?? "Codex task failed").slice(0, 1000);
            if (event.type === "turn.completed") ended = true;
          } catch { /* Ignore non-event diagnostics; never render raw output. */ }
        }
      });
      let exitCode: number | null;
      try {
        const input = executionInstruction(task, provider, mcp) + prompt;
        if (guest) guest.prompt(input); else child.stdin!.end(input);
        if (options.signal.aborted) stop();
        exitCode = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject); child.once("close", resolve);
        });
      } finally {
        if (timeout) clearTimeout(timeout);
        options.signal.removeEventListener("abort", stop);
        // Cancelled descendants must not survive their parent exiting first.
        if (guest) await guest.stop(); else kill("SIGKILL");
        if (forceKill) clearTimeout(forceKill);
      }
      if (options.signal.aborted) throw new Error("Task cancelled");
      // SIGSTOP preserves privacy but native initialization deadlines still
      // elapse. Never replay a session, output, tool or provider failure.
      if (guest && !threadId && !nativeOutput && !failure && options.waitGeneration() !== waitGeneration) continue;
      if (failure || exitCode !== 0 || !ended) {
        let text = failure;
        if (!classifyProviderLimit(text)) {
          const log = await readFile(join(cwd, "runner.log"), "utf8").catch(() => "");
          const slice = log.slice(-16_000);
          if (classifyProviderLimit(slice)) text = slice;
        }
        throw new Error(text || `${provider} task exited without a completed turn (exit ${exitCode})`);
      }
      if (options.isTerminal()) return;
      if (!threadId) throw new Error(`${provider} completed a turn without a session id`);
      if (!hadDone && lastToolError && !options.hasMessages?.()) {
        await options.onTurnEnded?.({ hadDone: false, lastToolError });
        if (!options.isWaiting()) return;
      }
      // Native turns own their tool loop. A clean reply leaves the conversation
      // open; only an actual control/approval resolution resumes it on its own.
      const controlResolved = !options.isWaiting() && (waitingAtStart || options.waitGeneration() !== waitGeneration);
      let awaitMessage = !controlResolved && !options.isWaiting() && !options.hasMessages?.();
      // Waiting for a person has no cap of its own: the takeover/approval TTL
      // (independent of this deadline) is what decides when to stop waiting.
      // Push the deadline out by however long that took, so the resumed turn
      // still gets its full runtime instead of one already spent by the wait.
      const waitStarted = Date.now();
      if (awaitMessage) options.onWaitingForMessage?.(true);
      while ((awaitMessage || options.isWaiting()) && (!options.hasMessages?.() || (inComputer && options.isWaiting()))) {
        if (options.signal.aborted) throw new Error("Task cancelled");
        if (awaitMessage && options.isWaiting()) {
          awaitMessage = false;
          options.onWaitingForMessage?.(false);
        }
        await new Promise<void>((resolve) => {
          const wake = () => { clearTimeout(timer); options.signal.removeEventListener("abort", wake); resolve(); };
          const timer = setTimeout(wake, 250); options.signal.addEventListener("abort", wake, { once: true });
        });
      }
      if (awaitMessage) options.onWaitingForMessage?.(false);
      deadline += Date.now() - waitStarted;
      const messages = options.takeMessages?.() ?? [];
      if (messages.length) {
        prompt = "New messages from the operator: " + JSON.stringify(messages) +
          (options.isWaiting() ? "\nHuman control or approval is STILL pending. Reply to the operator in text. Do not access the computer, call done, or treat this message as approval. End your turn after replying if you remain blocked."
            : "\nRespond and continue the task using this direction. Verify the outcome before calling done.");
        continue;
      }
      prompt = NATIVE_AFTER_HOLD_PROMPT;
    } while (!options.isTerminal());
  } finally { await diagnostic.close(); }
}
