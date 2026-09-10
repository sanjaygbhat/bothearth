import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import { Desktop } from "../../../computer-server/src/browser/desktop.ts";

test("operator desktop children create shared files without changing the browser's private umask", async () => {
  const root = mkdtempSync(join(tmpdir(), "mb-desktop-perms-"));
  const workspace = join(root, "workspace"), privateHome = join(root, "private");
  mkdirSync(workspace); chmodSync(workspace, 0o2770);
  mkdirSync(privateHome, { mode: 0o700 });
  const desktop = new Desktop(privateHome), previous = process.umask(0o077);
  const directory = join(workspace, "operator's $(literal) notes");
  try {
    // Exercise the desktop child launcher with Node; no display or browser starts.
    const child = Reflect.get(desktop, "launch").call(desktop, process.execPath, ["-e",
      'const fs=require("node:fs"),path=require("node:path");fs.mkdirSync(process.argv[1]);fs.writeFileSync(path.join(process.argv[1],"notes.md"),"operator edit");', directory]) as ChildProcess;
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(code, 0);
    assert.equal(statSync(directory).mode & 0o777, 0o770);
    assert.equal(statSync(directory).gid, statSync(workspace).gid);
    assert.equal(statSync(join(directory, "notes.md")).mode & 0o777, 0o660);
    assert.equal(statSync(privateHome).mode & 0o777, 0o700);
    assert.equal(process.umask(), 0o077);
  } finally { process.umask(previous); desktop.close(); rmSync(root, { recursive: true, force: true }); }
});
