/**
 * Shared cloud-init renderer.
 *
 * REMOTE-DEPLOY §4 still shows a Docker-run UI on :3000 — superseded by
 * ARCHITECTURE / DECISIONS R2: host-side daemon on 127.0.0.1:7777, sandbox
 * containers only, never public UI ports. No long-lived secrets in user_data;
 * Tailscale key is injected later over SSH (ssh provider steps).
 *
 * Digest-pin note: curl|sh Docker/Tailscale installers are placeholders —
 * pin by digest before production ship.
 */

import { DAEMON_BIND_HOST, DAEMON_PORT } from "./types.ts";

export interface CloudInitParams {
  /** Distro family for Docker apt repo path. */
  distro?: "ubuntu" | "debian";
  /** Placeholder image tag for digest-pin notes in unit comments. */
  version?: string;
  hostname?: string;
}

/**
 * Render cloud-config YAML for Hetzner user_data / generic bootstrap.
 * Installs ca-certificates, curl, Docker; prepares dirs; does NOT start
 * modelbot (ssh provider installs Node + npm pack + systemd).
 */
export function renderCloudInit(params: CloudInitParams = {}): string {
  const distro = params.distro ?? "ubuntu";
  const version = params.version ?? "0.0.1";
  const hostname = params.hostname ?? "modelbot";
  const dockerSuite =
    distro === "debian"
      ? "linux/debian"
      : "linux/ubuntu";

  return `#cloud-config
hostname: ${hostname}
package_update: true
packages:
  - ca-certificates
  - curl
  - gnupg
write_files:
  - path: /etc/modelbot/README.deploy
    permissions: '0644'
    content: |
      ModelBot remote bootstrap.
      Daemon binds ${DAEMON_BIND_HOST}:${DAEMON_PORT} only — never publish UI ports.
      Installer scripts below are digest-pin TODO before production:
      - Docker: https://download.docker.com/linux/${distro === "debian" ? "debian" : "ubuntu"}/gpg
      - Node 22: nodesource setup_22.x (replace with digest-pinned node binary)
      - Tailscale: https://tailscale.com/install.sh (pin digest; one-off auth key via SSH)
      Image/version placeholder: ${version}
runcmd:
  - install -m 0755 -d /etc/apt/keyrings /var/lib/modelbot /etc/modelbot
  - curl -fsSL https://download.docker.com/linux/${distro === "debian" ? "debian" : "ubuntu"}/gpg -o /etc/apt/keyrings/docker.asc
  - chmod a+r /etc/apt/keyrings/docker.asc
  - 'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/${dockerSuite} $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list'
  - apt-get update
  - apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  - systemctl enable --now docker
`;
}

/** Build systemd unit body for host daemon (bound loopback). */
export function renderSystemdUnit(opts: {
  nodeBin?: string;
  modelbotBin?: string;
  workingDirectory?: string;
  configPath?: string;
  userService?: boolean;
  systemdCredential?: string;
} = {}): string {
  const nodeBin = opts.nodeBin ?? "/usr/bin/node";
  const modelbotBin = opts.modelbotBin ?? "/usr/lib/node_modules/modelbot/dist/cli/index.js";
  const cwd = opts.workingDirectory ?? "/var/lib/modelbot";
  const configPath = opts.configPath ?? "/etc/modelbot/modelbot.yaml";

  return `[Unit]
Description=ModelBot daemon
${opts.userService ? "After=default.target" : "After=network-online.target docker.service\nWants=network-online.target\nRequires=docker.service"}

[Service]
Type=simple
UMask=0077
Restart=always
RestartSec=5
WorkingDirectory=${cwd}
Environment=MODELBOT_HOST=${DAEMON_BIND_HOST}
Environment=MODELBOT_PORT=${DAEMON_PORT}
${opts.systemdCredential ? `LoadCredentialEncrypted=modelbot-vault:${opts.systemdCredential}` : ""}
Environment=MODELBOT_CONFIG=${configPath}
${opts.userService ? "Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus\n" : ""}# Never bind 0.0.0.0 — UI/MCP stay on loopback; reach via Tailscale Serve or SSH -L
ExecStart=${nodeBin} ${modelbotBin} start --host ${DAEMON_BIND_HOST} --port ${DAEMON_PORT}
ExecStop=/bin/kill -s TERM $MAINPID

[Install]
WantedBy=${opts.userService ? "default.target" : "multi-user.target"}
`;
}
