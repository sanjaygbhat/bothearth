# BotHearth engineering security review — 9 September 2026

**Status:** four issues fixed; the recorded checks below passed on public commit [`629b569539106e0283b5101776c9aba1a76370af`](https://github.com/sanjaygbhat/bothearth/commit/629b569539106e0283b5101776c9aba1a76370af). This is an internal, AI-assisted engineering review, not an independent penetration test, certification or guarantee that no vulnerabilities remain. Later changes are not covered automatically.

## Scope and findings

Source review focused on operator/MCP authentication, session and origin validation, approvals, human-control gates, container configuration, network destination policy, workspace/file boundaries, vault key handling, audit records, remote deployment planning and enterprise/contact handling. It did not inspect every line or all possible deployment configurations.

| Finding | Exposure and evidence | Change |
| --- | --- | --- |
| Malformed standalone MCP request could terminate the listener | A reachable local MCP listener could encounter an uncaught asynchronous URL/Host parsing rejection before authentication. A real HTTP child-process regression reproduced the failure. | Shared parsing returns 400; standalone dispatch catches failures without exposing internals. |
| MCP POST bodies had no cumulative size limit | An authenticated client could cause excessive buffering through fixed-length or chunked requests. Regressions demonstrated missing 413 handling. | Both mounted and standalone handlers enforce a 1 MiB cumulative limit. |
| `www` approval aliases relied on an incomplete suffix list | Consent for a host such as `www.co.il` or `www.appspot.com` could be expanded incorrectly across a registry boundary. Regression cases failed before the fix. | Use the installed public/private suffix parser, retaining conservative historical boundaries. |
| Artifact downloads buffered whole files on the host | A guest-created large artifact could force a large host allocation when downloaded. Found by source inspection; no host OOM was induced. | Stream with backpressure and a bound based on the opened file size; handle empty files, HEAD and disconnected clients. Tests cover an 8 MiB artifact and an aborted download. |

No new runtime dependency was introduced by these fixes. Vulnerability reporting is available through [GitHub's private reporting form](https://github.com/sanjaygbhat/bothearth/security/advisories/new). Do not publish credentials or unpatched exploit details in public issues.

## Recorded checks

| Check | Result |
| --- | --- |
| Isolated unit suite after fixes | 1,222 passed, 5 skipped, 0 failed (1,227 total). The five skips require host Chromium, unavailable in that local checkout. |
| Contract suite | 29 passed, 0 failed. |
| Typecheck and build | Root typecheck/build passed; computer-server typecheck passed. |
| Lint | Passed, zero warnings after correcting ignore patterns. |
| npm advisory scans | Zero known advisories reported for the root and computer-server lockfiles at review time. This does not cover unknown vulnerabilities or OS/Chromium packages. |
| Fresh Linux container integration suite | 9 passed, 0 failed. |
| Browser/shell image checks | Chromium sandbox, non-root execution, read-only root filesystem and browser-profile separation checks passed. |
| Network egress probes | 21 passed, 0 failed, 0 skipped: permitted HTTPS, metadata/private-address rejection, direct TCP/UDP/IPv6 restrictions, DNS sinkholing, CONNECT port restrictions and shell boundaries. |

Public receipts: [normal CI](https://github.com/sanjaygbhat/bothearth/actions/runs/34314879035), [container and network security checks](https://github.com/sanjaygbhat/bothearth/actions/runs/34314888341). The latter workflow is manually triggered; its existence does not mean every future commit is runtime-tested. Repository secret scanning and push protection were enabled when checked; that is not proof that every historical secret has been found.

## VM follow-up — revision ea71e4d

The real Debian 13 trial uncovered three deployment/recovery problems, fixed in [`ea71e4d495e5176ac6d3cb1870b2907351ab9ece`](https://github.com/sanjaygbhat/bothearth/commit/ea71e4d495e5176ac6d3cb1870b2907351ab9ece):

- The SSH preflight used the wrong executable for version detection and accepted systemd versions that could encrypt but not decrypt user-service credentials. It now checks `systemctl`, requires systemd 258 for this path, and actually starts a transient unit with the encrypted credential before installing. This does not validate every systemd 258+ distribution.
- Vault validation rejected valid Linux system-service credentials delivered as root-owned, read-only files with service-user ACLs. It now accepts that narrowly checked root-managed layout as well as private user-owned files, retaining no-follow, ownership, permission and size checks. Regressions reject writable/world-readable files and unsafe parent directories. The root-only test was executed on the VM and in Linux CI.
- A failed vault initialization left config/tokens behind and blocked a normal retry. Initialization now persists those only after vault creation succeeds; the failed-key/retry regression passes without forcing a reset.

The follow-up unit suite recorded **1,223 passes, 6 skips, 0 failures** (1,229 total). Five skips require local host Chromium; the sixth needs Linux root. All three systemd credential tests separately passed as root on the actual VM and in the runtime workflow. The 29 contract checks, typechecks, build and lint passed. Runtime checks were repeated at this revision: nine container integration tests, browser/shell image checks and 21 egress probes, all passing with no egress skips.

Public receipts: [CI at ea71e4d](https://github.com/sanjaygbhat/bothearth/actions/runs/34317006444), [runtime and root credential checks at ea71e4d](https://github.com/sanjaygbhat/bothearth/actions/runs/34317052358). The [separate VM trial](REMOTE-VM-TRIAL-2026-09-09.md) records actual browser research, encrypted credential startup, network exposure and restart checks. These are scoped internal evidence, not an independent audit.

## What these results do not establish

- Remote model providers receive submitted prompts and model-visible tool results, potentially including screenshots. Self-hosting does not mean all data stays on the machine.
- Native Codex/Claude Code processes and installed host connectors retain their independent host permissions; computer containers do not sandbox those privileges.
- Approval detection does not identify every external effect. Prompt injection, compromised websites, account misuse and novel container escapes remain material risks.
- Browser profiles are not encrypted by BotHearth; task records, screenshots, workspaces, native CLI histories and backups have separate retention. There is no comprehensive automatic purge policy.
- A host administrator or compromised daemon account can access runtime secrets. Vault encryption does not defend against that administrator.
- The Linux tests and single Debian x86-64 VM trial do not prove every CPU architecture, production image digest, phone/cellular flow or cloud configuration works. Read the trial’s topology and limitations before generalizing its results.
- No independent audit, SOC 2/ISO certification, exhaustive penetration testing, formal proof, production SLA or zero-vulnerability claim is made.

Read the [security model](../SECURITY.md), [privacy and retention guide](../PRIVACY.md), [remote deployment guide](REMOTE-DEPLOY.md) and [release acceptance checklist](SECURITY-CHECKLIST.md) before relying on a deployment.
