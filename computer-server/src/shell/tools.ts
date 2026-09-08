import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { toolError } from "../../../src/protocol/errors.ts";
import type { ShellExecOutput, ToolResult } from "../../../src/types/contracts.ts";
import { ensureWorkspaceDirs, jailPath, workspaceRoot } from "../jail.ts";

// Portions derived from OpenBot agent-computer/src/shell.ts
// Copyright (c) 2026 CopilotKit, MIT License.

export const SHELL_STREAM_CAP = 32 * 1024;
const READ_CAP = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

const PATH_NAMES = ["PATH"] as const;
const LOCALE_NAMES = ["LANG", "LANGUAGE"] as const;
const TERMINAL_NAMES = ["TERM", "TERMINFO", "COLORTERM"] as const;
const PROXY_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "FTP_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "ftp_proxy",
] as const;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOCALE_CATEGORY = /^LC_[A-Za-z0-9_]+$/;
const SECRET_SHAPE =
  /(_SECRET|_TOKEN|_PASSWORD|API_KEY|_KEY_HEX|_CREDENTIALS|AUTH_SOCK|PRIVATE_KEY)$/i;
/** Names the suffix regex misses (former SCRUB_ENV). */
const SECRET_NAMES = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
]);

/** Hooks / preload / option vars never reach the child, even if named in COMPUTER_SHELL_ENV. */
const NEVER_PASSED = new Set([
  "BASH_ENV",
  "ENV",
  "BASH_XTRACEFD",
  "BASHOPTS",
  "SHELLOPTS",
  "CDPATH",
  "GLOBIGNORE",
  "IFS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "PS4",
]);

type StreamCollector = {
  add(chunk: unknown): void;
  readonly text: string;
  readonly dropped: boolean;
  readonly bytesHeld: number;
  readonly maxBytesHeld: number;
};

/** Trim while data arrives. `text` never exceeds 2× keepBytes after `add`. */
export function createStreamCollector(keepBytes: number): StreamCollector {
  let text = "";
  let dropped = false;
  let maxHeld = 0;
  const maxHeldCap = keepBytes * 2;
  return {
    add(chunk: unknown) {
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      const cur = Buffer.from(text, "utf8");
      let next: Buffer;
      if (cur.byteLength + piece.byteLength <= maxHeldCap) {
        next = Buffer.concat([cur, piece]);
      } else {
        dropped = true;
        const tail = piece.byteLength >= keepBytes ? piece.subarray(-keepBytes) : Buffer.concat([cur, piece]).subarray(-keepBytes);
        next = tail;
      }
      text = next.toString("utf8");
      if (next.byteLength > maxHeld) maxHeld = next.byteLength;
    },
    get text() {
      return text;
    },
    get dropped() {
      return dropped;
    },
    get bytesHeld() {
      return Buffer.byteLength(text, "utf8");
    },
    get maxBytesHeld() {
      return maxHeld;
    },
  };
}

/** Assigned only when MODELBOT_TEST_SHELL_HOOKS=1 (unit tests). Production stays null. */
export let lastCollectors: { stdout: StreamCollector; stderr: StreamCollector } | null = null;

function withoutUserinfo(raw: string): string {
  try {
    const url = new URL(raw.trim());
    if (url.username === "" && url.password === "") return raw;
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  } catch (e) {
    if (e instanceof TypeError) return raw;
    throw e;
  }
}

function secretShaped(name: string): boolean {
  return SECRET_NAMES.has(name) || SECRET_SHAPE.test(name);
}

function extraShellEnvNames(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const named = raw.split(",").map((name) => name.trim());
  for (const name of named) {
    if (name === "") continue;
    if (!ENV_NAME.test(name)) continue;
    if (NEVER_PASSED.has(name) || secretShaped(name)) {
      console.warn(
        JSON.stringify({
          type: "computer-shell-env-refused",
          name,
          reason: "never passed to the child",
        }),
      );
    }
  }
  return named.filter(
    (name) => ENV_NAME.test(name) && !NEVER_PASSED.has(name) && !secretShaped(name),
  );
}

export function environmentForCommand(
  source: NodeJS.ProcessEnv,
  workspaceDir: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  const copy = (name: string) => {
    if (NEVER_PASSED.has(name) || secretShaped(name)) return;
    const value = source[name];
    if (value !== undefined) env[name] = value;
  };
  const copyProxy = (name: string) => {
    const value = source[name];
    if (value !== undefined) env[name] = withoutUserinfo(value);
  };
  for (const name of PATH_NAMES) copy(name);
  for (const name of LOCALE_NAMES) copy(name);
  for (const name of Object.keys(source)) {
    if (LOCALE_CATEGORY.test(name)) copy(name);
  }
  for (const name of TERMINAL_NAMES) copy(name);
  for (const name of PROXY_NAMES) copyProxy(name);
  for (const name of extraShellEnvNames(source.COMPUTER_SHELL_ENV)) copy(name);
  env.HOME = workspaceDir;
  env.PWD = workspaceDir;
  if (env.DEBIAN_FRONTEND === undefined) env.DEBIAN_FRONTEND = "noninteractive";
  return env;
}

