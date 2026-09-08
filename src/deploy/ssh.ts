/**
 * Generic SSH deploy provider.
 * Plans remote bootstrap steps; dry-run never opens SSH.
 * Real SSH execution is opt-in via executeRemote (injectable for tests).
 */

import { canonicalHttpsOrigin } from "../daemon/auth.ts";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  DAEMON_BIND_HOST,
  DAEMON_PORT,
  type DeployOptions,
  type DeployProvider,
  type DeployResult,
  type DeployStep,
  type DestroyOptions,
  type DestroyResult,
  type RemoteState,
} from "./types.ts";
import { renderSystemdUnit } from "./cloud-init.ts";
import { deleteRemoteState, loadRemoteState, saveRemoteState } from "./state.ts";

export interface SshPlanInput {
  user: string;
  host: string;
  sshKeyPath?: string;
  tarballPath?: string;
  tailscaleAuthkey?: string;
  tailscaleServe?: boolean;
  publicOrigin?: string;
  systemdCredential?: string;
  configSnippet?: string;
}

function sshPrefix(user: string, host: string, key?: string): string {
  assertSshIdentifier("user", user, /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/);
  assertSshIdentifier("host", host, /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])$/);
  if (key && !/^\/[A-Za-z0-9_./ -]+$/.test(key)) throw new Error("unsafe ssh key path");
  const target = `${user}@${host}`;
  const keyPart = key ? `-i '${key.replaceAll("'", "'\\''")}' ` : "";
  return `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes ${keyPart}${target}`;
}

function assertSshIdentifier(label: string, value: string, pattern: RegExp): void {
  // Dry-run / pre-create plans use this placeholder until the provider has a real IP.
  if (label === "host" && value === "<server-ip>") return;
  if (!pattern.test(value)) throw new Error(`unsafe ssh ${label}`);
}

export function sshTunnelCommand(user: string, host: string): string {
  return `ssh -L ${DAEMON_PORT}:${DAEMON_BIND_HOST}:${DAEMON_PORT} ${user}@${host}`;
}

/**
 * Produce the ordered remote command list for an existing Ubuntu/Debian host.
 * No real SSH — pure planner for dry-run and tests.
 */
