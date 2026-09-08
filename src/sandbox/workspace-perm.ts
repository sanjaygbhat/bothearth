/**
 * Shared workspace directories for the browser and shell containers.
 * Dockerfile.computer runs Chromium as uid 1001; bind-mounts hide image chown.
 * Never world-writable: Docker Desktop/OrbStack remap host 0700 on macOS.
 */
import {
  chmodSync,
  chownSync,
  mkdirSync,
  statSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { BROWSER_GID, BROWSER_UID } from "./flags.ts";

export const WORKSPACE_DOWNLOADS = "downloads";

/** Owner+group only. World bits are never set. */
export const WORKSPACE_MODE_MAX = 0o770;
export const WORKSPACE_MODE_OWNER = 0o700;

export interface WorkspacePermStat {
  uid: number;
  gid: number;
  mode: number;
}

export interface WorkspacePermFs {
  mkdirSync(path: string, opts: { recursive: boolean; mode?: number }): void;
  chmodSync(path: string, mode: number): void;
  chownSync(path: string, uid: number, gid: number): void;
  statSync(path: string): WorkspacePermStat;
}

export interface EnsureWorkspacePermOpts {
  fs?: WorkspacePermFs;
  browserUid?: number;
  browserGid?: number;
  hostUid?: number;
}

function nodeFs(): WorkspacePermFs {
  return {
    mkdirSync: (path, opts) => mkdirSync(path, opts),
    chmodSync,
    chownSync,
    statSync: (path): WorkspacePermStat => {
      const st: Stats = statSync(path);
      return { uid: st.uid, gid: st.gid, mode: st.mode };
    },
  };
}

export function uidCanWrite(st: WorkspacePermStat, uid: number, gid: number): boolean {
  const mode = st.mode & 0o777;
  if (st.uid === uid && (mode & 0o200) !== 0) return true;
  if (st.gid === gid && (mode & 0o020) !== 0) return true;
  return (mode & 0o002) !== 0;
}

function permError(path: string): Error {
  return new Error(`E_WORKSPACE_PERM: cannot make writable: ${path}`);
}

function noWorld(mode: number): boolean {
  return (mode & 0o007) === 0;
}

function capMode(mode: number): number {
  return mode & WORKSPACE_MODE_MAX;
}

function chmodCapped(fs: WorkspacePermFs, path: string, mode: number): void {
  const capped = capMode(mode);
  if (!noWorld(capped)) throw permError(path);
  fs.chmodSync(path, capped);
}

function tryChown(
  fs: WorkspacePermFs,
  path: string,
  uid: number,
  gid: number,
): boolean {
  try {
    fs.chownSync(path, uid, gid);
    return true;
  } catch {
    return false;
  }
}

function makeWritableByBrowser(
  path: string,
  fs: WorkspacePermFs,
  browserUid: number,
  browserGid: number,
): number {
  try {
    fs.mkdirSync(path, { recursive: true, mode: WORKSPACE_MODE_OWNER });
  } catch {
    throw permError(path);
  }

  tryChown(fs, path, browserUid, browserGid);
  let st: WorkspacePermStat;
  try {
    st = fs.statSync(path);
  } catch {
    throw permError(path);
  }

  if (st.gid !== browserGid) {
    tryChown(fs, path, -1, browserGid);
    try {
      st = fs.statSync(path);
    } catch {
      throw permError(path);
    }
  }

  // Both containers receive this directory's actual GID as a supplementary
  // group. Keep host ownership when chown is unavailable; never grant world access.
  const want = WORKSPACE_MODE_MAX;

  try {
    chmodCapped(fs, path, want);
  } catch {
    try {
      st = fs.statSync(path);
    } catch {
      throw permError(path);
    }
    if (!noWorld(st.mode)) throw permError(path);
  }

  try {
    st = fs.statSync(path);
  } catch {
    throw permError(path);
  }
  if (!noWorld(st.mode) || (st.mode & 0o070) !== 0o070) throw permError(path);
  return st.gid;
}

/**
 * Create `<workspace>/downloads` for the shared container group. Never
 * world-writable. Fail closed with E_WORKSPACE_PERM.
 */
export function ensureWorkspaceBrowserWritable(
  workspaceHost: string,
  opts: EnsureWorkspacePermOpts = {},
): void {
  const fs = opts.fs ?? nodeFs();
  const browserUid = opts.browserUid ?? BROWSER_UID;
  const browserGid = opts.browserGid ?? BROWSER_GID;
  const workspaceGid = makeWritableByBrowser(workspaceHost, fs, browserUid, browserGid);
  const downloadsGid = makeWritableByBrowser(
    join(workspaceHost, WORKSPACE_DOWNLOADS),
    fs,
    browserUid,
    workspaceGid,
  );
  if (downloadsGid !== workspaceGid) throw permError(join(workspaceHost, WORKSPACE_DOWNLOADS));
}
