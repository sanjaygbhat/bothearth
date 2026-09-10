/**
 * workspace/downloads must never land world-writable.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

const PATHS = ["", WORKSPACE_DOWNLOADS, "out"];

function fakeFs(opts: {
  chownUid: boolean;
  chownGid: boolean;
  chmodOk: boolean;
  mkdirMode?: number;
  inheritedGid?: number;
  allowedGids?: number[];
}): WorkspacePermFs {
  const files = new Map<string, WorkspacePermStat>();
  const hostUid = 501;
  const hostGid = opts.inheritedGid ?? 20;
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
      // Darwin removes setgid without returning EPERM for a nonmember group.
      if (opts.allowedGids && !opts.allowedGids.includes(cur.gid)) mode &= ~0o2000;
      files.set(path, { ...cur, mode });
    },
    chownSync(path, uid, gid) {
      const cur = files.get(path);
      if (!cur) throw new Error("ENOENT");
      if (uid !== -1 && !opts.chownUid) throw new Error("EPERM");
      if (!opts.chownGid) throw new Error("EPERM");
      if (opts.allowedGids && !opts.allowedGids.includes(gid)) throw new Error("EPERM");
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
    lstatSync(path) { return this.statSync(path); },
  };
}

describe("workspace perms", () => {
  it("browser ownership still permits the distinct shell UID through the shared group", () => {
    const fs = fakeFs({ chownUid: true, chownGid: true, chmodOk: true });
    ensureWorkspaceBrowserWritable("/ws", { fs });
    for (const path of ["/ws", "/ws/downloads", "/ws/out"]) {
      const st = fs.statSync(path);
      assert.equal(st.uid, BROWSER_UID);
      assert.equal(uidCanWrite(st, 1002, st.gid), true);
      assert.equal(st.mode & 0o070, 0o070, "shell group can traverse and create files");
      assert.equal(st.mode & 0o007, 0);
      assert.equal(st.mode & 0o2000, 0o2000, "new children must inherit the shared group");
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
      assert.equal(statSync(p).mode & 0o2000, 0o2000, p);
    }
    assert.equal(existsSync(join(dir, ".quarantine")), false);
  });

  it("shares only workspace directories and refuses links into a private profile", () => {
    const root = mkdtempSync(join(tmpdir(), "mb-ws-private-"));
    const workspace = join(root, "workspace"), profile = join(root, "profile");
    mkdirSync(workspace, { mode: 0o700 });
    mkdirSync(profile, { mode: 0o700 });
    writeFileSync(join(profile, "credentials"), "synthetic", { mode: 0o600 });
    try {
      ensureWorkspaceBrowserWritable(workspace);
      assert.equal(statSync(profile).mode & 0o7777, 0o700);
      assert.equal(statSync(join(profile, "credentials")).mode & 0o777, 0o600);
      rmSync(join(workspace, "out"), { recursive: true });
      symlinkSync(profile, join(workspace, "out"));
      assert.throws(() => ensureWorkspaceBrowserWritable(workspace), /E_WORKSPACE_PERM/);
      assert.equal(statSync(profile).mode & 0o7777, 0o700, "permission repair followed out's symlink");
    } finally { chmodSync(workspace, 0o700); rmSync(root, { recursive: true, force: true }); }
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
      hostUid: 501,
      hostGid: 20,
      hostGroups: [20, BROWSER_GID],
    });
    const st = fs.statSync("/ws/downloads");
    assert.equal(st.gid, BROWSER_GID);
    assert.equal(st.mode & 0o777, 0o770);
    assert.equal(st.mode & 0o007, 0);
  });

  it("replaces an inherited nonmember GID with the host primary group so setgid sticks", () => {
    const fs = fakeFs({ chownUid: false, chownGid: true, chmodOk: true, inheritedGid: 0, allowedGids: [20, 80] });
    ensureWorkspaceBrowserWritable("/ws", { fs, hostUid: 501, hostGid: 20, hostGroups: [20, 80] });
    for (const rel of PATHS) {
      const st = fs.statSync(rel ? join("/ws", rel) : "/ws");
      assert.equal(st.uid, 501, "host ownership is retained");
      assert.equal(st.gid, 20, "workspace and output directories share the accessible group");
      assert.equal(st.mode & 0o7777, 0o2770);
      assert.equal(uidCanWrite(st, BROWSER_UID, st.gid), true);
      assert.equal(uidCanWrite(st, 1002, st.gid), true);
    }
  });

  it("uses an accessible supplementary group if the primary group cannot be assigned", () => {
    const fs = fakeFs({ chownUid: false, chownGid: true, chmodOk: true, inheritedGid: 0, allowedGids: [80] });
    ensureWorkspaceBrowserWritable("/ws", { fs, hostUid: 501, hostGid: 20, hostGroups: [20, 80] });
    for (const rel of PATHS) {
      const st = fs.statSync(rel ? join("/ws", rel) : "/ws");
      assert.equal(st.gid, 80);
      assert.equal(st.mode & 0o7777, 0o2770);
    }
  });

  it("preserves an inherited host-member group and fails closed when none can retain setgid", () => {
    const member = fakeFs({ chownUid: false, chownGid: true, chmodOk: true, inheritedGid: 80, allowedGids: [20, 80] });
    ensureWorkspaceBrowserWritable("/ws", { fs: member, hostUid: 501, hostGid: 20, hostGroups: [20, 80] });
    assert.equal(member.statSync("/ws").gid, 80);
    const denied = fakeFs({ chownUid: false, chownGid: false, chmodOk: true, inheritedGid: 0, allowedGids: [20] });
    assert.throws(() => ensureWorkspaceBrowserWritable("/ws", { fs: denied, hostUid: 501, hostGid: 20, hostGroups: [20] }), /E_WORKSPACE_PERM/);
    assert.equal(denied.statSync("/ws").mode & 0o007, 0);
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
