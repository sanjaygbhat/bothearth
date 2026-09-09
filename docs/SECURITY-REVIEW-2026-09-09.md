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

## What these results do not establish

- Remote model providers receive submitted prompts and model-visible tool results, potentially including screenshots. Self-hosting does not mean all data stays on the machine.
- Native Codex/Claude Code processes and installed host connectors retain their independent host permissions; computer containers do not sandbox those privileges.
- Approval detection does not identify every external effect. Prompt injection, compromised websites, account misuse and novel container escapes remain material risks.
- Browser profiles are not encrypted by BotHearth; task records, screenshots, workspaces, native CLI histories and backups have separate retention. There is no comprehensive automatic purge policy.
- A host administrator or compromised daemon account can access runtime secrets. Vault encryption does not defend against that administrator.
- These receipts are Linux container checks and scoped local tests. They do not prove every CPU architecture, production image digest, phone/cellular flow, remote cold boot or cloud configuration works. A separate real VM trial is pending.
- No independent audit, SOC 2/ISO certification, exhaustive penetration testing, formal proof, production SLA or zero-vulnerability claim is made.

Read the [security model](../SECURITY.md), [privacy and retention guide](../PRIVACY.md), [remote deployment guide](REMOTE-DEPLOY.md) and [release acceptance checklist](SECURITY-CHECKLIST.md) before relying on a deployment.