export function planSshSteps(input: SshPlanInput): DeployStep[] {
  const { user, host, sshKeyPath, tarballPath, tailscaleAuthkey } = input;
  const ssh = sshPrefix(user, host, sshKeyPath);
  const credential = input.systemdCredential;
  if (credential && !/^\/[A-Za-z0-9_./-]+$/.test(credential)) throw new Error("systemd credential must be an absolute remote path without shell or unit specifiers");
  const origin = input.publicOrigin ? canonicalHttpsOrigin(input.publicOrigin) : undefined;
  const serve = Boolean(tailscaleAuthkey || input.tailscaleServe);
  if (serve && !origin) throw new Error("Tailscale Serve requires --public-origin https://<actual-tailnet-name>.ts.net");
  if (serve && (!new URL(origin!).hostname.endsWith(".ts.net") || new URL(origin!).port)) throw new Error("Tailscale Serve requires its exact .ts.net HTTPS origin on port 443");
  const tar = tarballPath ?? "modelbot-0.0.1.tgz";
  if (!/^[A-Za-z0-9_./ -]+$/.test(tar)) throw new Error("unsafe tarball path");
  const remote = (script: string) => `${ssh} -- '${script.replaceAll("'", "'\\''")}'`;
  const unit = renderSystemdUnit({
    nodeBin: "%h/.local/bin/modelbot-node",
    modelbotBin: "%h/.local/share/modelbot/node_modules/modelbot/dist/cli/index.js",
    workingDirectory: "%h/ModelBot",
    configPath: "%h/.modelbot/modelbot.yaml",
    userService: true,
    systemdCredential: credential,
  });
  const steps: DeployStep[] = [
    {
      id: "preflight",
      summary: "Require Node >=22.18, Docker images, user systemd and the configured vault key source",
      command: remote(`set -eu
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if (major<22 || (major===22 && minor<18)) { console.error("Node >=22.18 required"); process.exit(1); }'
command -v npm >/dev/null
${credential ? `command -v systemd-creds >/dev/null; test "$(systemd --version | head -1 | cut -d " " -f 2)" -ge 257; test -r ${credential}` : "command -v secret-tool >/dev/null"}
systemctl --user show-environment >/dev/null
docker info >/dev/null
docker image inspect modelbot/computer:dev modelbot/shell:dev modelbot/proxy:dev >/dev/null`),
    },
    {
      id: "ensure-dirs",
      summary: "Create private install, config and data directories as the SSH user",
      command: remote('install -d -m 0700 "$HOME/.cache/modelbot" "$HOME/.modelbot" "$HOME/ModelBot" "$HOME/.local/share/modelbot" "$HOME/.config/systemd/user" "$HOME/.local/bin"'),
    },
    {
      id: "copy-tarball",
      summary: "Copy npm pack tarball into the private install cache",
      command: `scp -o BatchMode=yes -o StrictHostKeyChecking=yes ${sshKeyPath ? `-i '${sshKeyPath.replaceAll("'", "'\\''")}' ` : ""}'${tar.replaceAll("'", "'\\''")}' ${user}@${host}:.cache/modelbot/package.tgz`,
    },
    {
      id: "npm-install",
      summary: "Install the packed application under the SSH user's home",
      command: remote('set -eu; npm install --omit=dev --ignore-scripts --prefix "$HOME/.local/share/modelbot" "$HOME/.cache/modelbot/package.tgz"; ln -sf "$(command -v node)" "$HOME/.local/bin/modelbot-node"'),
    },
    {
      id: "init-config",
      summary: "Initialize full private config, tokens and vault; preserve existing state",
      command: remote(`set -eu; if [ ! -f "$HOME/.modelbot/modelbot.yaml" ]; then ${credential ? `systemd-run --user --wait --pipe --collect -p LoadCredentialEncrypted=modelbot-vault:${credential} ` : ""}"$HOME/.local/bin/modelbot-node" "$HOME/.local/share/modelbot/node_modules/modelbot/dist/cli/index.js" init --skip-detect --skip-images; fi; chmod 0600 "$HOME/.modelbot/modelbot.yaml"`),
    },
    {
      id: "write-systemd",
      summary: "Install private user service using the same home and keychain as initialization",
      command: `${remote('umask 077; cat > "$HOME/.config/systemd/user/modelbot.service"')} <<'EOF'\n${unit}EOF`,
    },
    {
      id: "enable-daemon",
      summary: "Start user service and verify runtime initialization via healthz",
      command: remote('set -eu; systemctl --user daemon-reload; systemctl --user enable --now modelbot.service; for attempt in $(seq 1 30); do if curl -fsS http://127.0.0.1:7777/healthz; then exit 0; fi; sleep 1; done; systemctl --user status modelbot.service; exit 1'),
    },
  ];

  if (origin) {
    const script = `const fs=require("node:fs"); const {createRequire}=require("node:module"); const requireApp=createRequire(process.env.HOME+"/.local/share/modelbot/node_modules/modelbot/package.json"); const yaml=requireApp("yaml"); const path=process.env.HOME+"/.modelbot/modelbot.yaml"; const config=yaml.parse(fs.readFileSync(path,"utf8")); config.remote.public_origin=process.argv[1]; fs.writeFileSync(path,yaml.stringify(config),{mode:0o600});`;
    steps.splice(5, 0, { id: "configure-origin", summary: "Save the exact trusted HTTPS origin, preserving existing settings",
      command: remote(`node -e '${script}' '${origin.replaceAll("'", "'\\''")}'`) });
  }
  if (serve) {
    steps.push(
      {
        id: "install-tailscale",
        summary: "Require installed Tailscale",
        command: `${ssh} -- 'command -v tailscale >/dev/null || exit 78'`,
      },
      ...(tailscaleAuthkey ? [{
        id: "tailscale-up",
        summary: "Join tailnet with one-off auth key",
        command: `${ssh} -- 'sudo tailscale up --auth-key=REDACTED --hostname=modelbot --ssh=false'`,
      }] : []),
      {
        id: "tailscale-serve",
        summary: "Verify the tailnet hostname and serve private HTTPS to loopback (no Funnel)",
        command: remote(`set -eu; tailscale status --json | node -e 'let data="";process.stdin.on("data",c=>data+=c).on("end",()=>{const actual=JSON.parse(data).Self?.DNSName?.replace(/\\.$/,"");if(actual!==process.argv[1]){console.error("public-origin does not match this Tailscale device DNS name");process.exit(1)}})' '${new URL(origin!).hostname}'; sudo tailscale serve --bg http://127.0.0.1:${DAEMON_PORT}`),
      },
    );
  } else {
    steps.push({
      id: "print-ssh-tunnel",
      summary: "Print SSH local-forward recovery command",
      command: sshTunnelCommand(user, host),
    });
  }

  return steps;
}

export function accessHintFor(
  user: string,
  host: string,
  hasTailscale: boolean,
): string {
  if (hasTailscale) {
    return `Tailscale Serve on port ${DAEMON_PORT} (private). Recovery: ${sshTunnelCommand(user, host)}`;
  }
  return sshTunnelCommand(user, host);
}

