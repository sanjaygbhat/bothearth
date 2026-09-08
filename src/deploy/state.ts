/**
 * Local remote deployment state (~/.modelbot/remotes/<name>.json mode 0600).
 */

import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RemoteState } from "./types.ts";

export function remotesDir(home = homedir()): string {
  return join(home, ".modelbot", "remotes");
}

export function remoteStatePath(name: string, home = homedir()): string {
  return join(remotesDir(home), `${name}.json`);
}

export function loadRemoteState(
  name: string,
  home = homedir(),
): RemoteState | null {
  const path = remoteStatePath(name, home);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as RemoteState;
  return raw;
}

export function saveRemoteState(state: RemoteState, home = homedir()): string {
  const dir = remotesDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = remoteStatePath(state.name, home);
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore on platforms without chmod */
  }
  return path;
}

export function deleteRemoteState(name: string, home = homedir()): boolean {
  const path = remoteStatePath(name, home);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}
