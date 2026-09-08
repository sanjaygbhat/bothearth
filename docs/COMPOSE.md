# Running BotHearth with Docker Compose

BotHearth splits responsibility between a **host daemon** and a **per-computer container stack**. The daemon (started with `node dist/cli/index.js start` or `bothearth start`) always runs on the host machine — macOS, Linux, or a remote VM. It is never packaged as a Compose service. Compose only brings up the sandbox “computer”: an egress proxy, a hardened browser container, and a hardened shell container.

This document explains how to use the product Compose file (`docker-compose.yml` at the repository root), what runtime you need, and how to run the same stack on a Linux VM.

## What Compose starts (and what it does not)

| Piece | Where it runs | Role |
|---|---|---|
| `proxy` | Container (dual-homed) | Only route from the internal network to the internet |
| `browser` | Container (internal network) | Playwright / Chromium + computer-server; owns the profile volume |
| `shell` | Container (internal network) | Agent shell; workspace bind only — **no** profile volume |
| `modelbot` daemon | **Host process** | Lifecycle, MCP, web UI, policy, audit on `127.0.0.1:7777` |

The browser and shell sit on an `internal: true` Docker network, so they have no direct route to the internet. The proxy attaches to both the internal network and an egress network. Hardening flags (read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, memory/CPU/pids limits, Chromium seccomp profile, `/dev/shm` size on the browser) match the programmatic Docker path in `src/sandbox` exactly.

The daemon talks to containers with `docker exec` (stdio JSON-RPC). No ports are published from the sandbox, and the Docker socket is never mounted into any container.

## Requirements

You need a container runtime that understands Compose v2 (`docker compose`):

- **Docker Desktop** (macOS / Windows)
- **OrbStack** (macOS, preferred when available)
- **Colima** (macOS / Linux)
- **Docker Engine** on Linux
- **Podman** with `podman compose` / Docker-compatible CLI (experimental for BotHearth; prefer Docker Engine on Linux VMs for MVP)

Also required:

- Node.js ≥ 22.18 on the **host** (daemon and CLI)
- Built (or pulled) images: `modelbot/computer:dev`, `modelbot/shell:dev`, `modelbot/proxy:dev`
- The Chromium seccomp profile at `sandbox/seccomp-chromium.json` (referenced relatively from the Compose file)

Disk and RAM: plan for roughly 2 GiB for the browser cgroup (including 1 GiB shm) plus ≤512 MiB for the shell and a small proxy. Keep host free space comfortable before building images.

## Quick start on a laptop

Follow [QUICKSTART.md](QUICKSTART.md) to build the CLI, initialize private state, and build images first. `modelbot` below means `node dist/cli/index.js` from that checkout.

From the repository root, after images exist:

```bash
export COMPUTER_NAME=demo
export WORKSPACE="$HOME/ModelBot/computers/demo/workspace"
export INTERNAL_SUBNET=10.233.77.0/24
export INTERNAL_PROXY_IP=10.233.77.2
mkdir -p -m 700 "$WORKSPACE"
export WORKSPACE_GID=$(id -g)
chgrp "$WORKSPACE_GID" "$WORKSPACE"
chmod 770 "$WORKSPACE"

docker compose -f docker-compose.yml -p "modelbot-${COMPUTER_NAME}" up -d
```

Or use the CLI, which sets the same env and project naming:

```bash
bothearth computer create demo --compose
```

Then start the daemon on the host (not in Compose):

```bash
node dist/cli/index.js start
# health check
curl -fsS http://127.0.0.1:7777/healthz
```

Tear down the sandbox stack:

```bash
bothearth computer destroy demo --compose
# or
docker compose -f docker-compose.yml -p "modelbot-${COMPUTER_NAME}" down
```

Pass `--wipe-profile` on destroy if you also want the named profile volume removed.

## Environment variables

| Variable | Meaning |
|---|---|
| `COMPUTER_NAME` | Short id (lowercase, `[a-z0-9_-]`, ≤48). Used in container, network, and volume names |
| `WORKSPACE` | Absolute host path bind-mounted at `/workspace` in browser and shell |
| `WORKSPACE_GID` | Shared workspace group; CLI uses its actual GID, manual setup uses the owner's group |
| `INTERNAL_SUBNET` | Per-computer `10.233.<octet>.0/24`. The CLI allocates a free octet and persists it; do not reuse one `/24` across computers |
| `INTERNAL_PROXY_IP` | Proxy address on that subnet (`.2`). Must match `INTERNAL_SUBNET` |

Optional image overrides are not wired as Compose env vars in MVP; rebuild or retag `modelbot/*:dev` instead.

## Hardening summary

- Browser and shell: `read_only`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`
- Browser only: `shm_size: 1g`, seccomp profile `sandbox/seccomp-chromium.json`, profile named volume at `/home/browser/profile`
- Shell: workspace bind only — profile volume is never attached
- Networks: per-computer `internal` (`internal: true`) + `egress`; proxy on both
- No published ports; no `docker.sock` mounts; daemon never joins the sandbox networks

Treat domain allow/deny on the proxy as **best-effort domain policy, not a firewall**.

## Running on a Linux VM

Remote mode uses the **same** Compose file and the same host-daemon model on the guest:

1. Provision a Linux VM (generic SSH, or a cloud provider). Install Docker Engine + the Compose plugin, and Node ≥ 22.18.
2. Clone or copy BotHearth onto the VM; build or load the three images.
3. Create the computer with Compose (`bothearth computer create <name> --compose` or the `docker compose` commands above).
4. Run `bothearth start` on the VM host so `/healthz` listens on loopback.
5. Reach the UI/MCP privately with Tailscale or an SSH tunnel. Do **not** publish the daemon on a public interface.

See [REMOTE-DEPLOY.md](REMOTE-DEPLOY.md) for deployment prerequisites and unverified remote integration limits.

## Why the daemon stays on the host

Putting the control plane in a container would tempt mounting the Docker socket or publishing management ports into the sandbox network. BotHearth keeps lifecycle, policy, audit, MCP, and the web UI on the host (or VM host) so the sandbox never holds the keys to create more containers or to reach the control plane over the network. Compose is only an alternative wiring for the three sandbox containers — equivalent to `bothearth computer create` without `--compose`, which uses the Docker CLI directly from `src/sandbox`.