export type RemoteRunner = (step: DeployStep) => Promise<void>;

/** Executes reviewed plan steps; dry-run skips this runner. */
export const noopRemoteRunner: RemoteRunner = async (step) => {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("/bin/sh", ["-c", step.command], {
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${step.id} failed (${code})`)),
    );
  });
};

async function runTailscaleUpSecurely(
  user: string,
  host: string,
  sshKeyPath: string | undefined,
  authKey: string,
): Promise<void> {
  sshPrefix(user, host, sshKeyPath);
  const args = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    ...(sshKeyPath ? ["-i", sshKeyPath] : []),
    `${user}@${host}`,
  ];
  args.push("--", "sudo", "tailscale", "up", "--auth-key=file:/dev/stdin", "--hostname=modelbot", "--ssh=false");
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("ssh", args, { stdio: ["pipe", "inherit", "inherit"], env: process.env });
    child.stdin.end(`${authKey}\n`);
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`tailscale-up failed (${code})`)),
    );
  });
}

export class SshProvider implements DeployProvider {
  readonly name = "ssh" as const;
  private readonly home?: string;
  private readonly runner: RemoteRunner;

  constructor(opts: { home?: string; runner?: RemoteRunner } = {}) {
    this.home = opts.home;
    this.runner = opts.runner ?? noopRemoteRunner;
  }

  async plan(opts: DeployOptions): Promise<DeployStep[]> {
    const user = opts.user ?? "ubuntu";
    const host = opts.host;
    if (!host) throw new Error("ssh provider requires --host");
    return planSshSteps({
      user,
      host,
      sshKeyPath: opts.sshKeyPath,
      tarballPath: opts.tarballPath,
      tailscaleAuthkey: opts.tailscaleAuthkey,
      tailscaleServe: opts.tailscaleServe,
      publicOrigin: opts.publicOrigin,
      systemdCredential: opts.systemdCredential,
    });
  }

  async deploy(opts: DeployOptions): Promise<DeployResult> {
    const user = opts.user ?? "ubuntu";
    const host = opts.host;
    if (!host) throw new Error("ssh provider requires --host");

    const existing = loadRemoteState(opts.name, this.home);
    if (existing && existing.provider === "ssh" && existing.host === host) {
      const steps = await this.plan(opts);
      return {
        name: opts.name,
        provider: "ssh",
        dryRun: !!opts.dryRun,
        steps,
        accessHint: accessHintFor(user, host, Boolean(opts.tailscaleAuthkey || opts.tailscaleServe)),
        skippedCreate: true,
      };
    }

    const steps = await this.plan(opts);
    if (!opts.dryRun) {
      for (const step of steps) {
        if (step.id === "print-ssh-tunnel") continue;
        if (
          step.id === "tailscale-up" &&
          opts.tailscaleAuthkey &&
          this.runner === noopRemoteRunner
        ) {
          await runTailscaleUpSecurely(user, host, opts.sshKeyPath, opts.tailscaleAuthkey);
        } else {
          await this.runner(step);
        }
      }
      saveRemoteState(
        {
          name: opts.name,
          provider: "ssh",
          deploymentId: randomUUID(),
          host,
          user,
          createdAt: new Date().toISOString(),
          access: (opts.tailscaleAuthkey || opts.tailscaleServe) ? "tailscale" : "ssh",
        },
        this.home,
      );
    }

    return {
      name: opts.name,
      provider: "ssh",
      dryRun: !!opts.dryRun,
      steps,
      accessHint: accessHintFor(user, host, Boolean(opts.tailscaleAuthkey || opts.tailscaleServe)),
    };
  }

  async destroy(
    opts: DestroyOptions,
    state: RemoteState,
  ): Promise<DestroyResult> {
    const user = state.user ?? "ubuntu";
    const host = state.host ?? "unknown";
    const ssh = sshPrefix(user, host);
    const steps: DeployStep[] = [
      {
        id: "stop-unit",
        summary: "Stop and disable modelbot.service",
        command: `${ssh} -- 'systemctl --user disable --now modelbot.service'`,
      },
      {
        id: "wipe-hint",
        summary: "Remove the user service; preserve browser profiles, workspace and vault",
        command: `${ssh} -- 'rm -f "$HOME/.config/systemd/user/modelbot.service"; systemctl --user daemon-reload'`,
      },
    ];
    if (!opts.dryRun) {
      for (const step of steps) await this.runner(step);
      deleteRemoteState(opts.name, this.home);
    }
    return {
      name: opts.name,
      dryRun: !!opts.dryRun,
      steps,
      deleted: !opts.dryRun,
    };
  }
}
