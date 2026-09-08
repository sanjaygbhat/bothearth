/**
 * Deploy provider contracts.
 * Daemon always binds 127.0.0.1:7777 on the guest; never public UI ports.
 */

export const DAEMON_BIND_HOST = "127.0.0.1";
export const DAEMON_PORT = 7777;
export const TAILSCALE_UDP_PORT = 41641;

export type DeployProviderName = "ssh" | "hetzner";

export type AccessMode = "tailscale" | "ssh";

export interface DeployOptions {
  name: string;
  provider: DeployProviderName;
  /** SSH target user@host (ssh provider) or post-create bootstrap host. */
  host?: string;
  user?: string;
  sshKeyPath?: string;
  /** Local path to `npm pack` tarball; default packs from cwd. */
  tarballPath?: string;
  /** One-off Tailscale auth key; never persisted in local remotes plaintext. */
  tailscaleAuthkey?: string;
  /** Existing private Serve connection; does not join or change a tailnet account. */
  tailscaleServe?: boolean;
  publicOrigin?: string;
  /** Remote absolute path to an existing systemd user-encrypted credential. */
  systemdCredential?: string;
  /** Hetzner project API token (or from tokenEnv). */
  token?: string;
  tokenEnv?: string;
  region?: string;
  arch?: "amd64" | "arm64";
  serverType?: string;
  image?: string;
  ipv4?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  /** Suggest Hetzner signup (prints disclosure once). */
  suggestSignup?: boolean;
}

export interface DestroyOptions {
  name: string;
  yes?: boolean;
  dryRun?: boolean;
  token?: string;
  tokenEnv?: string;
}

/** One planned remote/local action for dry-run and tests (no real SSH). */
export interface DeployStep {
  id: string;
  summary: string;
  /** Shell-ish command string for dry-run / planner assertions. */
  command: string;
}

export interface DeployResult {
  name: string;
  provider: DeployProviderName;
  dryRun: boolean;
  steps: DeployStep[];
  /** Private URL or recovery hint. */
  accessHint: string;
  serverId?: string;
  ipv4?: string | null;
  ipv6?: string | null;
  skippedCreate?: boolean;
}

export interface DestroyResult {
  name: string;
  dryRun: boolean;
  steps: DeployStep[];
  deleted: boolean;
}

export interface RemoteState {
  name: string;
  provider: DeployProviderName;
  deploymentId: string;
  serverId?: string;
  firewallId?: string;
  sshKeyId?: string | number;
  host?: string;
  user?: string;
  arch?: string;
  image?: string;
  region?: string;
  createdAt: string;
  access: AccessMode;
}

export interface DeployProvider {
  readonly name: DeployProviderName;
  plan(opts: DeployOptions): Promise<DeployStep[]>;
  deploy(opts: DeployOptions): Promise<DeployResult>;
  destroy(opts: DestroyOptions, state: RemoteState): Promise<DestroyResult>;
}
