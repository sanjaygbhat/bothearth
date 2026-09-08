/**
 * Docker-int: browser container + computer-server stdio RPC.
 * Production hardening flags come from src/sandbox/flags.ts.
 *
 * Navigates to an HTTP fixture on a private docker network (data:/file: schemes
 * are policy-denied; network=none cannot reach http).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { browserRuntimeFlags } from "../../../src/sandbox/flags.ts";
import { acquireDockerLock } from "../lock.ts";
import { rpc } from "../../helpers/stdio.ts";

const IMAGE = process.env.MODELBOT_TEST_COMPUTER_IMAGE ?? "modelbot/computer:dev";

function hardening(net: string): string[] {
  return [
    "--rm",
    "-i",
    ...browserRuntimeFlags(resolve("sandbox/seccomp-chromium.json")),
    "--tmpfs",
    "/home/browser/.cache:rw,uid=1001,gid=1001,mode=0755",
    "--tmpfs",
    "/home/browser/profile:rw,uid=1001,gid=1001,mode=0700",
    "--tmpfs",
    "/workspace:rw,uid=1001,gid=1001,mode=0775",
    "--network",
    net,
    "-e",
    "NODE_PATH=/opt/playwright/node_modules",
    "-e",
    "PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers",
    "-e",
    "MODELBOT_WORKSPACE=/workspace",
    "-e",
    "MODELBOT_PROFILE=/home/browser/profile",
    // Fail-closed proxy env; fixture host bypasses the (dummy) proxy.
    "-e",
    "MODELBOT_PROXY_SERVER=http://127.0.0.1:9",
    "-e",
    "MODELBOT_PROXY_BYPASS=fixtures,localhost,127.0.0.1",
  ];
}

function docker(args: string[], opts?: { allowFail?: boolean }): string {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  if ((r.status ?? 1) !== 0 && !opts?.allowFail) {
    throw new Error(`docker ${args.join(" ")} → ${r.stderr || r.stdout}`);
  }
  return r.stdout ?? "";
}

describe("docker-int computer-server browser", () => {
  it("navigate+snapshot+screenshot+mouse via docker exec transport", async () => {
    const lock = await acquireDockerLock();
    const net = `mb-browser-net-${process.pid}`;
    const fixtures = `mb-browser-fixtures-${process.pid}`;
    const browser = `mb-browser-${process.pid}`;
    const siteDir = join(tmpdir(), `mb-browser-site-${process.pid}`);
    try {
      mkdirSync(siteDir, { recursive: true });
      writeFileSync(
        join(siteDir, "index.html"),
        "<!doctype html><html><body><button id='b'>Hi</button></body></html>\n",
        "utf8",
      );
      const insp = spawn("docker", ["image", "inspect", IMAGE], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      const inspCode = await new Promise<number>((r) => insp.on("exit", (c) => r(c ?? 1)));
      if (inspCode !== 0) {
        assert.fail(`image missing: ${IMAGE} (build final stage first)`);
      }

      docker(["network", "create", net]);
      docker([
        "run",
        "-d",
        "--rm",
        "--name",
        fixtures,
        "--network",
        net,
        "--network-alias",
        "fixtures",
        "-v",
        `${siteDir}:/site:ro`,
        "-w",
        "/site",
        "python:3.11-slim",
        "python",
        "-m",
        "http.server",
        "80",
      ]);
      // Wait for fixture HTTP
      for (let i = 0; i < 30; i++) {
        const probe = spawnSync(
          "docker",
          [
            "run",
            "--rm",
            "--network",
            net,
            "curlimages/curl:8.12.1",
            "-sf",
            "http://fixtures/",
          ],
          { encoding: "utf8" },
        );
        if (probe.status === 0) break;
        await sleep(200);
        if (i === 29) {
          assert.fail(`fixture not ready: ${probe.stderr}`);
        }
      }

      const child = spawn(
        "docker",
        [
          "run",
          ...hardening(net),
          "--name",
          browser,
          IMAGE,
          "node",
          "--experimental-strip-types",
          "/opt/computer-server/stdio.ts",
          "--role",
          "browser",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );

      const state = { buf: new Uint8Array(0), queue: [] as unknown[] };
      child.stdout.on("data", (chunk: Buffer) => {
        const u8 = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        const merged = new Uint8Array(state.buf.length + u8.length);
        merged.set(state.buf);
        merged.set(u8, state.buf.length);
        state.buf = merged;
      });
      let stderr = "";
      child.stderr.on("data", (c: Buffer) => {
        stderr += c.toString();
      });

      const write = (b: Uint8Array) => {
        child.stdin.write(Buffer.from(b));
      };

      try {
        const nav = (await rpc(write, state, "browser_navigate", {
          url: "http://fixtures/",
          wait_until: "load",
        }, 1)) as { result?: { ok: boolean; error?: { message: string } } };
        assert.equal(nav.result?.ok, true, stderr || nav.result?.error?.message || "");

        const snap = (await rpc(write, state, "browser_snapshot", {
          scope: null,
          interactive_only: true,
          depth: null,
          max_chars: 8000,
        }, 2)) as {
          result?: {
            ok: boolean;
            data?: { snapshot_id: string; refs: string[] };
            error?: { message: string };
          };
        };
        assert.equal(snap.result?.ok, true, stderr || snap.result?.error?.message || "");
        assert.ok(snap.result?.data?.snapshot_id);

        const shot = (await rpc(write, state, "browser_screenshot", {
          full_page: false,
          max_width: 1280,
          max_height: 720,
          snapshot_id: null,
          ref: null,
        }, 3)) as {
          result?: {
            ok: boolean;
            data?: { css_width: number };
            error?: { message: string };
          };
        };
        assert.equal(shot.result?.ok, true, stderr || shot.result?.error?.message || "");
        assert.ok((shot.result?.data?.css_width ?? 0) > 0);

        const mouse = (await rpc(write, state, "computer_mouse", {
          action: "click",
          x: 10,
          y: 10,
          x2: null,
          y2: null,
          button: 0,
          dx: null,
          dy: null,
        }, 4)) as { result?: { ok: boolean; error?: { message: string } } };
        assert.equal(mouse.result?.ok, true, stderr || mouse.result?.error?.message || "");

        const stats = spawn(
          "docker",
          ["stats", "--no-stream", "--format", "{{.MemUsage}}", browser],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        let mem = "";
        stats.stdout.on("data", (c: Buffer) => {
          mem += c.toString();
        });
        await new Promise((r) => stats.on("exit", r));
        console.log("CONTAINER_RSS", mem.trim());
      } finally {
        child.stdin.end();
        child.kill("SIGKILL");
        await new Promise((r) => child.on("exit", r));
      }
    } finally {
      docker(["rm", "-f", browser], { allowFail: true });
      docker(["rm", "-f", fixtures], { allowFail: true });
      docker(["network", "rm", net], { allowFail: true });
      lock.release();
    }
  });
});
