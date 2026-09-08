/**
 * Hetzner Cloud REST client + deploy provider.
 * Base URL injectable for local mock HTTP tests.
 */

import { randomUUID } from "node:crypto";
import { renderCloudInit } from "./cloud-init.ts";
import {
  accessHintFor,
  planSshSteps,
  SshProvider,
  type RemoteRunner,
} from "./ssh.ts";
import { deleteRemoteState, loadRemoteState, saveRemoteState } from "./state.ts";
import {
  TAILSCALE_UDP_PORT,
  type DeployOptions,
  type DeployProvider,
  type DeployResult,
  type DeployStep,
  type DestroyOptions,
  type DestroyResult,
  type RemoteState,
} from "./types.ts";

const DEFAULT_BASE = "https://api.hetzner.cloud/v1";

export interface HetznerClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class HetznerApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`Hetzner API ${status}: ${body.slice(0, 200)}`);
    this.status = status;
    this.body = body;
  }
}

export class HetznerClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HetznerClientOptions) {
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new HetznerApiError(res.status, text);
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  createFirewall(name: string): Promise<{
    firewall: { id: number; name: string };
  }> {
    return this.request("POST", "/firewalls", {
      name,
      rules: [
        {
          direction: "in",
          protocol: "tcp",
          port: "22",
          source_ips: ["0.0.0.0/0", "::/0"],
          description: "SSH",
        },
        {
          direction: "in",
          protocol: "udp",
          port: String(TAILSCALE_UDP_PORT),
          source_ips: ["0.0.0.0/0", "::/0"],
          description: "Tailscale",
        },
      ],
    });
  }

  uploadSshKey(
    name: string,
    publicKey: string,
  ): Promise<{ ssh_key: { id: number; name: string; fingerprint: string } }> {
    return this.request("POST", "/ssh_keys", {
      name,
      public_key: publicKey,
    });
  }

  listSshKeys(): Promise<{
    ssh_keys: Array<{ id: number; name: string; fingerprint: string }>;
  }> {
    return this.request("GET", "/ssh_keys");
  }

  createServer(body: {
    name: string;
    server_type: string;
    image: string;
    location: string;
    ssh_keys: Array<string | number>;
    user_data: string;
    firewalls?: Array<{ firewall: number }>;
    public_net?: { enable_ipv4: boolean; enable_ipv6: boolean };
    labels?: Record<string, string>;
  }): Promise<{
    server: {
      id: number;
      name: string;
      status: string;
      public_net: {
        ipv4: { ip: string } | null;
        ipv6: { ip: string } | null;
      };
    };
  }> {
    return this.request("POST", "/servers", body);
  }

  getServer(id: number): Promise<{
    server: {
      id: number;
      name: string;
      status: string;
      public_net: {
        ipv4: { ip: string } | null;
        ipv6: { ip: string } | null;
      };
    };
  }> {
    return this.request("GET", `/servers/${id}`);
  }

  deleteServer(id: number): Promise<void> {
    return this.request("DELETE", `/servers/${id}`);
  }

  deleteFirewall(id: number): Promise<void> {
    return this.request("DELETE", `/firewalls/${id}`);
  }

  /**
   * Poll until status === running or attempts exhausted.
   */
  async waitUntilRunning(
    id: number,
    opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<{
    id: number;
    name: string;
    status: string;
    public_net: {
      ipv4: { ip: string } | null;
      ipv6: { ip: string } | null;
    };
  }> {
    const attempts = opts.attempts ?? 60;
    const delayMs = opts.delayMs ?? 2000;
    const sleep =
      opts.sleep ??
      ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let lastStatus = "unknown";
    for (let i = 0; i < attempts; i++) {
      const { server } = await this.getServer(id);
      lastStatus = server.status;
      if (server.status === "running") return server;
      await sleep(delayMs);
    }
    throw new Error(
      `Hetzner server ${id} not running after ${attempts} polls (last=${lastStatus})`,
    );
  }
}

export interface HetznerProviderOptions {
  home?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  runner?: RemoteRunner;
  /** Injected public key material for upload (tests). */
  publicKey?: string;
  sleep?: (ms: number) => Promise<void>;
  waitAttempts?: number;
  waitDelayMs?: number;
}

function resolveToken(opts: DeployOptions | DestroyOptions): string {
  if (opts.token) return opts.token;
  const envName = opts.tokenEnv ?? "HCLOUD_TOKEN";
  const v = process.env[envName];
  if (!v) throw new Error(`missing Hetzner token (set ${envName} or --token)`);
  return v;
}

export class HetznerProvider implements DeployProvider {
  readonly name = "hetzner" as const;
  private readonly home?: string;
  private readonly baseUrl?: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly runner: RemoteRunner;
  private readonly publicKey: string;
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly waitAttempts?: number;
  private readonly waitDelayMs?: number;