function capTail(s: string, n: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(s, "utf8") <= n) return { text: s, truncated: false };
  const kept = Buffer.from(s, "utf8").subarray(-n).toString("utf8");
  return { text: kept, truncated: true };
}

function killProcessGroup(child: ChildProcess): void {
  const { pid } = child;
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export async function shellExec(p: {
  command: string;
  cwd: string | null;
  timeout_ms: number | null;
}): Promise<ToolResult<ShellExecOutput>> {
  ensureWorkspaceDirs();
  const cwdRaw = p.cwd ?? workspaceRoot();
  const cwdJ = jailPath(cwdRaw);
  if (!("abs" in cwdJ)) return cwdJ as ToolResult<ShellExecOutput>;
  const timeout = p.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const workspace = workspaceRoot();

  return await new Promise((resolvePromise) => {
    const child = spawn("/bin/bash", ["-c", p.command], {
      cwd: cwdJ.abs,
      env: environmentForCommand(process.env, workspace),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const outBuffer = createStreamCollector(SHELL_STREAM_CAP);
    const errBuffer = createStreamCollector(SHELL_STREAM_CAP);
    if (process.env.MODELBOT_TEST_SHELL_HOOKS === "1") {
      lastCollectors = { stdout: outBuffer, stderr: errBuffer };
    } else {
      lastCollectors = null;
    }
    let settled = false;
    const timer = setTimeout(() => {
      killProcessGroup(child);
      if (!settled) {
        settled = true;
        resolvePromise(toolError("E_TIMEOUT", `shell_exec timed out after ${timeout}ms`));
      }
    }, timeout);

    child.stdout?.on("data", (d: Buffer) => {
      outBuffer.add(d);
    });
    child.stderr?.on("data", (d: Buffer) => {
      errBuffer.add(d);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolvePromise(toolError("E_IO", err.message));
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const so = capTail(outBuffer.text, SHELL_STREAM_CAP);
      const se = capTail(errBuffer.text, SHELL_STREAM_CAP);
      resolvePromise({
        ok: true,
        data: {
          exit_code: code ?? 1,
          stdout: so.text,
          stderr: se.text,
          stdout_truncated: so.truncated || outBuffer.dropped,
          stderr_truncated: se.truncated || errBuffer.dropped,
        },
      });
    });
  });
}

export function filesList(p: { path: string }): ToolResult {
  ensureWorkspaceDirs();
  const j = jailPath(p.path);
  if (!("abs" in j)) return j;
  try {
    const st = statSync(j.abs);
    if (!st.isDirectory()) {
      return { ok: true, data: { entries: [{ name: j.abs.split("/").pop(), type: "file", size: st.size }] } };
    }
    const entries = readdirSync(j.abs, { withFileTypes: true }).map((d) => ({
      name: d.name,
      type: d.isDirectory() ? "dir" : "file",
      size: d.isFile() ? statSync(join(j.abs, d.name)).size : undefined,
    }));
    return { ok: true, data: { entries } };
  } catch (e) {
    return toolError("E_IO", (e as Error).message);
  }
}

export function filesRead(p: {
  path: string;
  offset: number | null;
  limit: number | null;
}): ToolResult {
  ensureWorkspaceDirs();
  const j = jailPath(p.path);
  if (!("abs" in j)) return j;
  try {
    const fd = openSync(j.abs, constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw: Buffer;
    try {
      const size = fstatSync(fd).size;
      if (size > READ_CAP) {
        return toolError("E_LIMIT", `files_read exceeds ${READ_CAP} bytes`, {
          size,
        });
      }
      raw = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    let text = raw.toString("utf8");
    const lines = text.split("\n");
    const offset = p.offset ?? 0;
    const limit = p.limit ?? 4000;
    const slice = lines.slice(offset, offset + limit);
    return {
      ok: true,
      data: {
        content: slice.join("\n"),
        truncated: offset + limit < lines.length,
        bytes: raw.byteLength,
      },
    };
  } catch (e) {
    return toolError("E_IO", (e as Error).message);
  }
}

export function filesWrite(p: {
  path: string;
  content: string;
  mkdir: boolean | null;
}): ToolResult {
  ensureWorkspaceDirs();
  const j = jailPath(p.path);
  if (!("abs" in j)) return j;
  try {
    if (p.mkdir) mkdirSync(dirname(j.abs), { recursive: true });
    const fd = openSync(
      j.abs,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, p.content, "utf8");
      fstatSync(fd);
    } finally {
      closeSync(fd);
    }
    return { ok: true, data: { written: Buffer.byteLength(p.content, "utf8") } };
  } catch (e) {
    return toolError("E_IO", (e as Error).message);
  }
}

export function filesDelete(p: { path: string }): ToolResult {
  ensureWorkspaceDirs();
  const j = jailPath(p.path);
  if (!("abs" in j)) return j;
  try {
    rmSync(j.abs, { recursive: true, force: false });
    return { ok: true, data: { deleted: true } };
  } catch (e) {
    return toolError("E_IO", (e as Error).message);
  }
}
