/**
 * Resolve external CLIs (`claude`, `codex`, `docker`, …) to an absolute path.
 *
 * A daemon launched from a `.app` inherits launchd's PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), not the user's login shell PATH, so a bare
 * `spawn("claude")` reports ENOENT for every Homebrew / nvm / volta install.
 *
 * SEARCH ORDER (first executable hit wins), highest priority first:
 *   1. `MODELBOT_TOOL_PATH` — the operator's explicit pin.
 *   2. System dirs: /opt/homebrew/bin, /usr/local/bin, /usr/bin, /bin,
 *      /Applications/Docker.app/Contents/Resources/bin.
 *   3. Remaining absolute `PATH` entries outside $HOME.
 *   4. User-writable dirs last (~/.local/bin, ~/.npm-global/bin, ~/.volta/bin,
 *      the newest ~/.nvm node, ~/.bun/bin, and any $HOME-rooted PATH entry).
 * A user-writable dir is reached only when nothing above it resolved, so a
 * dropper that plants `~/.local/bin/claude` cannot displace a real install.
 * Relative entries are dropped (they would resolve against the daemon's CWD),
 * and every candidate must be owned by this user or root and not be
 * group/world-writable — a refusal is logged with its reason.
 *
 * Never throws and never fails silently: an unresolved tool is logged once and
 * the bare name is returned so the caller's own ENOENT handling still runs.
 */

import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, sep } from "node:path";
import { logInfo } from "./log.ts";

type ToolSource = "override" | "system" | "path" | "well-known";

export interface ResolvedTool {
  name: string;
  /** Absolute path to the executable. */
  path: string;
  source: ToolSource;
}

export interface ResolveToolDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Executable test — injected by unit tests. */
  isExecutable?: (path: string) => boolean;
  /** Directory listing for the nvm version scan — injected by unit tests. */
  listDir?: (path: string) => string[];
  /** Owner + permission bits of a candidate — injected by unit tests. */
  statPath?: (path: string) => { uid: number; mode: number } | null;
  /** Effective uid — injected by unit tests. */
  uid?: number;
}

/**
 * Root-owned on a stock install, or (Homebrew) owned by the single admin user
 * who installed it. Ahead of PATH so a poisoned PATH entry cannot shadow a real
 * install, and ahead of every $HOME dir so a dropper cannot either.
 */
const SYSTEM_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/Applications/Docker.app/Contents/Resources/bin",
] as const;

function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultListDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function defaultStatPath(path: string): { uid: number; mode: number } | null {
  try {
    const s = statSync(path);
    return { uid: s.uid, mode: s.mode };
  } catch {
    return null;
  }
}

/** Descending semver-ish order; `v22.18.0` before `v22.9.1` before `v20.x`. */
export function newestNodeVersionDir(names: string[]): string | undefined {
  const parsed = names
    .map((name) => ({ name, parts: /^v?(\d+)\.(\d+)\.(\d+)/.exec(name) }))
    .filter((entry): entry is { name: string; parts: RegExpExecArray } => Boolean(entry.parts))
    .sort((a, b) => {
      for (let i = 1; i <= 3; i++) {
        const diff = Number(b.parts[i]) - Number(a.parts[i]);
        if (diff !== 0) return diff;
      }
      return b.name.localeCompare(a.name);
    });
  return parsed[0]?.name;
}

/**
 * Ordered search directories with the source that would be reported for a hit.
 * Exported so tests can assert the order without touching the filesystem.
 */
