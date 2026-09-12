/**
 * `modelbot image build` — the same three stamped builds the daemon's
 * `POST /api/v1/runtime/prepare` runs, so `GET /api/v1/runtime` recognises the
 * result. Streams docker's output; the daemon streams to a log file instead.
 */

import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_SPECS, buildArgs, childEnv } from "../daemon/runtime.ts";
import { toolPath } from "../daemon/resolve-tool.ts";

/** Holds Dockerfile.* in both `src/cli` and `dist/cli` layouts. */
const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function dockerBuild(args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(toolPath("docker"), args, { cwd, stdio: "inherit", env: childEnv() });
    child.on("error", (err) => {
      console.error(String(err));
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export async function runImageCli(
  argv: string[],
  runBuild: (args: string[], cwd: string) => Promise<number> = dockerBuild,
): Promise<void> {
  const sub = argv[0];
  if (sub === "build") {
    for (const spec of BUILD_SPECS) {
      console.log(spec.step);
      const code = await runBuild(buildArgs(spec, PACKAGE_ROOT), PACKAGE_ROOT);
      if (code !== 0) {
        console.error(`docker build failed for ${spec.dockerfile} (exit ${code})`);
        process.exitCode = 1;
        return;
      }
    }
    console.log("Workspaces built. Restart the daemon to apply, or run: modelbot start");
    return;
  }
  if (sub === "pull") {
    console.error("No prebuilt ModelBot images are published yet. Build them here: modelbot image build");
    process.exitCode = 1;
    return;
  }
  console.log("usage: modelbot image pull|build");
  process.exitCode = 2;
}
