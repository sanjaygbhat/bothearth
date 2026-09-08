import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeEnvironment } from "./claude-code.ts";
import { toolPath } from "./resolve-tool.ts";

export interface CodexLoginOptions { codexHome: string; provider?: "codex" | "claude"; binary?: string; timeoutMs?: number; loginMode?: "browser" | "device" | "terminal" }
/** Uses the installed CLI's own authentication; never reads or returns its credentials. */
export function createCodexConnection(options: CodexLoginOptions & {
  model(): string; configured(): boolean; connected(model: string): boolean | void; authorized?(owner: string): boolean;
}) {
  let login: Promise<void> | undefined, child: ChildProcess | undefined;
  let generation = 0, message = "", closed = false;
  let loginOwner: string | undefined, device: { verification_uri: string; user_code: string; expires_at: string } | undefined;
  const probes = new Set<ChildProcess>();
  const provider = options.provider ?? "codex", label = provider === "claude" ? "Claude Code" : "Codex";
  const env = provider === "claude" ? claudeEnvironment(options.codexHome) : { HOME: homedir(), PATH: process.env.PATH, LANG: process.env.LANG,
    TMPDIR: process.env.TMPDIR, CODEX_HOME: options.codexHome };
  const loginMode = options.loginMode ?? "browser";
  const view = (status: string, audience?: string) => ({ status, provider, model: options.model(),
    login_mode: loginMode, ...(device && audience && audience === loginOwner ? { device_auth: device } : {}),
    message: message || (loginMode === "terminal" && status === "signed_out" ? "Sign in on this server using the installed Claude Code CLI, then check again. ModelBot does not collect browser codes or provider tokens." : ""), install_url: provider === "claude" ? "https://code.claude.com/docs/en/overview" : "https://developers.openai.com/codex/cli/" });
  const kill = (process: ChildProcess, signal: NodeJS.Signals) => {
    if (!process.pid) return;
    try { globalThis.process.platform === "win32" ? process.kill(signal) : globalThis.process.kill(-process.pid, signal); } catch { /* Exited. */ }
  };
  async function probe(): Promise<"signed_in" | "signed_out" | "missing" | "error"> {
    if (closed) return "error";
    return new Promise((resolve) => {
      const check = spawn(options.binary ?? toolPath(provider), provider === "claude" ? ["auth", "status"] : ["login", "status"], { env, cwd: homedir(), stdio: "ignore", detached: process.platform !== "win32" });
      probes.add(check);
      const timer = setTimeout(() => { kill(check, "SIGKILL"); resolve("error"); }, 5000);
      check.once("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); probes.delete(check); resolve(error.code === "ENOENT" ? "missing" : "error"); });
      check.once("close", (code) => { clearTimeout(timer); probes.delete(check); resolve(code === 0 ? "signed_in" : code === 1 ? "signed_out" : "error"); });
    });
  }
  async function status(audience?: string) {
    if (login) return view("signing_in", audience);
    const state = await probe();
    // A newer explicit login owns status while an older probe finishes.
    if (login) return view("signing_in", audience);
    return view(state === "signed_in" && options.configured() ? "connected" : state, audience);
  }
  async function connect(model = options.model(), owner?: string) {
    const attempt = generation;
    if (login) return view("signing_in");
    const state = await probe();
    if (closed || attempt !== generation || (owner && options.authorized?.(owner) === false)) return view("signed_out");
    if (state !== "signed_in") return view(state);
    if (options.connected(model) === false) { message = "Finish or stop your current tasks before changing the AI connection."; return view("error"); }
    message = "";
    return view("connected");
  }
  async function signIn(model = options.model(), auth: "subscription" | "console" = "subscription", owner?: string) {
    const attempt = generation;
    const authorized = () => !owner || options.authorized?.(owner) !== false;
    if (login) return view("signing_in");
    const state = await probe();
    if (login) return view("signing_in");
    if (closed || attempt !== generation || !authorized()) return view("signed_out");
    if (state === "signed_in") return connect(model, owner);
    if (state === "missing" || state === "error") return view(state);
    if (loginMode === "terminal") return view("signed_out");
    const current = ++generation;
    loginOwner = owner; device = undefined;
    message = loginMode === "device" ? "Requesting an official one-time code from Codex…" : `Complete sign-in in the browser window opened by ${label}.`;
    login = (async () => {
      const root = join(homedir(), ".modelbot", "sign-in");
      await mkdir(root, { recursive: true, mode: 0o700 });
      const cwd = await mkdtemp(join(root, provider + "-"));
      if (current !== generation || !authorized()) return;
      // Official login opens its own browser/callback. Raw output may contain auth URLs.
      child = spawn(options.binary ?? toolPath(provider), provider === "claude" ? ["auth", "login", ...(auth === "console" ? ["--console"] : [])] : ["login", ...(loginMode === "device" ? ["--device-auth"] : [])], { env, cwd, stdio: loginMode === "device" ? ["ignore", "pipe", "pipe"] : "ignore", detached: process.platform !== "win32" });
      const owned = child;
      const loginDeadline = new Date(Date.now() + Math.min(options.timeoutMs ?? 600000, 600000)).toISOString();
      if (loginMode === "device") {
        let output = "";
        const collect = (chunk: Buffer) => {
          if (current !== generation) return;
          output += chunk.toString("utf8");
          if (output.length > 16384) { message = "Codex returned an unsupported sign-in response. Use its native device login on the server."; kill(owned, "SIGKILL"); return; }
          const challenge = parseDeviceChallenge(output);
          if (challenge && !device) { device = { ...challenge, expires_at: loginDeadline };
            message = "Open the official verification page and enter this one-time code only if you started this sign-in."; }
        };
        owned.stdout?.on("data", collect); owned.stderr?.on("data", collect);
      }
      const timer = setTimeout(() => { message = "Sign-in timed out. Try again when you are ready."; kill(owned, "SIGKILL"); }, options.timeoutMs ?? 10 * 60_000);
      try {
        await new Promise<void>((resolve, reject) => { owned.once("error", reject); owned.once("close", () => resolve()); });
      } finally { clearTimeout(timer); child = undefined; device = undefined; }
      const finalState = await probe();
      if (current !== generation || !authorized()) return;
      if (finalState === "signed_in") { message = options.connected(model) === false
        ? "Sign-in completed. Finish or stop your current tasks before connecting." : ""; }
      else if (!message.includes("timed out") && !message.includes("unsupported")) message = "Sign-in did not finish. Try again, and complete the browser step.";
    })().catch(() => { if (current === generation) message = `${label} sign-in could not start. Check its installation and try again.`; })
      .finally(() => { login = undefined; loginOwner = undefined; device = undefined; });
    return view("signing_in", owner);
  }
  async function cancel(recheck = true) {
    generation++; device = undefined; loginOwner = undefined;
    for (const probeChild of probes) kill(probeChild, "SIGKILL");
    const pending = login, owned = child;
    if (owned) kill(owned, "SIGTERM");
    const timer = owned ? setTimeout(() => kill(owned, "SIGKILL"), 2000) : undefined;
    try { await pending; }
    finally {
      // The CLI parent may exit before a same-group authentication helper.
      if (owned) kill(owned, "SIGKILL");
      if (timer) clearTimeout(timer);
    }
    if (pending) message = "Sign-in cancelled. Your existing login has not been removed.";
    return recheck ? status() : view("signed_out");
  }
  return { status, connect, signIn, cancel, loginSession: () => loginOwner, close: () => { closed = true; return cancel(false); } };
}

/** Installed Codex CLI device prompt. Fail closed on other URLs or output formats. */
export function parseDeviceChallenge(output: string): { verification_uri: string; user_code: string } | undefined {
  if (output.length > 16384) return;
  const text = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replaceAll("\r", "");
  if (!/^\s*https:\/\/auth\.openai\.com\/codex\/device\s*$/m.test(text)) return;
  const code = /^\s*2\. Enter this one-time code[^\n]*\n\s*([A-Z0-9]{4,5}-[A-Z0-9]{4,5})[ \t]*(?:\n|$)/m.exec(text);
  return code ? { verification_uri: "https://auth.openai.com/codex/device", user_code: code[1]! } : undefined;
}
