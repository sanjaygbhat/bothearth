/**
 * Docker-int: create → inspect hardening → exec ping → destroy.
 * Serialized via tests/docker-int/lock.ts.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { withDockerLock } from "../lock.ts";
import {
  createComputer,
  destroyComputer,
  execTransport,
  inspectComputerContainer,
  PING_ECHO_NODE,
  defaultSeccompPath,
} from "../../../src/sandbox/index.ts";

const NAME = `lifecyclet${process.pid}`;

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
          {
            encoding: "utf8",
            cwd: join(import.meta.dirname, "../../.."),
          },
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

describe("sandbox docker-int lifecycle", () => {
  let workspaceRoot: string;

  before(async () => {
    ensureImages();
    workspaceRoot = await mkdtemp(join(tmpdir(), "modelbot-lifecycle-"));
  });

  after(async () => {
    await withDockerLock(async () => {
      await destroyComputer(NAME, { keepProfile: false }, { workspaceRoot });
    });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("create → inspect hardening → exec ping → destroy", async () => {
    await withDockerLock(async () => {
      await destroyComputer(NAME, { keepProfile: false }, { workspaceRoot });

      const handle = await createComputer(
        NAME,
        { capabilities: ["browser", "shell"] },
        {
          workspaceRoot,
          seccompPath: defaultSeccompPath(),
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
      const workspaceStat = await stat(join(workspaceRoot, NAME, "workspace"));
      const sharedGroup = String(workspaceStat.gid);
      assert.ok((bHost.GroupAdd as string[]).includes(sharedGroup));
      assert.ok((sHost.GroupAdd as string[]).includes(sharedGroup));
      assert.equal(workspaceStat.mode & 0o007, 0, "workspace remains private to owner/group");
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

      const client = await execTransport(NAME, "browser", {
        entry: [...PING_ECHO_NODE],
      });
      try {
        const result = (await client.request("ping", {})) as {
          ok?: boolean;
          pong?: boolean;
        };
        assert.equal(result.ok, true);
        assert.equal(result.pong, true);
      } finally {
        await client.close();
      }

      const browserClient = await execTransport(NAME, "browser");
      const shellClient = await execTransport(NAME, "shell");
      try {
        const denied = (await browserClient.request("shell_exec", {
          command: "printf wrong-role",
        })) as { ok: boolean; error?: { code?: string } };
        assert.equal(denied.ok, false);
        assert.equal(denied.error?.code, "E_CAPABILITY");

        const executed = (await shellClient.request("shell_exec", {
          command: "printf transport-role-ok > /workspace/permission-proof.txt && cat /workspace/permission-proof.txt && test ! -r /home/browser/profile",
        })) as { ok: boolean; data?: { stdout?: string } };
        assert.equal(executed.ok, true, JSON.stringify(executed));
        assert.equal(executed.data?.stdout, "transport-role-ok");
        const shared = (await browserClient.request("files_read", {
          path: "/workspace/permission-proof.txt",
        })) as { ok: boolean; data?: { content?: string } };
        assert.equal(shared.ok, true, JSON.stringify(shared));
        assert.equal(shared.data?.content, "transport-role-ok", "browser reads shell output through shared workspace");
        const privateProfile = (await shellClient.request("files_read", {
          path: "/home/browser/profile",
        })) as { ok: boolean };
        assert.equal(privateProfile.ok, false, "shared workspace group does not expose browser profile");
      } finally {
        await Promise.all([browserClient.close(), shellClient.close()]);
      }

      await destroyComputer(NAME, { keepProfile: false }, { workspaceRoot });
      const gone = await inspectComputerContainer(NAME, "browser", {
        workspaceRoot,
      });
      assert.equal(gone, null);
    });
  });
});
