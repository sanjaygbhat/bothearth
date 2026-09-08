/**
 * `write_file` — the one way a task saves a deliverable for the human.
 *
 * Deliberately NOT part of `shell/tools.ts`: the `files_*` family is gated on the
 * `shell` capability and routed to the shell container, so a browser-only computer
 * (what the home-screen task box provisions) has no way to produce a file at all.
 * This tool runs in whichever role receives it — both containers bind-mount the
 * same host workspace — and is confined to `<workspace>/out`, one directory whose
 * entire purpose is "things the human asked for".
 *
 * Confinement, in order: refuse `..` textually, resolve the request lexically and
 * require it under `<workspace>/out`, realpath the nearest existing ancestor so a
 * symlinked intermediate directory cannot redirect the write, then open the final
 * component `O_NOFOLLOW` and confirm the descriptor is a regular file.
 */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { toolError } from "../../src/protocol/errors.ts";
import type { ToolResult } from "../../src/types/contracts.ts";
import { workspaceRoot } from "./jail.ts";

/** Sole directory `write_file` may touch, relative to the workspace root. */
const OUT_DIR = "out";

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

/** Per-file size ceiling. 10 MB covers any spreadsheet or document a task produces. */
export function maxBytes(): number {
  return envInt("MODELBOT_WRITE_FILE_MAX_BYTES", 10 * 1024 * 1024);
}

/**
 * Ceiling on files living in `out/`, not on files written per task: a per-task
 * counter resets every task and therefore bounds nothing, while this bounds the
 * directory the human actually browses and the disk it sits on.
 */
export function maxFiles(): number {
  return envInt("MODELBOT_WRITE_FILE_MAX_FILES", 200);
}

function outRoot(): string {
  return join(workspaceRoot(), OUT_DIR);
}

/** Count regular files under `dir`, stopping as soon as the cap is reached. */
function countFiles(dir: string, cap: number): number {
  let seen = 0;
  const stack = [dir];
  while (stack.length && seen < cap) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(join(current, entry.name));
      else if (++seen >= cap) break;
    }
  }
  return seen;
}

/** Nearest ancestor of `target` that exists on disk. */
function existingAncestor(target: string): string {
  let current = target;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function under(child: string, root: string): boolean {
  return child === root || child.startsWith(root + sep);
}

type WriteMode = "create" | "overwrite" | "append";
type WriteEncoding = "utf8" | "base64";

interface WriteFileParams {
  path: string;
  content: string;
  encoding?: WriteEncoding | null;
  mode?: WriteMode | null;
}

export function writeFile(p: WriteFileParams): ToolResult {
  const encoding = p.encoding ?? "utf8";
  const mode = p.mode ?? "overwrite";
  if (encoding !== "utf8" && encoding !== "base64") {
    return toolError("E_POLICY", "encoding must be utf8 or base64");
  }
  if (mode !== "create" && mode !== "overwrite" && mode !== "append") {
    return toolError("E_POLICY", "mode must be create, overwrite or append");
  }
  if (typeof p.path !== "string" || p.path === "" || p.path.includes("\0")) {
    return toolError("E_POLICY", "path required");
  }
  if (typeof p.content !== "string") {
    return toolError("E_POLICY", "content must be a string");
  }
  if (p.path.split(/[\\/]/).includes("..")) {
    return toolError("E_POLICY", "path must not contain '..'", { path: p.path });
  }

  // Buffer.from drops invalid base64 silently, so reject it before decoding
  // rather than writing a truncated file the model believes is complete.
  if (encoding === "base64" && !/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(p.content)) {
    return toolError("E_POLICY", "content is not valid base64");
  }
  const body = Buffer.from(p.content, encoding);
  const cap = maxBytes();
  if (body.byteLength > cap) {
    return toolError("E_LIMIT", `write_file exceeds ${cap} bytes`, {
      bytes: body.byteLength,
      max_bytes: cap,
    });
  }

  const root = workspaceRoot();
  const out = outRoot();
  // Absolute paths are honoured only inside out/; anything else is resolved there,
  // so a bare "invoices.csv" lands where the human expects instead of being refused.
  const requested = p.path.startsWith("/") ? normalize(p.path) : join(out, p.path);
  if (!under(requested, out) || requested === out) {
    return toolError("E_POLICY", `write_file is restricted to ${out}`, { path: p.path });
  }

  try {
    mkdirSync(out, { recursive: true, mode: 0o770 });
    const outReal = realpathSync(out);
    if (!under(outReal, realpathSync(root))) {
      return toolError("E_POLICY", "symlink escape", { path: p.path });
    }

    // A symlinked intermediate directory would otherwise redirect mkdir/open
    // outside out/; check before creating anything.
    const target = resolve(outReal, relative(out, requested));
    const anchorReal = realpathSync(existingAncestor(target));
    if (!under(anchorReal, outReal)) {
      return toolError("E_POLICY", "symlink escape", { path: p.path });
    }

    const existed = existsSync(target);
    if (existed && mode === "create") {
      return toolError("E_POLICY", "file exists; use mode overwrite or append", {
        path: p.path,
      });
    }
    if (!existed) {
      const files = maxFiles();
      if (countFiles(outReal, files) >= files) {
        return toolError("E_LIMIT", `write_file limit of ${files} files reached`, {
          max_files: files,
        });
      }
    }

    mkdirSync(dirname(target), { recursive: true, mode: 0o770 });
    const flags =
      constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      (mode === "append" ? constants.O_APPEND : constants.O_TRUNC);
    const fd = openSync(target, flags, 0o640);
    let size: number;
    try {
      const before = fstatSync(fd);
      if (!before.isFile()) {
        return toolError("E_POLICY", "not a regular file", { path: p.path });
      }
      if (before.size + body.byteLength > cap) {
        return toolError("E_LIMIT", `write_file exceeds ${cap} bytes`, {
          bytes: before.size + body.byteLength,
          max_bytes: cap,
        });
      }
      writeSync(fd, body);
      size = fstatSync(fd).size;
    } finally {
      closeSync(fd);
    }

    return {
      ok: true,
      data: {
        // Relative to the workspace root: the daemon serves results by this path
        // and it is meaningless to the human as a container-absolute path.
        path: relative(realpathSync(root), target),
        bytes: size,
        sha256: createHash("sha256").update(readFileSync(target)).digest("hex"),
      },
    };
  } catch (e) {
    return toolError("E_IO", (e as Error).message);
  }
}
