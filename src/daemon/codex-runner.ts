import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeEnvironment, claudeTaskArgs, claudeEvent } from "./claude-code.ts";

export interface CodexRunnerConfig {
  provider?: "codex" | "claude";
  codexHome: string;
  model: string;
  binary?: string;
  runsRoot?: string;
}

/**
 * The one wall clock that may end a run, and it never fails the task: the
 * server turns this message into a `max_runtime` pause that a raised
 * `agent.max_runtime_sec` resumes. Nothing else here is time-limited.
 */
export const MAX_RUNTIME_STOP = "Task reached its maximum runtime";

export async function runCodexTask(config: CodexRunnerConfig, task: {
  id: string; computer_id: string; goal: string;
}, options: {
  url: string; token: string; signal: AbortSignal;
  /** Seconds of wall clock this run may take. 0 means no ceiling. */
  maxRuntimeSec: number;
  onMessage(text: string): void;
  threadId?: string;
  onThread?(id: string): void;
  messageGeneration?(): number;
  onWaitingForMessage?(waiting: boolean): void;
  hasMessages?(): boolean;
  takeMessages?(): string[];
  isWaiting(): boolean;
  waitGeneration(): number;
  isTerminal(): boolean;
}) {
  const root = config.runsRoot ?? join(homedir(), ".modelbot", "task-runs");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const provider = config.provider ?? "codex";
  const cwd = await mkdtemp(join(root, provider + "-"));
  const diagnostic = await open(join(cwd, "runner.log"), "a", 0o600);
  const runtimeMs = options.maxRuntimeSec > 0 ? options.maxRuntimeSec * 1000 : 0;
  let deadline = runtimeMs > 0 ? Date.now() + runtimeMs : Infinity;
  let threadId = options.threadId;
  let messageTurn = false;
  let prompt = `Perform this user task through the BotHearth MCP tools. Your task is ${task.id} on computer ${task.computer_id}; the server enforces this scope.
Use your native subagents for bounded independent reasoning when useful. Ask children for analysis only; keep browser actions in the parent to avoid conflicting navigation.
Do not use host files, coding tools, other MCP servers, or web search to perform the task. Never request or expose credentials through model tools.
If BotHearth requests human control or approval, stop browser actions and wait. If ending a turn while waiting, clearly state what is needed; this application resumes you after the operator responds.
If the task produces anything the user should keep — a list, a table, a report, a summary — save it with BotHearth write_file before finishing; it lands in /workspace/out and the user opens it from the task's results. CSV or TSV is a spreadsheet, Markdown is a document, JSON is structured data. Mention the file you saved in your summary.
When finished, call BotHearth done with a truthful success/fail/cancelled status and useful summary. Do not call done while human control or approval is pending. Exit without done is not successful completion.
User task:\n${task.goal}`;
  if (threadId) prompt = `Continue the existing BotHearth task ${task.id} on ${task.computer_id} after a runner restart. The scoped MCP connection has been renewed. Preserve prior findings and do not duplicate submissions. Check takeover_status before any computer action. If human control or approval is pending, explain what is needed and end your turn to wait. Otherwise observe the actual page and continue the original task. Call done only after verifying the outcome.`;
  try {
    do {
      if (options.signal.aborted) throw new Error("Task cancelled");
      const waitGeneration = options.waitGeneration();
      const waitingAtStart = options.isWaiting();
      const messageGeneration = options.messageGeneration?.() ?? 0;
      const args = provider === "claude" ? claudeTaskArgs(config.model, options.url, threadId) : ["exec", "--json", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--color", "never",
        "-m", config.model, "-s", "read-only",
        "-c", "approval_policy=\"never\"", "-c", "features.shell_tool=false",
        "-c", "features.multi_agent=true", "-c", "web_search=\"disabled\"",
        "-c", `mcp_servers.modelbot.url=${JSON.stringify(options.url)}`,
        "-c", "mcp_servers.modelbot.bearer_token_env_var=\"MODELBOT_SCOPED_TOKEN\"",
        "-c", "mcp_servers.modelbot.default_tools_approval_mode=\"approve\"",
        ...(threadId ? ["resume", threadId, "-"] : ["-"])];
      const env: NodeJS.ProcessEnv = provider === "claude" ? { ...claudeEnvironment(config.codexHome), MODELBOT_SCOPED_TOKEN: options.token } : {
        PATH: process.env.PATH, HOME: homedir(), TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG, CODEX_HOME: config.codexHome, MODELBOT_SCOPED_TOKEN: options.token,
      };
      const child = spawn(config.binary ?? provider, args, { cwd, env, detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", diagnostic.fd] });
      let buffer = "", failure = "", ended = false;
      let forceKill: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try { process.platform === "win32" ? child.kill(signal) : process.kill(-child.pid, signal); } catch { /* Already exited. */ }
      };
      const stop = () => {
        kill("SIGTERM");
        forceKill ??= setTimeout(() => kill("SIGKILL"), 2000);
      };
      const timeout = Number.isFinite(deadline)
        ? setTimeout(() => { failure = MAX_RUNTIME_STOP; stop(); }, Math.max(1, deadline - Date.now()))
        : undefined;
      options.signal.addEventListener("abort", stop, { once: true });
      child.stdin!.on("error", () => {});
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 16 * 1024 * 1024) { failure = "Task runner output exceeded its limit"; stop(); return; }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            let event = JSON.parse(line);
            if (provider === "claude") event = claudeEvent(event);
            if (event.type === "thread.started" && typeof event.thread_id === "string") {
              threadId = event.thread_id;
              options.onThread?.(threadId!);
            }
            if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string")
              options.onMessage(event.item.text.slice(0, 16000));
            if (event.type === "turn.failed" || event.type === "error") failure = String(event.error?.message ?? event.message ?? "Codex task failed").slice(0, 1000);
            if (event.type === "turn.completed") ended = true;
          } catch { /* Ignore non-event diagnostics; never render raw output. */ }
        }
      });
      let exitCode: number | null;
      try {
        child.stdin!.end(prompt);
        if (options.signal.aborted) stop();
        exitCode = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject); child.once("close", resolve);
        });
      } finally {
        if (timeout) clearTimeout(timeout);
        options.signal.removeEventListener("abort", stop);
        // Cancelled descendants must not survive their parent exiting first.
        kill("SIGKILL");
        if (forceKill) clearTimeout(forceKill);
      }
      if (options.signal.aborted) throw new Error("Task cancelled");
      if (failure || exitCode !== 0 || !ended) throw new Error(failure || `${provider} task exited without a completed turn (exit ${exitCode})`);
      if (options.isTerminal()) return;
      const answeredMessage = messageTurn || (options.messageGeneration?.() ?? 0) !== messageGeneration;
      const awaitMessage = answeredMessage && !waitingAtStart && !options.isWaiting();
      if ((!answeredMessage && !waitingAtStart && !options.isWaiting() && !options.hasMessages?.() && options.waitGeneration() === waitGeneration) || !threadId)
        throw new Error(`${provider === "codex" ? "Codex" : "Claude Code"} ended without marking the task done`);
      // Waiting for a person has no cap of its own: the takeover/approval TTL
      // (independent of this deadline) is what decides when to stop waiting.
      // Push the deadline out by however long that took, so the resumed turn
      // still gets its full runtime instead of one already spent by the wait.
      const waitStarted = Date.now();
      if (awaitMessage) options.onWaitingForMessage?.(true);
      while ((awaitMessage || options.isWaiting()) && !options.hasMessages?.()) {
        if (options.signal.aborted) throw new Error("Task cancelled");
        await new Promise<void>((resolve) => {
          const wake = () => { clearTimeout(timer); options.signal.removeEventListener("abort", wake); resolve(); };
          const timer = setTimeout(wake, 250); options.signal.addEventListener("abort", wake, { once: true });
        });
      }
      if (awaitMessage) options.onWaitingForMessage?.(false);
      deadline += Date.now() - waitStarted;
      const messages = options.takeMessages?.() ?? [];
      messageTurn = messages.length > 0;
      if (messages.length) {
        prompt = "New messages from the operator: " + JSON.stringify(messages) +
          (options.isWaiting() ? "\nHuman control or approval is STILL pending. Reply to the operator in text. Do not access the computer, call done, or treat this message as approval. End your turn after replying if you remain blocked."
            : "\nRespond and continue the task using this direction. Verify the outcome before calling done.");
        continue;
      }
      prompt = "The operator has resolved the pending control or approval request. Call BotHearth takeover_status, then browser_snapshot, and work from what the page actually shows: a step the task names — 2-step verification, a consent screen — may already be done or may never appear. Never wait for a screen the page does not show, and do not ask for control again for a reason the page no longer supports. Continue the original task and finish with BotHearth done only after verifying the outcome.";
    } while (!options.isTerminal());
  } finally { await diagnostic.close(); }
}
