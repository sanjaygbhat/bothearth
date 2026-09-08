/**
 * modelbot deploy public API.
 */

export {
  DAEMON_BIND_HOST,
  DAEMON_PORT,
  TAILSCALE_UDP_PORT,
  type AccessMode,
  type DeployOptions,
  type DestroyOptions,
  type DeployStep,
  type DeployResult,
  type DestroyResult,
  type DeployProvider,
  type DeployProviderName,
  type RemoteState,
} from "./types.ts";

export {
  renderCloudInit,
  renderSystemdUnit,
  type CloudInitParams,
} from "./cloud-init.ts";

export {
  remotesDir,
  remoteStatePath,
  loadRemoteState,
  saveRemoteState,
  deleteRemoteState,
} from "./state.ts";

export {
  planSshSteps,
  sshTunnelCommand,
  accessHintFor,
  SshProvider,
  noopRemoteRunner,
  type SshPlanInput,
  type RemoteRunner,
} from "./ssh.ts";

export {
  HetznerClient,
  HetznerApiError,
  HetznerProvider,
  destroyRemote,
  type HetznerClientOptions,
  type HetznerProviderOptions,
} from "./hetzner.ts";

import type { DeployOptions, DeployResult, DestroyOptions, DestroyResult } from "./types.ts";
import { SshProvider, type RemoteRunner } from "./ssh.ts";
import { HetznerProvider, destroyRemote } from "./hetzner.ts";

export interface DeployDeps {
  home?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  runner?: RemoteRunner;
  publicKey?: string;
  sleep?: (ms: number) => Promise<void>;
  waitAttempts?: number;
  waitDelayMs?: number;
}

/** Top-level deploy entry used by CLI. */
export async function deploy(
  opts: DeployOptions,
  deps: DeployDeps = {},
): Promise<{ result: DeployResult; signupLines: string[] }> {
  const signupLines =
    opts.provider === "hetzner" && opts.suggestSignup
      ? ["Hetzner Cloud signup: https://www.hetzner.com/cloud"]
      : [];

  if (opts.provider === "ssh") {
    const p = new SshProvider(deps);
    return { result: await p.deploy(opts), signupLines };
  }
  if (opts.provider === "hetzner") {
    const p = new HetznerProvider(deps);
    return { result: await p.deploy(opts), signupLines };
  }
  throw new Error(`unknown provider: ${(opts as DeployOptions).provider}`);
}

export async function destroy(
  opts: DestroyOptions,
  deps: DeployDeps = {},
): Promise<DestroyResult> {
  return destroyRemote(opts, deps);
}
