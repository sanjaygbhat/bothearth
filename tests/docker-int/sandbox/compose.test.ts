/**
 * Docker-int: compose up → inspect hardening (same asserts as the lifecycle test) → down.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { withDockerLock } from "../lock.ts";
import {
  createComputerCompose,
  destroyComputerCompose,
  inspectComputerContainer,
  defaultComposeFilePath,
} from "../../../src/sandbox/index.ts";

const NAME = `composet${process.pid}`;
const REPO = join(import.meta.dirname, "../../..");

function ensureImages(): void {
  for (const img of [
    "modelbot/computer:dev",
    "modelbot/shell:dev",
    "modelbot/proxy:dev",
  ]) {
    const r = spawnSync("docker", ["image", "inspect", img], {
      encoding: "utf8",
    });
    if (r.status !== 0) {
      if (img === "modelbot/proxy:dev") {
        const build = spawnSync(
          "docker",
          ["build", "-f", "Dockerfile.proxy", "-t", "modelbot/proxy:dev", "."],
          { encoding: "utf8", cwd: REPO },
        );
        if (build.status !== 0) {
          throw new Error(`proxy build failed: ${build.stderr}`);
        }
        continue;
      }
      throw new Error(`missing image ${img}`);
    }
  }
}

describe("sandbox docker-int compose", () => {
  let workspaceRoot: string;

  before(async () => {
    ensureImages();
    workspaceRoot = await mkdtemp(join(tmpdir(), "modelbot-compose-"));
  });

  after(async () => {
    await withDockerLock(async () => {
      await destroyComputerCompose(NAME, {
        workspaceRoot,
        keepProfile: false,
        composeFile: defaultComposeFilePath(REPO),
        projectDirectory: REPO,
      });
    });
  });

  it("compose up → inspect hardening → down", async () => {
    await withDockerLock(async () => {
      await destroyComputerCompose(NAME, {
        workspaceRoot,
        keepProfile: false,
        composeFile: defaultComposeFilePath(REPO),
        projectDirectory: REPO,
      });

      const handle = await createComputerCompose(
        NAME,
        { capabilities: ["browser", "shell"] },
        {
          workspaceRoot,
          composeFile: defaultComposeFilePath(REPO),
          projectDirectory: REPO,
        },
      );
      assert.equal(handle.name, NAME);

      const browser = await inspectComputerContainer(NAME, "browser", {
        workspaceRoot,
      });
      assert.ok(browser, "browser inspect");
      const bHost = browser.HostConfig as Record<string, unknown>;
      const bCfg = browser.Config as Record<string, unknown>;

      assert.equal(bHost.ReadonlyRootfs, true);
      assert.deepEqual(bHost.CapDrop, ["ALL"]);
      assert.equal(bHost.Privileged, false);
      const securityOpts = (bHost.SecurityOpt as string[]) ?? [];
      assert.ok(
        securityOpts.some((s) => /no-new-privileges/i.test(s)),
        `SecurityOpt=${JSON.stringify(securityOpts)}`,
      );
      assert.ok(
        securityOpts.some((s) => /seccomp/i.test(s)),
        "seccomp profile applied",
      );
      assert.notEqual(bHost.IpcMode, "host");
      const shm = Number(bHost.ShmSize ?? 0);
      assert.ok(shm >= 1024 ** 3, `ShmSize=${shm}`);
      assert.equal(bHost.PublishAllPorts, false);
      const ports = bCfg.ExposedPorts ?? bHost.PortBindings;
      if (ports && typeof ports === "object") {
        assert.equal(Object.keys(ports as object).length, 0);
      }
      const mounts = (browser.Mounts as Array<Record<string, unknown>>) ?? [];
      assert.ok(
        !mounts.some(
          (m) =>
            String(m.Source ?? "").includes("docker.sock") ||
            String(m.Destination ?? "").includes("docker.sock"),
        ),
        "no docker.sock mount",
      );
      assert.ok(
        mounts.some(
          (m) =>
            m.Type === "volume" &&
            String(m.Destination).includes("/home/browser/profile"),
        ),
        "profile volume on browser",
      );
      assert.equal(
        (bCfg.Labels as Record<string, string>)?.["modelbot.computer"],
        NAME,
      );

      const shell = await inspectComputerContainer(NAME, "shell", {
        workspaceRoot,
      });
      assert.ok(shell, "shell inspect");
      const sHost = shell.HostConfig as Record<string, unknown>;
      assert.equal(sHost.ReadonlyRootfs, true);
      assert.deepEqual(sHost.CapDrop, ["ALL"]);
      const sMounts = (shell.Mounts as Array<Record<string, unknown>>) ?? [];
      assert.ok(
        !sMounts.some((m) =>
          String(m.Destination ?? "").includes("/home/browser/profile"),
        ),
        "shell has no profile volume",
      );
      assert.ok(
        !sMounts.some((m) => String(m.Source ?? "").includes("docker.sock")),
        "shell no docker.sock",
      );

      await destroyComputerCompose(NAME, {
        workspaceRoot,
        keepProfile: false,
        composeFile: defaultComposeFilePath(REPO),
        projectDirectory: REPO,
      });
    });
  });
});