export function toolSearchDirs(deps: ResolveToolDeps = {}): Array<{ dir: string; source: ToolSource }> {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const listDir = deps.listDir ?? defaultListDir;
  const dirs: Array<{ dir: string; source: ToolSource }> = [];
  const last: Array<{ dir: string; source: ToolSource }> = [];
  const seen = new Set<string>();
  const homePrefix = home.replace(/\/+$/, "") + sep;
  const push = (raw: string, source: ToolSource) => {
    const dir = raw.trim();
    // A relative entry (`.`, `bin`) would resolve against the daemon's CWD —
    // the repo or the workspace root, both writable by whatever it just ran.
    if (!dir || !isAbsolute(dir) || seen.has(dir)) return;
    seen.add(dir);
    // Anything under $HOME is user-writable by definition: demote it, whatever
    // list it arrived on, so it is only reached when nothing else resolved.
    if (dir === home || dir.startsWith(homePrefix)) last.push({ dir, source: "well-known" });
    else dirs.push({ dir, source });
  };

  for (const dir of (env.MODELBOT_TOOL_PATH ?? "").split(delimiter)) push(dir, "override");
  for (const dir of SYSTEM_DIRS) push(dir, "system");
  for (const dir of (env.PATH ?? "").split(delimiter)) push(dir, "path");

  push(join(home, ".local", "bin"), "well-known");
  push(join(home, ".npm-global", "bin"), "well-known");
  push(join(home, ".volta", "bin"), "well-known");
  const nvmRoot = join(home, ".nvm", "versions", "node");
  const newest = newestNodeVersionDir(listDir(nvmRoot));
  if (newest) push(join(nvmRoot, newest, "bin"), "well-known");
  push(join(home, ".bun", "bin"), "well-known");
  return [...dirs, ...last];
}

/** Cache keyed by tool name; a cached hit is revalidated with one access() call. */
const cache = new Map<string, ResolvedTool>();
const missLogged = new Set<string>();
const refusalLogged = new Set<string>();

/**
 * Anyone who can write the binary chooses what the daemon executes. Refuse a
 * candidate this user does not own (and root does not own) or that group or
 * other can write, and say which it was — a silently skipped `docker` reads as
 * "Docker is not installed", which sends the owner hunting in the wrong place.
 */
function candidateIsTrusted(path: string, deps: ResolveToolDeps, quiet: boolean): boolean {
  const stat = (deps.statPath ?? defaultStatPath)(path);
  if (!stat) return false;
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const reason = stat.uid !== 0 && stat.uid !== uid
    ? "not owned by this user or root"
    : (stat.mode & 0o022) !== 0
      ? "writable by group or other"
      : null;
  if (!reason) return true;
  if (!quiet && !refusalLogged.has(path)) {
    refusalLogged.add(path);
    logInfo("tool candidate refused", { path, reason, mode: (stat.mode & 0o777).toString(8), uid: stat.uid });
  }
  return false;
}

/** Absolute path for `name`, or null when it is nowhere on this machine. */
export function resolveTool(name: string, deps: ResolveToolDeps = {}): ResolvedTool | null {
  const isExecutable = deps.isExecutable ?? defaultIsExecutable;
  const injected = Boolean(deps.env || deps.home || deps.isExecutable || deps.listDir || deps.statPath || deps.uid !== undefined);
  if (!injected) {
    const hit = cache.get(name);
    if (hit && isExecutable(hit.path)) return hit;
    if (hit) cache.delete(name);
  }
  for (const { dir, source } of toolSearchDirs(deps)) {
    const path = join(dir, name);
    if (!isExecutable(path)) continue;
    if (!candidateIsTrusted(path, deps, injected)) continue;
    const resolved: ResolvedTool = { name, path, source };
    if (!injected) {
      cache.set(name, resolved);
      missLogged.delete(name);
      logInfo("tool resolved", { tool: name, path, source });
    }
    return resolved;
  }
  if (!injected && !missLogged.has(name)) {
    missLogged.add(name);
    logInfo("tool not found", { tool: name, searched_dirs: toolSearchDirs(deps).length });
  }
  return null;
}

/**
 * Path to spawn for `name`. Falls back to the bare name so the caller still
 * gets its usual ENOENT rather than a silent no-op.
 */
export function toolPath(name: string, deps: ResolveToolDeps = {}): string {
  return resolveTool(name, deps)?.path ?? name;
}
