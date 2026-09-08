import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, normalize, resolve, sep } from "node:path";
import { toolError } from "../../src/protocol/errors.ts";
import type { ToolResult } from "../../src/types/contracts.ts";

export function workspaceRoot(): string {
  return process.env.MODELBOT_WORKSPACE ?? "/workspace";
}
export function profileDir(): string {
  return process.env.MODELBOT_PROFILE ?? "/home/browser/profile";
}
/** Browser-only tmpfs; the shell container does not mount this path. */
export function downloadsDir(): string {
  return process.env.MODELBOT_QUARANTINE ?? "/quarantine";
}

export function assertQuarantineMount(): void {
  const path = downloadsDir();
  try {
    if (statSync(path).isDirectory()) return;
  } catch {
    // Use the same stable startup error for absent and inaccessible mounts.
  }
  throw Object.assign(
    new Error(`E_QUARANTINE_MOUNT_MISSING: browser quarantine mount missing: ${path}`),
    { code: "E_IO" as const },
  );
}

export function ensureWorkspaceDirs(): void {
  mkdirSync(workspaceRoot(), { recursive: true });
}

/** realpath jail under /workspace; block symlink escape + profile paths. */
export function jailPath(userPath: string): { ok: true; abs: string } | ToolResult {
  if (!userPath || typeof userPath !== "string") {
    return toolError("E_POLICY", "path required");
  }
  const root = workspaceRoot();
  const joined = userPath.startsWith("/")
    ? normalize(userPath)
    : normalize(resolve(root, userPath));

  const profile = normalize(profileDir());
  if (
    joined === profile ||
    joined.startsWith(profile + sep) ||
    joined === "/home/browser" ||
    joined.startsWith("/home/browser" + sep)
  ) {
    return toolError("E_POLICY", "profile paths forbidden", { path: userPath });
  }

  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return toolError("E_IO", "workspace missing");
  }

  let existing = joined;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }

  try {
    const realExisting = realpathSync(existing);
    if (realExisting !== rootReal && !realExisting.startsWith(rootReal + sep)) {
      return toolError("E_POLICY", "symlink escape", { path: userPath });
    }
    const ws = normalize(root);
    let abs: string;
    if (joined === ws || joined.startsWith(ws + sep)) {
      const rel = joined === ws ? "" : joined.slice(ws.length + 1);
      abs = rel ? resolve(rootReal, rel) : rootReal;
    } else if (joined === rootReal || joined.startsWith(rootReal + sep)) {
      abs = joined;
    } else {
      return toolError("E_POLICY", "path escapes workspace", { path: userPath });
    }
    if (abs !== rootReal && !abs.startsWith(rootReal + sep)) {
      return toolError("E_POLICY", "path escapes workspace", { path: userPath });
    }
    if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) {
      const target = realpathSync(abs);
      if (target !== rootReal && !target.startsWith(rootReal + sep)) {
        return toolError("E_POLICY", "symlink escape", { path: userPath });
      }
      return { ok: true, abs: target };
    }
    return { ok: true, abs };
  } catch {
    return toolError("E_POLICY", "path jail failed", { path: userPath });
  }
}