  constructor(opts: HetznerProviderOptions = {}) {
    this.home = opts.home;
    this.baseUrl = opts.baseUrl;
    this.fetchImpl = opts.fetchImpl;
    this.runner = opts.runner ?? (async () => {});
    this.publicKey =
      opts.publicKey ??
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFmodelbot-deploy-placeholder modelbot-deploy";
    this.sleep = opts.sleep;
    this.waitAttempts = opts.waitAttempts;
    this.waitDelayMs = opts.waitDelayMs;
  }

  private client(token: string): HetznerClient {
    return new HetznerClient({
      token,
      baseUrl: this.baseUrl,
      fetchImpl: this.fetchImpl,
    });
  }

  async plan(opts: DeployOptions): Promise<DeployStep[]> {
    const region = opts.region ?? "nbg1";
    const serverType =
      opts.serverType ?? (opts.arch === "arm64" ? "cax11" : "cx23");
    const image = opts.image ?? "ubuntu-24.04";
    const userData = renderCloudInit({
      distro: image.startsWith("debian") ? "debian" : "ubuntu",
      hostname: opts.name,
    });
    const deployId = "PLAN";
    const steps: DeployStep[] = [
      {
        id: "ensure-ssh-key",
        summary: "Upload SSH public key if missing",
        command: `POST ${this.baseUrl ?? DEFAULT_BASE}/ssh_keys name=modelbot-${opts.name}`,
      },
      {
        id: "create-firewall",
        summary: "Create firewall: SSH:22 + Tailscale UDP only (no public UI)",
        command: `POST ${this.baseUrl ?? DEFAULT_BASE}/firewalls rules=[tcp/22,udp/${TAILSCALE_UDP_PORT}]`,
      },
      {
        id: "create-server",
        summary: `Create server ${serverType} in ${region}`,
        command: `POST ${this.baseUrl ?? DEFAULT_BASE}/servers type=${serverType} image=${image} location=${region} labels.modelbot-deploy=${deployId} user_data_bytes=${userData.length}`,
      },
      {
        id: "wait-running",
        summary: "Wait until server status=running",
        command: `GET ${this.baseUrl ?? DEFAULT_BASE}/servers/{id} poll`,
      },
    ];
    // After create, same SSH bootstrap as generic provider.
    const host = opts.host ?? "<server-ip>";
    const user = opts.user ?? "root";
    steps.push(
      ...planSshSteps({
        user,
        host,
        sshKeyPath: opts.sshKeyPath,
        tarballPath: opts.tarballPath,
        tailscaleAuthkey: opts.tailscaleAuthkey,
        tailscaleServe: opts.tailscaleServe,
        publicOrigin: opts.publicOrigin,
        systemdCredential: opts.systemdCredential,
      }),
    );
    return steps;
  }

