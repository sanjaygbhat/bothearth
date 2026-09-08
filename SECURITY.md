# Security

BotHearth is a self-hostable agent that runs a sandboxed Linux “computer” (browser, shell, files) on infrastructure you control. This document describes the security model for operators and researchers: where code runs, what is trusted, what is gated, and what BotHearth does **not** claim to stop.

## What runs where

| Component | Location | Role |
|---|---|---|
| `modelbot` daemon | **Host** (macOS/Linux) or the VM host in remote mode — **never** inside a container it manages | Sandbox lifecycle, policy gates, vault, audit, web UI, MCP server, LLM adapters |
| Browser container | Linux container | Playwright + Chromium + browser half of computer-server; owns the profile volume |
| Shell container | Separate Linux container | Shell and file tools as uid `agent`; **workspace volume only** — no profile mount |
| Egress proxy sidecar | Dual-homed on the per-computer internal network | Only network path from sandbox containers to the public internet |
| Vault | Host only | Encrypted provider API keys and connector MCP env (vault v1) |
| Model provider / harness | You choose | BotHearth sends the task's model-visible context; native harnesses and their helpers have separate host permissions |

Trust order (highest → lowest): **operator intent and host policy** → **daemon-enforced gates** → **sandbox tools** → **page / tool / skill / MCP text and pixels** (always untrusted data).

Control plane: UI, `/api/v1/*`, and `/mcp` share **one** loopback listener (`127.0.0.1:7777` by default). Remote access is Tailscale or SSH tunnel — never a public live-view port.

## Two credentials (critical)

BotHearth splits **agent** and **operator** authority:

| Credential | Can call | Cannot call |
|---|---|---|
| `mcp_token` (`MODELBOT_TOKEN`) | `/mcp` tool invocations only | Approvals, takeover acquire/release, live WebSocket, audit read, computer create/destroy |
| UI session (HttpOnly `SameSite=Strict` cookie after one-time bootstrap **POST**; operator opens `/#bootstrap=…` fragment so the secret never becomes an HTTP query) | Human routes: approvals, takeover, live view, audit, admin | Issued to harnesses |

A model or harness that holds the MCP token **cannot** self-approve gated actions or open live frames during takeover. Mutating UI calls also require a CSRF token; WebSocket upgrades enforce Origin checks.

## Trust boundaries

1. **Host vs sandbox.** The sandbox must not see host home directories, SSH keys, OS keychain material, Docker/Podman sockets, or the vault plaintext. Guest outputs consumed by the host are treated as tainted until validated by the daemon.
2. **Per-computer isolation.** Each computer gets its own browser container, shell container, proxy, and (for named computers) profile volume. Profiles are separate per computer and retained unless explicitly removed. BotHearth does not pool cookies across computers.
3. **Browser profile vs shell.** Cookie theft is threat #1. The profile volume is mounted **only** into the browser container. File tools are path-jailed to `/workspace` (`realpath`, no symlink escape). A same-container uid split under `cap_drop: ALL` + `no-new-privileges` is **not** claimed — that design was unbuildable and is replaced by split containers.
4. **Model vs human control.** During **model-blind takeover**, in-flight agent actions drain and ordinary agent tools are blocked before the UI acknowledges human control. The authenticated operator receives an ephemeral live stream marked `human` and can relay input. Those frames are routed directly to operator WebSockets, never to MCP results, model messages, task artifacts, or audit records. Model screenshot/snapshot tools return `E_TAKEOVER_BUSY` at both boundaries. The daemon transports operator input and the visited page receives it; neither is the model.
5. **Harness vs BotHearth.** Official harnesses connect via MCP. Consumer OAuth is never replayed. **In harness mode the harness already runs as you on the host** (shell, files, often keychain-accessible process peers). Sandbox isolation protects the *computer*, not the host from the harness.
6. **Connectors.** User MCP servers run **host-side** with vault-supplied env. Treat them as trusted host code you installed; pin manifests by digest and re-consent on any byte change.

## Sandbox isolation by backend

Hardening that must fail closed when unavailable:

