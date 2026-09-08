/**
 * workspace/downloads must never land world-writable.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BROWSER_GID, BROWSER_UID } from "../../../src/sandbox/flags.ts";
import {
  WORKSPACE_DOWNLOADS,
  ensureWorkspaceBrowserWritable,
  uidCanWrite,
  type WorkspacePermFs,
  type WorkspacePermStat,
} from "../../../src/sandbox/workspace-perm.ts";

const PATHS = ["", WORKSPACE_DOWNLOADS];

function fakeFs(opts: {
  chownUid: boolean;
  chownGid: boolean;
  chmodOk: boolean;
  mkdirMode?: number;
}): WorkspacePermFs {
  const files = new Map<string, WorkspacePermStat>();
  const hostUid = 501;
  const hostGid = 20;
  return {
    mkdirSync(path, { mode }) {
      files.set(path, {
        uid: hostUid,
        gid: hostGid,
        mode: opts.mkdirMode ?? mode ?? 0o700,
      });
    },
    chmodSync(path, mode) {
      if ((mode & 0o007) !== 0) throw new Error(`world bits in chmod: ${mode.toString(8)}`);
      if (!opts.chmodOk) throw new Error("EPERM");
      const cur = files.get(path);
      if (!cur) throw new Error("ENOENT");
      files.set(path, { ...cur, mode });
    },
    chownSync(path, uid, gid) {
      const cur = files.get(path);
      if (!cur) throw new Error("ENOENT");
      if (uid !== -1 && !opts.chownUid) throw new Error("EPERM");
      if (!opts.chownGid) throw new Error("EPERM");
      files.set(path, {
        ...cur,
        uid: uid === -1 ? cur.uid : uid,
        gid,
      });
    },
    statSync(path) {
      const cur = files.get(path);
      if (!cur) throw new Error("ENOENT");
      return { ...cur };
    },
  };
}

describe("workspace perms", () => {
  it("browser ownership still permits the distinct shell UID through the shared group", () => {
    const fs = fakeFs({ chownUid: true, chownGid: true, chmodOk: true });
    ensureWorkspaceBrowserWritable("/ws", { fs });
    for (const path of ["/ws", "/ws/downloads"]) {
      const st = fs.statSync(path);
      assert.equal(st.uid, BROWSER_UID);
      assert.equal(uidCanWrite(st, 1002, st.gid), true);
      assert.equal(st.mode & 0o070, 0o070, "shell group can traverse and create files");
      assert.equal(st.mode & 0o007, 0);
    }
  });

  it("fails closed if group traversal cannot be enabled", () => {
    const fs = fakeFs({ chownUid: true, chownGid: true, chmodOk: false });
    assert.throws(() => ensureWorkspaceBrowserWritable("/ws", { fs }), /E_WORKSPACE_PERM/);
  });

  it("real-fs tmpdir has no world bits and no legacy .quarantine", () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-ws-perm-"));
    ensureWorkspaceBrowserWritable(dir);
    for (const rel of PATHS) {
      const p = rel ? join(dir, rel) : dir;
      assert.equal(statSync(p).mode & 0o007, 0, p);
    }
    assert.equal(existsSync(join(dir, ".quarantine")), false);
  });

  it("never chmod wider than 0770 when chown EPERM", () => {
    const fs = fakeFs({ chownUid: false, chownGid: false, chmodOk: true });
    ensureWorkspaceBrowserWritable("/ws", {
      fs,
      browserUid: BROWSER_UID,
      browserGid: BROWSER_GID,
    });
    for (const rel of PATHS) {
      const p = rel ? join("/ws", rel) : "/ws";
      const st = fs.statSync(p);
      assert.equal(st.mode & 0o007, 0, p);
      assert.ok((st.mode & 0o777) <= 0o770, p);
    }
  });

  it("group ownership uses 0770 not 0777", () => {
    const fs = fakeFs({ chownUid: false, chownGid: true, chmodOk: true });
    ensureWorkspaceBrowserWritable("/ws", {
      fs,
      browserUid: BROWSER_UID,
      browserGid: BROWSER_GID,
    });
    const st = fs.statSync("/ws/downloads");
    assert.equal(st.gid, BROWSER_GID);
    assert.equal(st.mode & 0o777, 0o770);
    assert.equal(st.mode & 0o007, 0);
  });

  it("throws E_WORKSPACE_PERM naming the path when world bits cannot be stripped", () => {
    const fs = fakeFs({
      chownUid: false,
      chownGid: false,
      chmodOk: false,
      mkdirMode: 0o777,
    });
    assert.throws(
      () =>
        ensureWorkspaceBrowserWritable("/ws", {
          fs,
          browserUid: BROWSER_UID,
          browserGid: BROWSER_GID,
        }),
      (err: Error) => {
        assert.match(err.message, /E_WORKSPACE_PERM/);
        assert.match(err.message, /\/ws/);
        return true;
      },
    );
  });
});
