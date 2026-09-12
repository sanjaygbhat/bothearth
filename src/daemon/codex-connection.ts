import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { modelbotHome } from "../cli/paths.ts";
import { claudeEnvironment } from "./claude-code.ts";
import { logError } from "./log.ts";
import { toolPath } from "./resolve-tool.ts";

export interface CodexLoginOptions {
  codexHome: string; provider?: "codex" | "claude"; binary?: string; timeoutMs?: number;
  loginMode?: "browser" | "device" | "terminal";
  /** Run the official CLI in the selected computer, including cancellation. */
  spawn?(args: string[]): Promise<{ child: ChildProcess; stop(): Promise<void> }>;
  /** Guest /home/agent EACCES: migrate ownership, then the probe retries once. */
  repairAgentHome?(): Promise<void>;
}
/** Uses the installed CLI's own authentication; never reads or returns its credentials. */
export function createCodexConnection(options: CodexLoginOptions & {
  model(): string; configured(): boolean; connected(model: string): boolean | void; authorized?(owner: string): boolean;
}) {
  let login: Promise<void> | undefined, child: ChildProcess | undefined;
  let generation = 0, message = "", closed = false;
  let terminalOutput = "";
  let loginOwner: string | undefined, device: { verification_uri: string; user_code: string; expires_at: string } | undefined;
  let lastKnown: "signed_in" | "signed_out" | "missing" | undefined;
  let lastProbeFail: unknown;
  const probes = new Set<ChildProcess>();
  const externalStops = new Map<ChildProcess, () => Promise<void>>();
  const provider = options.provider ?? "codex", label = provider === "claude" ? "Claude Code" : "Codex";
  const env = provider === "claude" ? claudeEnvironment(options.codexHome) : { HOME: homedir(), PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter), LANG: process.env.LANG,
    TMPDIR: process.env.TMPDIR, CODEX_HOME: options.codexHome };
  const loginMode = options.loginMode ?? "browser";
  const view = (status: string, audience?: string) => ({ status, provider, model: options.model(),
    login_mode: loginMode, ...(device && audience && audience === loginOwner ? { device_auth: device } : {}),
    ...(status === "signing_in" && options.spawn && loginMode === "terminal" && audience && audience === loginOwner
      ? { native_terminal: { output: terminalOutput, can_reply: true } } : {}),
    message: status === "unknown" ? HOLD_CHECK_MESSAGE
      : status === "connected" || status === "signed_in" ? ""
      : message || (status === "error" ? "The connection could not be checked. Choose Check again in a moment."
      : status === "missing" ? `Install ${label}, then check again.`
      : status === "signed_out" ? (loginMode === "terminal"
        ? "Sign in on this server using the installed Claude Code CLI, then check again."
        : `Sign in through ${label}. BotHearth never sees your password.`) : ""),
    install_url: provider === "claude" ? "https://code.claude.com/docs/en/overview" : "https://developers.openai.com/codex/cli/" });
  const kill = async (child: ChildProcess, signal: NodeJS.Signals) => {
    const stop = externalStops.get(child);
    if (stop) { await stop(); return; }
    if (!child.pid) return;
    try { process.platform === "win32" ? child.kill(signal) : process.kill(-child.pid, signal); } catch { /* Exited. */ }
  };
  const killInBackground = (owned: ChildProcess) => {
    void kill(owned, "SIGKILL").catch(() => { message = "Could not confirm sign-in stopped. Check the computer connection and cancel again."; });
  };
  async function launch(args: string[], settings: SpawnOptions): Promise<ChildProcess> {
    if (!options.spawn) return spawn(options.binary ?? toolPath(provider), args, { env, ...settings });
    const owned = await options.spawn(args);
    externalStops.set(owned.child, owned.stop);
    owned.child.once("close", () => externalStops.delete(owned.child));
    return owned.child;
  }
  async function probeOnce(): Promise<{ state: "signed_in" | "signed_out" | "missing" | "error" | "unknown"; transport: boolean }> {
    const result = (state: "signed_in" | "signed_out" | "missing" | "error" | "unknown", transport = false) => ({ state, transport });
    if (closed) return result("error");
    let check: ChildProcess;
    try {
      check = await launch(provider === "claude" ? ["auth", "status"] : ["login", "status"],
        { cwd: homedir(), stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32" });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return result("missing");
      if (probeBlocked(error instanceof Error ? error.message : String(error))) {
        message = HOLD_CHECK_MESSAGE;
        return result("unknown");
      }
      lastProbeFail = error;
      if (!message) message = probeFailureMessage(error);
      return result("error", probeTransportFailure(error instanceof Error ? `${err.code ?? ""} ${error.message}` : String(error)));
    }
    if (closed) { await kill(check, "SIGKILL"); return result("error"); }
    // Native status output is never an application response.
    check.stdout?.resume();
    let stderr = "";
    check.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (stderr.length > 4096) stderr = stderr.slice(-2048);
    });
    check.stderr?.resume();
    return new Promise((resolve) => {
      probes.add(check);
      let settled = false;
      const finish = (code: number | null, error?: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); probes.delete(check);
        if (error?.code === "ENOENT") { resolve(result("missing")); return; }
        if (error) {
          if (probeBlocked(`${stderr} ${error.message}`)) {
            message = HOLD_CHECK_MESSAGE;
            resolve(result("unknown"));
            return;
          }
          lastProbeFail = `${stderr} ${error.message}`;
          if (!message) message = probeFailureMessage(error);
          resolve(result("error", probeTransportFailure(`${stderr} ${error.message}`)));
          return;
        }
        if (probeBlocked(stderr, code)) {
          message = HOLD_CHECK_MESSAGE;
          resolve(result("unknown"));
          return;
        }
        if (agentHomePermission(stderr) || agentHomePermission(error)) {
          lastProbeFail = stderr || error;
          if (!message) message = probeFailureMessage(stderr || error || "error");
          resolve(result("error"));
          return;
        }
        if ((code !== 0 && code !== 1) || probeTransportFailure(stderr)) {
          lastProbeFail = stderr || "error";
          if (!message) message = probeFailureMessage(stderr || "error");
          resolve(result("error", code == null || probeTransportFailure(stderr)));
          return;
        }
        if (message === HOLD_CHECK_MESSAGE
          || message === "The connection could not be checked. Choose Check again in a moment."
          || message === "The bot’s computer is not running"
          || message === "Docker is not reachable") {
          message = "";
        }
        resolve(result(code === 0 ? "signed_in" : "signed_out"));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        if (!message) message = "The connection could not be checked. Choose Check again in a moment.";
        killInBackground(check); finish(null);
      }, 5000);
      check.once("error", (error: NodeJS.ErrnoException) => finish(null, error));
      check.once("close", (code) => finish(code));
      if (check.exitCode !== null || check.signalCode) setImmediate(() => finish(check.exitCode));
    });
  }
  async function probe(): Promise<{ state: "signed_in" | "signed_out" | "missing" | "error" | "unknown"; transport: boolean }> {
    lastProbeFail = undefined;
    const first = await probeOnce();
    if (first.state !== "error" || first.transport || !options.repairAgentHome || !agentHomePermission(lastProbeFail)) return first;
    try {
      await options.repairAgentHome();
    } catch (error) {
      logError("agent home repair failed", { error: String(error) });
      message = "The connection could not be checked. Choose Check again in a moment.";
      return { state: "error", transport: false };
    }
    lastProbeFail = undefined;
    return probeOnce();
  }
  async function status(audience?: string) {
    if (login) return view("signing_in", audience);
    let probed = await probe();
    // A newer explicit login owns status while an older probe finishes.
    if (login) return view("signing_in", audience);
    if (probed.state === "error" && probed.transport) {
      probed = await probe();
      if (login) return view("signing_in", audience);
    }
    const state = probed.state;
    const shown = state === "signed_in" && options.configured() ? "connected" : state;
    if (state === "signed_in" || state === "signed_out" || state === "missing") {
      lastKnown = state;
      return view(shown, audience);
    }
    if (state === "error" && probed.transport && lastKnown === "signed_in") {
      return { ...view(options.configured() ? "connected" : "signed_in", audience), stale: true };
    }
    return view(shown, audience);
  }
  async function connect(model = options.model(), owner?: string) {
    const attempt = generation;
    if (login) return view("signing_in");
    const { state } = await probe();
    if (closed || attempt !== generation || (owner && options.authorized?.(owner) === false)) return view("signed_out");
    if (state !== "signed_in") return view(state);
    if (options.connected(model) === false) { message = "The application is restarting. Try connecting again shortly."; return view("error"); }
    message = "";
    return view("connected");
  }
  async function signIn(model = options.model(), auth: "subscription" | "console" = "subscription", owner?: string) {
    const attempt = generation;
    const authorized = () => !owner || options.authorized?.(owner) !== false;
    if (login) return view("signing_in");
    const { state } = await probe();
    if (login) return view("signing_in");
    if (closed || attempt !== generation || !authorized()) return view("signed_out");
    if (state === "signed_in") return connect(model, owner);
    if (state === "missing" || state === "error" || state === "unknown") return view(state);
    if (loginMode === "terminal" && !options.spawn) return view("signed_out");
    const current = ++generation;
    loginOwner = owner; device = undefined; terminalOutput = "";
    message = loginMode === "device" ? "Requesting an official one-time code from Codex…"
      : loginMode === "terminal" ? `Follow ${label}’s sign-in instructions below. Replies go only to its sign-in process.`
        : `Complete sign-in in the browser window opened by ${label}.`;
    let temp: string | undefined;
    login = (async () => {
      let cwd = homedir();
      if (!options.spawn) {
        const root = join(modelbotHome(), "sign-in");
        await mkdir(root, { recursive: true, mode: 0o700 });
        cwd = temp = await mkdtemp(join(root, provider + "-"));
      }
      if (current !== generation || !authorized()) return;
      // Official login opens its own browser/callback. Raw output may contain auth URLs.
      child = await launch(provider === "claude" ? ["auth", "login", ...(auth === "console" ? ["--console"] : [])] : ["login", ...(loginMode === "device" ? ["--device-auth"] : [])], { cwd, stdio: loginMode === "device" ? ["ignore", "pipe", "pipe"] : "ignore", detached: process.platform !== "win32" });
      const owned = child;
      owned.stdin?.on("error", () => {});
      if (current !== generation || !authorized()) { await kill(owned, "SIGKILL"); return; }
      const loginDeadline = new Date(Date.now() + Math.min(options.timeoutMs ?? 600000, 600000)).toISOString();
      if (loginMode === "device") {
        let output = "";
        const collect = (chunk: Buffer) => {
          if (current !== generation) return;
          output += chunk.toString("utf8");
          if (output.length > 16384) { message = "Codex returned an unsupported sign-in response. Use its native device login on the server."; killInBackground(owned); return; }
          const challenge = parseDeviceChallenge(output);
          if (challenge && !device) { device = { ...challenge, expires_at: loginDeadline };
            message = "Open the official verification page and enter this one-time code only if you started this sign-in."; }
        };
        owned.stdout?.on("data", collect); owned.stderr?.on("data", collect);
      } else if (loginMode === "terminal" && options.spawn) {
        const collect = (chunk: Buffer) => {
          if (current !== generation) return;
          terminalOutput = (terminalOutput + chunk.toString("utf8"))
            .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replaceAll("\r", "").slice(-16384);
        };
        owned.stdout?.on("data", collect); owned.stderr?.on("data", collect);
      }
      const timer = setTimeout(() => { message = "Sign-in timed out. Try again when you are ready."; killInBackground(owned); }, options.timeoutMs ?? 10 * 60_000);
      try {
        await new Promise<void>((resolve, reject) => { owned.once("error", reject); owned.once("close", () => resolve()); });
      } finally { clearTimeout(timer); child = undefined; device = undefined; }
      if (current !== generation || !authorized()) return;
      const { state: finalState } = await probe();
      if (current !== generation || !authorized()) return;
      if (finalState === "signed_in") { message = options.connected(model) === false
        ? "Sign-in completed. Reconnect after the application restarts." : ""; }
      else if (!message.includes("timed out") && !message.includes("unsupported")) message = "Sign-in did not finish. Try again, and complete the browser step.";
    })().catch(() => { if (current === generation) message = `${label} sign-in could not start. Check its installation and try again.`; })
      .finally(async () => {
        login = undefined; loginOwner = undefined; device = undefined; terminalOutput = "";
        if (temp) await rm(temp, { recursive: true, force: true }).catch(() => {});
      });
    return view("signing_in", owner);
  }
  async function cancel(recheck = true) {
    generation++; device = undefined; loginOwner = undefined; terminalOutput = "";
    const pending = login, owned = child;
    const timer = owned ? setTimeout(() => { killInBackground(owned); }, 2000) : undefined;
    try {
      // A failing status probe cannot prevent cancellation of the sign-in.
      const results = await Promise.allSettled([
        ...[...probes].map(probeChild => kill(probeChild, "SIGKILL")),
        ...(owned ? [kill(owned, "SIGTERM")] : []),
      ]);
      const failed = results.find(result => result.status === "rejected");
      if (failed) throw failed.reason;
      await pending;
    }
    finally {
      // The CLI parent may exit before a same-group authentication helper.
      try { if (owned) await kill(owned, "SIGKILL"); }
      finally { if (timer) clearTimeout(timer); }
    }
    if (pending) message = "Sign-in cancelled. Your existing login has not been removed.";
    return recheck ? status() : view("signed_out");
  }
  function input(text: string, owner: string): boolean {
    if (!login || !child?.stdin || loginMode !== "terminal" || !options.spawn || owner !== loginOwner
      || !child.stdin.writable || options.authorized?.(owner) === false || text.length > 8192 || /[\r\n\0]/.test(text)) return false;
    // Auth replies are neither echoed nor stored in task history.
    child.stdin.write(text + "\n");
    return true;
  }
  return { status, connect, signIn, cancel, input, loginSession: () => loginOwner, close: () => { closed = true; return cancel(false); } };
}

