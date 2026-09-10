# Remote deployment

The daemon runs on the Linux host; the browser, stock Codex/Claude Code CLI, shell and proxy run in containers. UI and MCP stay on `127.0.0.1:7777`. Reach them through SSH or private HTTPS. A VPS runs new native tasks independently of the laptop once its computer’s model connection is configured; phones require their own private-network connection. See the [remote client contract](REMOTE-CLIENT.md).

A manually connected harness running on your laptop still needs that laptop and its connection. Historical host sessions retain their original execution location and login. Fresh headless-host preparation requires system administration; plan for platform-specific setup.

Check `systemctl --version` on the host before choosing its setup path:

| Host setup | Supported path |
|---|---|
| Linux desktop with an unlocked Secret Service keyring | `deploy ssh` below. |
| Headless Linux with systemd 258 or newer and a running user manager | Prepare the encrypted user credential below, then use `deploy ssh --systemd-credential PATH`. |
| Headless Linux with older systemd | Use the administrator-managed [system-service setup](#system-service-alternative-tested-on-debian-13). `deploy ssh` does not install a system service. |

The distinction comes from systemd: encrypted credentials for **user** services were added in [version 258](https://github.com/systemd/systemd/blob/v258/NEWS); older versions support the **system** service path. Installing `secret-tool` alone does not create an unlocked desktop keyring. The SSH preflight now reports the missing prerequisite before copying or changing an installation; it never falls back to a plaintext key.

## Prepare the host

Use a dedicated SSH account with:

- Node.js 22.18 or newer and npm on its path.
- Docker Engine from its supported upstream packages and the three images already built/loaded for the host architecture: `modelbot/computer:dev`, `modelbot/shell:dev`, `modelbot/proxy:dev`.
- A running systemd user manager and either an unlocked Linux Secret Service accessible through `secret-tool`, or the encrypted systemd credential setup below. BotHearth does not write a plaintext vault master key into the unit.
- `curl`, a verified SSH host key, and enough disk/memory for Chromium. Enable user lingering if the service must survive logout, according to your host's account policy.

Build images from the same revision as the packed application using [QUICKSTART.md](QUICKSTART.md). On Linux, run `bash scripts/image-smoke.sh` before deployment. Debian 13’s Docker 26.1.5 package was observed to deny Chromium user-namespace creation through its `docker-default` AppArmor profile despite the correct seccomp rules. Use [Docker’s supported Debian installation](https://docs.docker.com/engine/install/debian/) and verify the smoke check on your kernel; do not disable AppArmor globally or add `--no-sandbox`. The npm tarball contains the daemon and runtime assets; it is not an image build context. Development tags must be replaced with verified release digests before a production security audit can pass.

## Preview and deploy to a prepared SSH host

```bash
npm pack
node dist/cli/index.js deploy ssh --name remote \
  --host vm.example.com --user modelbot \
  --ssh-key /absolute/path/to/id_ed25519 \
  --tarball modelbot-0.0.1.tgz --dry-run
```

Review the printed steps, then remove `--dry-run` to execute them. Use the tarball filename actually produced by `npm pack`.

The deployment checks prerequisites, copies the package into a private cache, installs it under `~/.local/share/modelbot`, initializes a full private config/vault/token set if absent, and starts a systemd **user** service. Existing configuration and vaults are preserved. The service uses the same account and keychain as initialization and must pass `/healthz` before deployment succeeds.

Running the same deployment again installs the new package and restarts the service. Finish current tasks before updating an older installation: older releases cancel active tasks on shutdown. Current native Codex and Claude tasks pause with their conversation saved; review the page and choose **Resume** after restarting. An interrupted browser action may already have reached the website, so check before repeating it. Reusing a deployment name for a different SSH target is refused.

Inspect logs on the remote host with `journalctl --user -u modelbot.service`. Bootstrap URLs are operator credentials; protect access to those logs. BotHearth configuration is under `~/.modelbot`, data normally under `~/ModelBot`, and the unit under `~/.config/systemd/user/modelbot.service`.

## Connect privately

```bash
ssh -N -o ExitOnForwardFailure=yes -i /absolute/path/to/id_ed25519 \
  -L 7777:127.0.0.1:7777 modelbot@vm.example.com
```

Open the remote daemon's bootstrap URL through the local tunnel. If local port 7777 is occupied, stop the local daemon first or configure an allowed host/port pair deliberately. Never expose the live-view port publicly.

For access from a phone while the laptop is off, install and authenticate Tailscale on the VPS **and** phone. Enable MagicDNS/HTTPS, approve only your devices, and restrict tailnet access to the operator and this service. Use a neutral device name: public certificate-transparency records can reveal HTTPS certificate hostnames. Serve is private to your tailnet; do not enable Funnel. Tailscale is a separate service/account: its [Personal plan is for non-commercial use](https://tailscale.com/pricing); check the current business plan and terms for commercial deployments.

For an already joined VPS, obtain its actual `Self.DNSName` from `tailscale status --json`, then preview:

```sh
bothearth deploy ssh --name remote --host vm.example.com --user modelbot \
  --tarball modelbot-0.0.1.tgz --tailscale-serve \
  --public-origin https://modelbot.example.ts.net --dry-run
```

The reviewed plan saves `remote.public_origin`, verifies it matches this device's actual tailnet hostname, and runs `sudo tailscale serve --bg http://127.0.0.1:7777`. This follows the [official Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve). The proxy must preserve Host and support WSS; BotHearth does not infer identity from forwarded headers. No browser, debugging, Docker or daemon port should be exposed publicly. Verify the provider firewall separately.

For explicit enrollment of a not-yet-joined host, `--tailscale-authkey-file` accepts a mode-0600 file and transmits the one-off key over SSH stdin; it also requires `--public-origin`. Never embed keys in arguments, cloud-init or source control. Tailnet membership and HTTPS authorization may require normal administrator actions before Serve succeeds. This installer does not purchase a plan, create an account, change ACLs, or enable public Funnel.

On the desktop dashboard, choose **Settings → Connected devices → Connect a device**. Open its one-use link through the canonical HTTPS origin on the phone, or paste it into a [native client](../mobile/README.md). The laptop is no longer the network gateway. Device pairing grants full operator access. Use **Revoke** in Settings for a lost device. The advanced CLI equivalents are `bothearth pair`, `bothearth pair --list` and `bothearth pair --revoke DEVICE_ID`. Revocation preserves tasks, browser profiles and HUMAN privacy state.

## Cloud provisioning and removal

`deploy hetzner --dry-run` previews cloud and SSH steps. Creating a VM is a paid action. Make cloud provisioning scripts idempotent or remove a completed one-time startup script before reboot: rerunning a distro-package install can replace a deliberately upgraded Docker Engine. The cloud bootstrap installs Docker; the prepared-host Node, images, user-session, and vault prerequisites above still apply. A newly created headless VM does not automatically satisfy them. This path is not validated as an unattended one-command installation.

`deploy destroy <name> --dry-run` previews removal. For SSH deployments, destruction stops/removes the user service and preserves workspace, profile, and vault data. For a managed cloud deployment, destruction can delete the VM. Read [PRIVACY.md](../PRIVACY.md) before removing data or backups.

## Headless vault across host restart

The existing Secret Service path remains supported. For a dedicated host without an unlocked desktop keyring, the optional encrypted-credential path requires **systemd 258 or newer**, a working user service manager and user-scoped encrypted credentials. A real Debian 13 trial on systemd 257.13 could encrypt the credential but its user service failed to decrypt it with `243/CREDENTIALS`; the old version-only preflight was insufficient. Do not weaken credential-file permissions to work around that failure. It uses `LoadCredentialEncrypted=modelbot-vault:PATH`; the daemon reads only the named private runtime credential, never a plaintext key embedded in a unit or process argument. See [systemd credentials](https://systemd.io/CREDENTIALS/) and [systemd-creds](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html).

Prepare a **new instance** as its dedicated account. Generate the key on that VPS, piping directly into systemd encryption; do not overwrite an existing credential:

```sh
install -d -m 0700 "$HOME/.config/modelbot"
test ! -e "$HOME/.config/modelbot/vault.cred" && \
  (umask 077; openssl rand -hex 32 | systemd-creds encrypt --user --with-key=host --name=modelbot-vault - "$HOME/.config/modelbot/vault.cred")
```

Add `--systemd-credential /home/modelbot/.config/modelbot/vault.cred` to the SSH deploy preview. Initialization runs in a transient user unit with the same encrypted credential as the persistent service. The plan checks the minimum version and runs a transient user unit with the encrypted credential before installation; an actual decrypt/start must succeed on that host. Never use `--with-key=null`. This command deliberately uses systemd’s protected host secret and user/machine binding, so it does not require a TPM or promise hardware binding. Root or a compromised service account can access runtime secrets; this is not protection from the machine's administrator.

Enable user lingering using the host administrator's normal `loginctl enable-linger modelbot` policy so the user service survives logout and starts at boot. Verify a real reboot with SSH disconnected before relying on unattended operation. Back up the encrypted vault and the required host/user credential recovery material securely; replacing a host can make a machine-bound credential undecryptable. Existing vault migration and automatic credential rotation are not provided: a mismatched key fails closed, and the vault rotate action refuses to silently change a key that systemd cannot persist.

## System-service alternative tested on Debian 13

On systemd 257, an administrator can instead use a **system** unit that executes as the dedicated `modelbot` account. This is a manual host-administration path; the `deploy ssh` command above creates a user service and does not install this unit.

After installing Node, the same application revision and images, generate a **new** encrypted credential as root (never overwrite a credential belonging to an existing vault):

```sh
sudo install -d -m 0700 /etc/credstore.encrypted
sudo sh -c 'test ! -e /etc/credstore.encrypted/modelbot.vault && umask 077 && openssl rand -hex 32 | systemd-creds encrypt --with-key=host --name=modelbot-vault - /etc/credstore.encrypted/modelbot.vault'
```

Initialize once under the same service identity and credential. Paths below assume a dedicated `modelbot` account and Node installed in `/usr/local/bin`; adjust to the prepared host. Do not add `--force` to an existing installation:

```sh
sudo systemd-run --wait --pipe --collect --uid=modelbot \
  --setenv=HOME=/home/modelbot --setenv=PATH=/usr/local/bin:/usr/bin:/bin \
  -p LoadCredentialEncrypted=modelbot-vault:/etc/credstore.encrypted/modelbot.vault \
  /usr/local/bin/node /home/modelbot/.local/share/modelbot/node_modules/modelbot/dist/cli/index.js \
  init --skip-detect --skip-images --port 7777
```

Create `/etc/systemd/system/modelbot.service` as an administrator:

```ini
[Unit]
Description=BotHearth
After=network-online.target docker.service
Requires=docker.service

[Service]
User=modelbot
Group=modelbot
SupplementaryGroups=docker
UMask=0077
WorkingDirectory=/home/modelbot/ModelBot
Environment=HOME=/home/modelbot
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=MODELBOT_CONFIG=/home/modelbot/.modelbot/modelbot.yaml
LoadCredentialEncrypted=modelbot-vault:/etc/credstore.encrypted/modelbot.vault
ExecStart=/usr/local/bin/node /home/modelbot/.local/share/modelbot/node_modules/modelbot/dist/cli/index.js start --host 127.0.0.1 --port 7777 --no-open
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Run `sudo systemctl daemon-reload` and `sudo systemctl enable --now modelbot.service`, then check loopback `/healthz` and the private SSH connection. Protect `journalctl -u modelbot.service`: bootstrap links grant operator access. Root manages the decrypted credential's ACL; do not change it to world-readable or copy its plaintext into an environment file. Docker-group access grants substantial host authority despite the daemon's non-root UID. A successful start is not a substitute for an actual reboot and harmless browser task on your chosen host.

Run diagnostics with that same service identity and encrypted credential. A plain SSH shell does not inherit the service's vault access:

```sh
sudo systemd-run --wait --pipe --collect --uid=modelbot \
  --setenv=HOME=/home/modelbot --setenv=PATH=/usr/local/bin:/usr/bin:/bin \
  -p LoadCredentialEncrypted=modelbot-vault:/etc/credstore.encrypted/modelbot.vault \
  /usr/local/bin/node /home/modelbot/.local/share/modelbot/node_modules/modelbot/dist/cli/index.js doctor
```

If vault access fails after a service change, restore its original credential and permissions. Do not reset the vault merely because the diagnostic shell lacks the key. BotHearth reports unavailable headless key sources without offering a destructive key reset.

## Provider login on the VPS

Open **Settings → Model connection** on the remote instance. BotHearth prepares its computer and runs the provider’s official login inside it; it does not copy a laptop or host login. Codex uses its [official device flow](https://learn.chatgpt.com/docs/auth) after **Sign in with ChatGPT**. Device login must be allowed by the account/workspace. Claude Code uses `claude auth login`; Settings shows its private output and reply field. Follow the [official authentication instructions](https://code.claude.com/docs/en/authentication) and enter replies only in that sign-in panel, not task chat.

Only the initiating operator session receives sign-in output. Cancellation, sign-out, revocation, expiry or daemon shutdown ends the owned login process. Codes/replies are not saved in task history or audit. The CLI retains its own authentication and history in the computer’s persistent model-home volume. Historical host tasks continue using their original host CLI and login rather than migrating credentials. Model availability and subscription limits remain provider-controlled; a successful login alone does not prove a working task.

Use the same Home controls as a local installation: select the provider/model, leave **Use subagents** unchecked for direct execution, and start a small task with a verifiable saved file. **Take control** operates the remote computer’s full desktop, including Terminal and Files. Connecting to the VM does not give the model access to your laptop’s desktop or transfer your laptop’s provider login.

## Acceptance before relying on a remote instance

Local tests cover real HTTPS/WSS session exchange and revocation, immutable origin/device authority, daemon restart, inherited idle pause, cancellation, and encrypted-vault reopen with the protected credential file. The deployment planner is syntax checked and validates the prepared-host prerequisites. An earlier Debian VM trial covered reboot and system-service credentials using a laptop-side model harness. Subsequent local verification covered authenticated Codex execution inside a computer and full desktop handback. That does not establish the combined workflow on a fresh remote VM, systemd credential decryption on every distribution, uninterrupted browser/model sessions, off-LAN cellular reachability, or iOS/Android background delivery.

On the chosen VPS, verify the installed images match the application revision, complete a harmless task, turn off the laptop and use the phone over cellular, acquire/return HUMAN control, revoke a second device, restart the service and finally reboot the host. Confirm the same browser profile survives, stale input is rejected, HUMAN remains private, and all public ports remain closed. Do not replay a failed task with external side effects merely to test connectivity.
