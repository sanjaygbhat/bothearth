# BotHearth external VM trial — 9 September 2026

**Result:** a real Linux VM ran BotHearth's daemon and Chromium, completed a public-source research task, and saved two Markdown reports. After correcting the temporary host's startup script, a real reboot automatically restarted the daemon with its encrypted vault credential and preserved both reports byte for byte. Acknowledged human control blocked model browser capture. This was an internal engineering trial, not an independent audit or proof of effortless installation.

## What actually ran where

```text
Operator Mac: signed-in Codex model harness
        │ authenticated MCP over a loopback SSH tunnel
        ▼
Linux VM: non-root BotHearth daemon + encrypted systemd credential
        │
        ├─ isolated Chromium + proxy containers → public websites
        └─ host task database, browser profile and saved reports
```

The model harness used the operator's existing account locally. Its credentials were not copied to the VM. Prompts and model-visible page text went to the chosen model provider. The browser, daemon and primary task files ran on the VM. This topology requires the local harness and tunnel during model execution; it does **not** establish that the model task continues with the laptop turned off. A provider CLI authenticated on the VM or a supported remote API adapter is a separate setup path.

## Recorded environment

| Item | Recorded value |
| --- | --- |
| Application and image source | Public commit [`ea71e4d495e5176ac6d3cb1870b2907351ab9ece`](https://github.com/sanjaygbhat/bothearth/commit/ea71e4d495e5176ac6d3cb1870b2907351ab9ece) |
| Cloud host | Temporary Google Compute Engine VM, US region, Debian 13 x86-64 |
| Capacity | 4 vCPU, 16 GiB RAM, 40 GB auto-delete boot disk |
| Host runtime | Node 22.23.2; Docker Engine 29.8.0; systemd 257.13 |
| Browser | Full Chromium 147.0.7727.15 with sandbox enabled |
| Service | System service executing as a dedicated non-root account; root-managed `LoadCredentialEncrypted` |
| Connectivity | Daemon/MCP bound to loopback port 17777; private SSH forward from operator Mac |
| Cloud authority | No VM service account or API scopes; task-specific SSH access |

The firewall allowed SSH only from the operator's current IP, with a higher-priority deny rule for all other inbound traffic to this VM. External probes could reach the allowed SSH port; daemon ports 7777/17777, debugging 9222, Docker 2375/2376 and RDP 3389 were unreachable. This checks those ports from the trial client, not every possible network path. The SSH host key was recorded on first connection, not independently verified out of band.

## Real task and deliverables

Task `vm-positioning-20260909-verified` ran from **06:00:41 to 06:12:53 UTC**, approximately **12 minutes 11 seconds**. The daemon recorded **111 metered tool calls** and completion. The research covered **14 project families and 26 substantive primary pages**, including current offerings from OpenClaw, Browser Use, Browserbase, Manus, Simular, Skyvern, Steel/Atlas, Kortix, OpenHands, Anthropic, OpenAI, Open Interpreter, Cua and Vercel's agent-browser.

Only public browsing, page reads and report writes were exposed to the harness. Native shell, local web search, connected apps, account login and message sending were disabled. BotHearth's new-domain approvals remained active; the operator allowed relevant official domains. Initial pending approvals and oversized page snapshots required correction/retry. An empty Open Interpreter homepage was recovered through its official repository. No competitor products were installed or security-audited.

- `competitor-positioning-2026-09-09.md` — comparisons, source links, evidence gaps and recommendations. SHA-256: `5d83de02ac5002721e4ce1529df46be2a5529935321c94e8e3fac84ea87b1893`.
- `positioning-copy-2026-09-09.md` — proposed homepage copy and disclosure boundaries. SHA-256: `caa829598bda21047919aa0c1f7047bdda294782b65fe903cc18998ebdf3ada7`.

These hashes identify the original VM outputs. The [publication-edited competitor report](COMPETITOR-POSITIONING-2026-09-09.md) includes an editorial provenance note and links to updated evidence. Its central recommendation informed the homepage: operator-hosted records, visible work, model choice and explicit human-control boundaries. Self-hosting and supervision are not claimed as unique features.

The task meter recorded US$1.11 using the configured per-tool estimate. That is **not** a provider charge, token-cost measurement or total cloud bill. Actual model-account charges and cloud billing are separate.

## Setup friction found and resolved

1. **Headless credentials:** systemd 257.13 could encrypt user-scoped credentials but its user service could not decrypt them (`243/CREDENTIALS`). The deploy planner now requires systemd 258 for that path and actually tests decryption in a transient unit. The working trial used a non-root **system** service instead; it does not validate the newer user-service path.
2. **Credential ACLs:** system services receive root-owned read-only credential files with service-user access. BotHearth rejected that valid layout. Narrow ownership, mode, no-follow and parent-directory checks now accept it; the real Linux root tests passed.
3. **Initialization retry:** a vault failure previously left config/tokens that blocked retry. The fixed order allows a corrected key to initialize without forcing a reset.
4. **Docker/AppArmor:** Debian's Docker 26.1.5 package denied Chromium user-namespace creation. Upstream Docker 29.8.0 passed the existing Chromium sandbox smoke check. Neither AppArmor nor the browser sandbox was disabled.
5. **Cloud bootstrap repeats:** the trial's own Google startup script reran on reboot and attempted to replace the upgraded Docker packages with distro packages. That caused the first reboot recovery to fail. Removing the completed one-time startup script and restoring the supported Docker packages produced a successful automatic daemon restart on the next real reboot. This was trial provisioning, not a claim that the product installer handles Google Cloud lifecycle automatically.
6. **Harness permissions:** the first model launch lacked native MCP tool approval configuration and could not call BotHearth. A bounded explicit tool allowlist fixed it while retaining BotHearth's operator gates. Large page snapshots had to be scoped to stay within the 1 MiB MCP request limit.

Connecting to a prepared host through SSH is straightforward. Preparing a fresh headless host currently requires technical administration and platform-specific troubleshooting. **Do not market this alpha as a one-click cloud install.** See [remote deployment](REMOTE-DEPLOY.md) and [harness integration](HARNESS-INTEGRATIONS.md).

## Restart and control evidence

After the research completed, a separate task acquired HUMAN control through the authenticated operator API. An actual MCP `browser_snapshot` call returned `E_TAKEOVER_BUSY`. The same capture gate remained closed after daemon/host restart, and the existing authenticated operator session reopened. Boot identifiers changed; encrypted credential startup succeeded; both saved report hashes remained unchanged.

After explicitly restarting the browser, its local control state was initially `agent` while the daemon retained the durable `human` gate; MCP capture still failed closed. Returning that recovered session to normal model execution was not tested. This is a recovery limitation, not evidence of a seamless takeover session across reboot.

This proves a scoped model-capture block and persisted records. It does not establish uninterrupted browser sessions, preserved third-party login cookies, automatic model resumption, graphical takeover input, every stale-input path, or phone/cellular operation. No signed-in browser accounts were used. A stopped or disconnected browser must be restarted before further work; do not infer live browser continuity from daemon health alone.

## Limits and cleanup

No independent penetration test, exhaustive source review, production SLA, universal distribution support, phone pairing/cellular test, provider login on the VM, or laptop-independent model task was performed. The host administrator can access runtime secrets. Browser profiles are not encrypted by BotHearth. Development image tags were source-stamped for this trial; this is not a production digest attestation.

**Cleanup verified at 06:27:33 UTC on 9 September 2026:** the temporary VM, its auto-delete boot disk and both task-specific firewall rules were absent from cloud listings. No reserved address remained for its ephemeral IP. Temporary local access credentials were removed after collecting non-secret evidence. Existing project billing, other services and unrelated firewall rules were retained.
