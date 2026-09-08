/**
 * Docker-int: `write_file` inside the real computer image reaches the host.
 *
 * This is the whole point of the tool, and it is the one thing unit tests cannot
 * show: the container writes to `/workspace/out`, and because the workspace is a
 * bind mount the file is already in the host results folder for that computer the
 * moment the RPC returns — no copy step, nothing to promote out of quarantine.
 *
 * The returned path is asserted to be workspace-relative and to resolve back under
 * the host workspace root, which is exactly the contract
 * `GET /api/v1/computers/:id/files?path=` relies on for the "Open" button.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import { acquireDockerLock } from "../lock.ts";
import { rpc } from "../../helpers/stdio.ts";

const IMAGE = process.env.MODELBOT_TEST_COMPUTER_IMAGE ?? "modelbot/computer:dev";

describe("docker-int write_file promotion", () => {
  it("writes to /workspace/out in the real image and lands in the host results folder", async () => {
    const lock = await acquireDockerLock();
    // Host stand-in for <workspaceRoot>/<computer>/workspace, the directory the
    // daemon serves results from.
    const hostWorkspace = mkdtempSync(join(tmpdir(), "mb-write-file-ws-"));
    const container = `mb-write-file-${process.pid}`;
    let child: ReturnType<typeof spawn> | null = null;
    try {
      // The image runs as uid 1001; a throwaway bind-mount fixture needs to be
      // writable by it. Production grants this with a shared gid, not world bits.
      chmodSync(hostWorkspace, 0o777);
      mkdirSync(join(hostWorkspace, "out"), { recursive: true });
      chmodSync(join(hostWorkspace, "out"), 0o777);

      const inspect = spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8" });
      if ((inspect.status ?? 1) !== 0) assert.fail(`image missing: ${IMAGE}`);

      child = spawn(
        "docker",
        [
          "run",
          "--rm",
          "-i",
          "--name",
          container,
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges:true",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,nodev,size=64m",
          "--tmpfs",
          "/quarantine:rw,noexec,nosuid,nodev,size=16m,mode=0700,uid=1001,gid=1001",
          "-v",
          `${hostWorkspace}:/workspace:rw`,
          "-e",
          "MODELBOT_WORKSPACE=/workspace",
          "-e",
          "NODE_PATH=/opt/playwright/node_modules",
          IMAGE,
          "node",
          "--experimental-strip-types",
          "/opt/computer-server/stdio.ts",
          "--role",
          "browser",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );

      const state = { buf: new Uint8Array(0) };
      child.stdout!.on("data", (chunk: Buffer) => {
        const u8 = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        const merged = new Uint8Array(state.buf.length + u8.length);
        merged.set(state.buf);
        merged.set(u8, state.buf.length);
        state.buf = merged;
      });
      let stderr = "";
      child.stderr!.on("data", (c: Buffer) => {
        stderr += c.toString();
      });
      const write = (b: Uint8Array) => void child!.stdin!.write(Buffer.from(b));

      const content = "vendor,amount\nAcme,120.00\nGlobex,80.50\n";
      const saved = await rpc(
        write,
        state,
        "write_file",
        { path: "invoices.csv", content, encoding: null, mode: null },
        1,
      );
      assert.equal(saved.result?.ok, true, `write_file failed: ${JSON.stringify(saved)} ${stderr}`);
      const data = saved.result!.data!;

      // Workspace-relative, exactly what the daemon's /files route expects.
      assert.equal(data.path, join("out", "invoices.csv"));
      assert.equal(data.bytes, Buffer.byteLength(content));
      assert.equal(data.sha256, createHash("sha256").update(content).digest("hex"));

      // The host results folder now holds the file, with no promotion step.
      const hostPath = resolve(hostWorkspace, String(data.path));
      assert.ok(
        hostPath === hostWorkspace || hostPath.startsWith(hostWorkspace + sep),
        `path escapes host workspace: ${hostPath}`,
      );
      assert.equal(readFileSync(hostPath, "utf8"), content);

      // The jail holds inside the real container too.
      const escape = await rpc(
        write,
        state,
        "write_file",
        { path: "../escaped.csv", content: "x", encoding: null, mode: null },
        2,
      );
      assert.equal(escape.result?.ok, false, `.. was accepted: ${JSON.stringify(escape)}`);
      const absolute = await rpc(
        write,
        state,
        "write_file",
        { path: "/workspace/escaped.csv", content: "x", encoding: null, mode: null },
        3,
      );
      assert.equal(absolute.result?.ok, false, `outside-out path accepted: ${JSON.stringify(absolute)}`);
      assert.throws(() => readFileSync(join(hostWorkspace, "escaped.csv")));
    } finally {
      child?.stdin?.end();
      child?.kill();
      spawnSync("docker", ["rm", "-f", container], { encoding: "utf8" });
      lock.release();
    }
  });
});