  async deploy(opts: DeployOptions): Promise<DeployResult> {
    const existing = loadRemoteState(opts.name, this.home);
    if (existing?.provider === "hetzner" && existing.serverId) {
      const token = opts.dryRun ? "dry-run" : resolveToken(opts);
      if (!opts.dryRun) {
        const client = this.client(token);
        try {
          const { server } = await client.getServer(Number(existing.serverId));
          if (server.status === "running" || server.status === "off") {
            const host =
              server.public_net.ipv4?.ip ??
              server.public_net.ipv6?.ip ??
              existing.host ??
              "unknown";
            const user = existing.user ?? "root";
            const steps = await this.plan({ ...opts, host });
            return {
              name: opts.name,
              provider: "hetzner",
              dryRun: false,
              steps,
              accessHint: accessHintFor(user, host, !!opts.tailscaleAuthkey),
              serverId: String(server.id),
              ipv4: server.public_net.ipv4?.ip ?? null,
              ipv6: server.public_net.ipv6?.ip ?? null,
              skippedCreate: true,
            };
          }
        } catch (err) {
          if (!(err instanceof HetznerApiError) || err.status !== 404) throw err;
          // stale state — fall through to create
        }
      } else {
        const steps = await this.plan(opts);
        return {
          name: opts.name,
          provider: "hetzner",
          dryRun: true,
          steps,
          accessHint: accessHintFor(
            existing.user ?? "root",
            existing.host ?? "<server-ip>",
            !!opts.tailscaleAuthkey,
          ),
          serverId: existing.serverId,
          skippedCreate: true,
        };
      }
    }

    const steps = await this.plan(opts);
    if (opts.dryRun) {
      return {
        name: opts.name,
        provider: "hetzner",
        dryRun: true,
        steps,
        accessHint: accessHintFor(
          opts.user ?? "root",
          opts.host ?? "<server-ip>",
          !!opts.tailscaleAuthkey,
        ),
      };
    }

    const token = resolveToken(opts);
    const client = this.client(token);
    const deploymentId = randomUUID();
    const region = opts.region ?? "nbg1";
    const serverType =
      opts.serverType ?? (opts.arch === "arm64" ? "cax11" : "cx23");
    const image = opts.image ?? "ubuntu-24.04";
    const userData = renderCloudInit({
      distro: image.startsWith("debian") ? "debian" : "ubuntu",
      hostname: opts.name,
    });

    let sshKeyId: number | string = `modelbot-${opts.name}`;
    try {
      const uploaded = await client.uploadSshKey(
        `modelbot-${opts.name}`,
        this.publicKey,
      );
      sshKeyId = uploaded.ssh_key.id;
    } catch (err) {
      if (err instanceof HetznerApiError && (err.status === 409 || err.status === 422)) {
        const listed = await client.listSshKeys();
        const found = listed.ssh_keys.find(
          (k) => k.name === `modelbot-${opts.name}`,
        );
        if (!found) throw err;
        sshKeyId = found.id;
      } else {
        throw err;
      }
    }

    const fw = await client.createFirewall(`modelbot-${opts.name}-private`);
    const created = await client.createServer({
      name: opts.name,
      server_type: serverType,
      image,
      location: region,
      ssh_keys: [sshKeyId],
      user_data: userData,
      firewalls: [{ firewall: fw.firewall.id }],
      public_net: {
        enable_ipv4: opts.ipv4 === true,
        enable_ipv6: true,
      },
      labels: { "modelbot-deploy": deploymentId },
    });

    const server = await client.waitUntilRunning(created.server.id, {
      attempts: this.waitAttempts ?? 60,
      delayMs: this.waitDelayMs ?? 2000,
      sleep: this.sleep,
    });

    const host =
      opts.host ??
      server.public_net.ipv4?.ip ??
      server.public_net.ipv6?.ip;
    if (!host) throw new Error("Hetzner server has no public IP");
    const user = opts.user ?? "root";

    const sshSteps = planSshSteps({
      user,
      host,
      sshKeyPath: opts.sshKeyPath,
      tarballPath: opts.tarballPath,
      tailscaleAuthkey: opts.tailscaleAuthkey,
        tailscaleServe: opts.tailscaleServe,
        publicOrigin: opts.publicOrigin,
        systemdCredential: opts.systemdCredential,
    });
    for (const step of sshSteps) {
      if (step.id === "print-ssh-tunnel") continue;
      await this.runner(step);
    }

    saveRemoteState(
      {
        name: opts.name,
        provider: "hetzner",
        deploymentId,
        serverId: String(server.id),
        firewallId: String(fw.firewall.id),
        sshKeyId,
        host,
        user,
        arch: opts.arch,
        image,
        region,
        createdAt: new Date().toISOString(),
        access: opts.tailscaleAuthkey ? "tailscale" : "ssh",
      },
      this.home,
    );

    return {
      name: opts.name,
      provider: "hetzner",
      dryRun: false,
      steps: [...steps.slice(0, 4), ...sshSteps],
      accessHint: accessHintFor(user, host, !!opts.tailscaleAuthkey),
      serverId: String(server.id),
      ipv4: server.public_net.ipv4?.ip ?? null,
      ipv6: server.public_net.ipv6?.ip ?? null,
    };
  }

  async destroy(
    opts: DestroyOptions,
    state: RemoteState,
  ): Promise<DestroyResult> {
    const steps: DeployStep[] = [
      {
        id: "delete-server",
        summary: "Delete Hetzner server",
        command: `DELETE ${this.baseUrl ?? DEFAULT_BASE}/servers/${state.serverId}`,
      },
    ];
    if (state.firewallId) {
      steps.push({
        id: "delete-firewall",
        summary: "Delete firewall",
        command: `DELETE ${this.baseUrl ?? DEFAULT_BASE}/firewalls/${state.firewallId}`,
      });
    }
    if (opts.dryRun) {
      return { name: opts.name, dryRun: true, steps, deleted: false };
    }
    const token = resolveToken(opts);
    const client = this.client(token);
    if (state.serverId) {
      try {
        await client.deleteServer(Number(state.serverId));
      } catch (err) {
        if (!(err instanceof HetznerApiError) || err.status !== 404) throw err;
      }
    }
    if (state.firewallId) {
      try {
        await client.deleteFirewall(Number(state.firewallId));
      } catch (err) {
        if (!(err instanceof HetznerApiError) || err.status !== 404) throw err;
      }
    }
    deleteRemoteState(opts.name, this.home);
    return { name: opts.name, dryRun: false, steps, deleted: true };
  }
}

/** Convenience: run SSH wipe then Hetzner delete when both apply. */
export async function destroyRemote(
  opts: DestroyOptions,
  deps: {
    home?: string;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    runner?: RemoteRunner;
  } = {},
): Promise<DestroyResult> {
  const state = loadRemoteState(opts.name, deps.home);
  if (!state) {
    return {
      name: opts.name,
      dryRun: !!opts.dryRun,
      steps: [
        {
          id: "missing",
          summary: "No local remote state",
          command: `# no ~/.modelbot/remotes/${opts.name}.json`,
        },
      ],
      deleted: false,
    };
  }
  if (state.provider === "hetzner") {
    const p = new HetznerProvider(deps);
    return p.destroy(opts, state);
  }
  const p = new SshProvider(deps);
  return p.destroy(opts, state);
}