- Non-root; `cap_drop: [ALL]`; `no-new-privileges`; Chromium-compatible seccomp (`sandbox/seccomp-chromium.json` — Docker default **plus** userns syscalls); read-only rootfs + listed tmpfs; CPU/memory/PID limits; **no** Docker socket; no `--privileged` / host PID/network; no `--ipc=host`.
- Browser: `--shm-size=1g` (or 512m if measured); **do not** pass `--disable-dev-shm-usage`; **never** `--no-sandbox` for untrusted sites. Run `bash scripts/image-smoke.sh` to verify full Chromium launches with its sandbox enabled under the production flags. See [seccomp details](sandbox/README-seccomp.md) for the measured user-namespace requirements.
- Multi-arch: arm64 development builds; multi-architecture release validation remains a release gate. Playwright **Chromium** only (never `channel: chrome`).

| Backend | Isolation notes |
|---|---|
| **Docker / OrbStack / Colima** | Default path. Per-computer `internal: true` network; proxy is the only egress. Prefer rootless when available. |
| **Podman** | Same policy; `podman exec` transport. |
| **Remote VM + Docker** | **Same** hardened compose stack inside the guest (browser + shell + proxy). Daemon on the VM host. Access only via Tailscale or SSH — **no** PaaS templates that publish the control plane. |

Daemon↔computer transport is `docker exec` stdio JSON-RPC — no published sandbox ports, no network tokens on the computer listener.

## Credential handling

**Vault v1:** encrypted file on the host for provider API keys and connector MCP env. Key via macOS Keychain / Linux Secret Service / passphrase. Never mounted into either sandbox container. Prefer passphrase or a dedicated keychain with prompt-on-unlock over a broad `node` ACL. Do not document long-lived vault passphrases in environment variables.

**Model-blind takeover:** password fields, CAPTCHA iframes (reCAPTCHA/hCaptcha/Turnstile/Arkose), WebAuthn, and OTP-like inputs trigger takeover. MCP `request_takeover` is non-blocking and returns a **status id** to the model — not a capability-bearing URL. The operator opens the control link from the authenticated UI or a configured notify channel. Audit records `{t0,t1,frames_suppressed:true}` in the HMAC-chained log; suppression refers to model/task/audit capture, not the operator-only view. TTL expiry enters **paused**, never auto-resume to agent with capture on.

**Masking (before model-visible snapshots and screenshots):** password, OTP / `inputmode=numeric`, contenteditable secrets, strip `?token=`-class query params. Apply the same pre-capture mask set to screenshots (Playwright `mask:`), not post-blur. Resume after takeover re-masks.

**Passkeys / hardware 2FA:** generally **cannot** be completed inside a remote Linux Chromium. Prefer app-based TOTP entered during takeover. BotHearth does not ship a virtual authenticator that would turn a phishing-resistant factor into a software secret beside the agent.

## Network egress policy

- Sandbox containers sit on an **internal** network with **no** direct default route to the internet.
- A **sidecar proxy** is the only exit. It blocks loopback, RFC1918/private ranges, link-local, and cloud metadata (`169.254.169.254` and IPv6 analogs).
- **No TLS MITM.** Domain/SNI/DNS policy only.
- Chromium is launched with an explicit `--proxy-server`; env `HTTP(S)_PROXY` is advisory for shell tools, not the containment control. Route absence is the control.
- Docs describe this as **best-effort domain policy, not a firewall**, until bypass tests (raw TCP/UDP/IPv6/DoH/DNS-label exfil) pass.
- Agent top-level navigation to undeclared destinations is blocked before contact, including clicks, keyboard/coordinate actions and server redirects. `supervised` requests `new_domain` consent for that task; `strict` denies. Domain consent adds read access, not permission to submit forms or send data. Subresources and iframe traffic remain subject to the proxy policy above.
- Initial agent popups are blocked; use `browser_tabs new` or `browser_navigate` for an inspectable destination. Human takeover navigation is exempt. Service workers are disabled so they cannot bypass browser request interception.
- Notification text is length-capped and URL-stripped — notify is host-side egress outside the proxy.

