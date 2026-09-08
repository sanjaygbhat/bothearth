import type { ComputerCapability } from "../types/contracts.ts";
import type { ComputerClient } from "./types.ts";
import { createFakeComputerClient, type FakeComputerOpts } from "./fake.ts";
import { createFakeSandbox } from "./fake-sandbox.ts";
import { createExecComputerClient } from "./exec-client.ts";
import {
  createSandboxRuntime,
  defaultSeccompPath,
  refreshComputerImage,
  startComputer,
  workspaceHostPath,
} from "../sandbox/lifecycle.ts";

export type { ComputerClient } from "./types.ts";
export { createFakeComputerClient } from "./fake.ts";

export function useFakeComputer(): boolean {
  return process.env.MODELBOT_TEST_FAKE_COMPUTER === "1";
}

export function openComputerClient(
  computerId: string,
  opts?: FakeComputerOpts & { capabilities?: ComputerCapability[] },
): ComputerClient {
  if (useFakeComputer()) {
    return createFakeComputerClient(computerId, opts);
  }
  return createExecComputerClient(computerId, { capabilities: opts?.capabilities });
}

function resolveSeccompPath(): string {
  const env = process.env.MODELBOT_SECCOMP?.trim();
  if (env) {
    if (env === "unconfined") {
      throw new Error("sandbox: seccomp=unconfined is forbidden; use sandbox/seccomp-chromium.json");
    }
    return env;
  }
  return defaultSeccompPath();
}

export function createDefaultSandbox(opts?: { workspaceRoot?: string }) {
  if (useFakeComputer()) {
    return createFakeSandbox({ workspaceRoot: opts?.workspaceRoot });
  }
  const life = createSandboxRuntime({
    seccompPath: resolveSeccompPath(),
    workspaceRoot: opts?.workspaceRoot,
  });
  return {
    detect: () => life.detect(),
    create: (createOpts: Parameters<typeof life.create>[0]) =>
      life.create(createOpts),
    stop: (id: string) => life.stop(id),
    destroy: (id: string) => life.destroy(id),
    async start(computerId: string): Promise<void> {
      await startComputer(computerId, {
        seccompPath: resolveSeccompPath(),
        workspaceRoot: opts?.workspaceRoot,
      });
    },
    /** Recreate the containers when their tag now points at a newer image. */
    async refreshImage(computerId: string, capabilities: ComputerCapability[]): Promise<boolean> {
      return await refreshComputerImage(computerId, capabilities, {
        seccompPath: resolveSeccompPath(),
        workspaceRoot: opts?.workspaceRoot,
      });
    },
    get(computerId: string): { workspaceRoot?: string } {
      return {
        workspaceRoot: workspaceHostPath(computerId, opts?.workspaceRoot),
      };
    },
  };
}
