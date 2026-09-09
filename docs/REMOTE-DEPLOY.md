# Remote deployment

The daemon runs on the Linux host; browser, optional shell, and proxy run in containers. UI and MCP stay on `127.0.0.1:7777`. Reach them through SSH or private HTTPS. A VPS runs the daemon and browsers independently of the laptop; phones require their own private-network connection. See the [remote client contract](REMOTE-CLIENT.md).

**Validation:** a real Debian 13 x86-64 VM trial is in progress. It exposed fixes for the version check, credential ACL handling and retry after a failed vault initialization. The user-service credential path failed on systemd 257.13; a non-root system service with a root-managed encrypted credential started successfully. This does not validate an unattended one-command installation, Secret Service unlock or other CPU architectures.

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

Inspect logs on the remote host with `journalctl --user -u modelbot.service`. Bootstrap URLs are operator credentials; protect access to those logs. BotHearth configuration is under `~/.modelbot`, data normally under `~/ModelBot`, and the unit under `~/.config/systemd/user/modelbot.service`.

## Connect privately

```bash
ssh -N -L 7777:127.0.0.1:7777 modelbot@vm.example.com
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

`deploy hetzner --dry-run` previews cloud and SSH steps. Creating a VM is a paid action. The cloud bootstrap installs Docker; the prepared-host Node, images, user-session, and vault prerequisites above still apply. A newly created headless VM does not automatically satisfy them. This path is not validated as an unattended one-command installation.

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

## Provider login on the VPS

Use the provider CLI's official login on the VPS under the service account; never copy a laptop's authentication files or pool users' credentials. For Codex without a browser callback, the [official authentication guide](https://learn.chatgpt.com/docs/auth) recommends `codex login --device-auth` (beta). Device-code login must be enabled in the user's ChatGPT security settings or workspace permissions. Complete only the official verification page and one-time code, then run `codex login status`. If that flow is unavailable, the documented SSH forwarding of the localhost callback is an alternative; do not invent a token exchange.

On an instance with `remote.public_origin`, Settings starts the installed Codex CLI's official device flow after an explicit **Sign in with ChatGPT** click. Only the initiating operator session can see the bounded one-time code and fixed official verification link; cancellation, sign-out, revocation, session expiry or daemon shutdown ends the owned login process. The code expires within ten minutes and is never saved in BotHearth's database or audit. The CLI retains its own native authentication state and logs. Unrecognized CLI output fails closed; use the native server terminal if the CLI changes its prompt or device login is unavailable.

For a signed-out remote Claude Code instance, Settings offers **Check again** and instructs you to run `claude auth login` in the server's own terminal first. Follow [Claude Code's official SSH/container authentication instructions](https://code.claude.com/docs/en/authentication); BotHearth does not relay Claude browser codes or collect tokens. Already configured native subscription, Console, or supported cloud authentication remains owned by Claude Code. Local desktop installations retain the normal native browser login action.

Credentials remain owned by the native provider CLI. Select the same existing login in BotHearth Settings; model availability and subscription limits remain provider-controlled. Installing a binary or receiving exit code zero is not sufficient proof of a working browser task.

## Acceptance before relying on a remote instance

Local tests cover real HTTPS/WSS session exchange and revocation, immutable origin/device authority, daemon restart, inherited idle pause, cancellation, and encrypted-vault reopen with the protected credential file. The deployment planner is syntax checked and validates the prepared-host prerequisites. These checks do **not** establish real VPS cold boot, systemd credential decryption on every distribution, off-LAN cellular reachability, or iOS/Android background delivery.

On the chosen VPS, verify the installed images match the application revision, complete a harmless task, turn off the laptop and use the phone over cellular, acquire/return HUMAN control, revoke a second device, restart the service and finally reboot the host. Confirm the same browser profile survives, stale input is rejected, HUMAN remains private, and all public ports remain closed. Do not replay a failed task with external side effects merely to test connectivity.