const HOLD_CHECK_MESSAGE = "Can’t check while you have control";

function agentHomePermission(error: unknown): boolean {
  const err = error as (NodeJS.ErrnoException & { stderr?: string }) | undefined;
  const text = typeof error === "string" ? error
    : error instanceof Error ? `${err?.code ?? ""} ${error.message} ${err?.stderr ?? ""}`
    : error == null ? "" : String(error);
  if (!/\/home\/agent/i.test(text)) return false;
  return /EACCES|permission denied|cannot write/i.test(text);
}

function probeBlocked(text: string, code?: number | null): boolean {
  return /paused for private control/i.test(text) || code === 75;
}

function probeFailureMessage(error: unknown): string {
  const text = typeof error === "string" ? error
    : error instanceof Error ? `${(error as NodeJS.ErrnoException).code ?? ""} ${error.message}`
    : String(error);
  if (/paused for private control/i.test(text)) return HOLD_CHECK_MESSAGE;
  if (/cannot connect|daemon is not running|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|Is the docker daemon running/i.test(text)) {
    return "Docker is not reachable";
  }
  if (/is not running|no such container|no such object|cannot exec|OCI runtime exec failed|container is paused/i.test(text)) {
    return "The bot’s computer is not running";
  }
  return "The connection could not be checked. Choose Check again in a moment.";
}

function probeTransportFailure(text: string): boolean {
  if (!text) return false;
  const msg = probeFailureMessage(text);
  return msg === "Docker is not reachable" || msg === "The bot’s computer is not running";
}

/** Installed Codex CLI device prompt. Fail closed on other URLs or output formats. */
export function parseDeviceChallenge(output: string): { verification_uri: string; user_code: string } | undefined {
  if (output.length > 16384) return;
  const text = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replaceAll("\r", "");
  if (!/^\s*https:\/\/auth\.openai\.com\/codex\/device\s*$/m.test(text)) return;
  const code = /^\s*2\. Enter this one-time code[^\n]*\n\s*([A-Z0-9]{4,5}-[A-Z0-9]{4,5})[ \t]*(?:\n|$)/m.exec(text);
  return code ? { verification_uri: "https://auth.openai.com/codex/device", user_code: code[1]! } : undefined;
}