**Access-log retention.** The proxy records destination host:port, allow/deny, and bytes — not URL path or query (CONNECT: host only). Verbose debug is `PROXY_ACCESS_LOG_VERBOSE=1` (off by default). Logs are size-capped (1 MiB in-container ring on tmpfs; Docker json-file 1m×3). Purge by destroying/recreating the proxy container; there is no `bothearth audit purge`. `GET /dnsz` (looked-up names) is off unless `PROXY_DNSZ=1` and is served only to loopback — never a production retention sink. Details: [PRIVACY.md](./PRIVACY.md).

## Prompt injection and action gating

Every webpage, email, document, tool result, download, skill, and MCP description is **attacker-controlled data**. Defenses are layered; none are complete.

1. **Provenance:** tool/page results wrapped as untrusted data with per-message nonce fences; system/operator policy outranks page text.
2. **Deterministic gates at the daemon tool boundary** (never “the model promised to ask”): external send, purchase/payment, upload, delete, secret entry, new domain; kill switch. Equivalent primitives (click / press / coordinates / JS) share one gate. Approvals bind `{task_id, control_epoch, origin, action_hash, expires}` and re-verify at dispatch.
3. **Force-human categories** shipped as `policy/categories.json` (banking/brokerage/crypto transfer, password managers, government ID portals, email/account security settings, domain registrars) — user-editable.
4. **Observed-signal takeover:** password field, WebAuthn, captcha iframe origins.
5. **Task limits:** max steps (default 400), loop/stall detection, and the usage meter (default `$20`, default ceiling `$100`) can pause a task. Harness usage is a tool-call estimate; API usage uses configured estimates. These are not provider-enforced spending caps, and an in-flight request can exceed an estimate.

Action classification uses observed signals and cannot recognize every possible effect of a page, script, or authorized connector. Ordinary interactions on approved sites and `write_file` to the task workspace can proceed without another prompt. A local policy approval does not establish authorization under a site's terms or the rights of people whose data is involved.

## What BotHearth does NOT protect against

- Hypervisor / container-runtime zero-days, and mounts or privileges the operator deliberately adds.
- A **live authenticated browser** misusing an already-logged-in session under prompt injection — secrets may stay hidden while the session is still abused.
- Credentials typed into **chat** or pasted where the model can read them.
- The **destination site**, browser process, and network path during takeover (model-blind ≠ page-blind).
- Provider-side retention for whatever subset you send to a remote model.
- Supply-chain compromise of pinned skills/MCP servers or signing keys.
- Humans approving deceptive confirmation previews; some actions are irreversible.
- Anti-bot blocks, account bans, or third-party ToS enforcement.
- Absolute prompt-injection immunity.
- **Harness-mode host compromise** — if the harness can run shell on your account, it is already outside the sandbox boundary.
- Passkey/hardware WebAuthn inside the sandbox computer.

## Safe-usage guidance

- Prefer **dedicated** accounts for agent browsing; do not mount your everyday Chrome profile.
- Prefer **app-based TOTP** during model-blind takeover; do not expect passkeys to work in the sandbox.
- Avoid standing access to banking, brokerage, tax, medical, password-manager, or cloud-console sessions unless you stay present.
- Keep shell off unless the task needs it; never expose the Docker socket.
- Remote deploy: Tailscale or SSH only; confirm no public UI bind; do not use PaaS “one-click” templates for the sandbox.
- Pin MCP/skill digests; re-approve on schema/description change.
- Set spend caps; stop on loop/stall.
- Run `bothearth audit verify` after sensitive tasks; treat unmarked capture gaps as a bug.

## Reporting vulnerabilities

1. Email [Sanjay Bhat](mailto:sanjaygbhat@gmail.com) with the subject `ModelBot security report`, or use **GitHub Security Advisories** when private reporting is enabled on the public repository. Send a short impact summary first; agree on a safe way to transfer sensitive reproduction data.
2. Include: BotHearth version/commit, host OS, container runtime, reproduction steps, and impact.
3. Allow a reasonable window for a fix before public disclosure. This repository is pre-release; include the exact commit in reports. There is no security certification, guaranteed response time, or paid support SLA.

Do **not** open a public issue that includes exploit details for unpatched vulnerabilities.

## Related docs

- [PRIVACY.md](./PRIVACY.md) — data residency, retention, purge
- [Release verification](docs/SECURITY-CHECKLIST.md) — checks to record for the released revision
- [Architecture](docs/ARCHITECTURE.md) — current component and data flow
