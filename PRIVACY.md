# Privacy

BotHearth stores task data on your host or a VM you control. The daemon does not upload tasks to a BotHearth account service or include product analytics. Remote models, visited websites, connectors, paired devices, and notification services receive data for their operations and apply their own retention policies. Self-hosting the daemon does not keep all task data offline.

This notice describes the source application reviewed on 2026-09-09. A separately hosted project website and services you configure have their own data flows.

## Stored data

| Data | Location and retention |
|---|---|
| Tasks, transcripts, approvals, routine history | SQLite in the configured data directory; retained until you remove the data |
| Model-visible snapshots and screenshots | May be present in task/tool records; no automatic 24-hour expiry is implemented |
| Workspace files | Configured workspace root, normally `~/ModelBot/computers/<name>/workspace`; retained until removed |
| Browser cookies and local storage | Per-computer Docker profile volume; kept by ordinary computer destruction unless `--wipe-profile` is requested |
| Downloads | Browser downloads enter browser-only quarantine tmpfs until an operator promotes them; native CLI commands can save downloads directly in the shared workspace |
| Audit | Host JSONL and its chain-head file; no automatic 30-day expiry is implemented |
| Vault | Encrypted host file containing provider keys and connector environment values; master key in OS keychain or supplied key provider |
| Daemon log | `~/.modelbot/daemon.log` for background operation; rotated at 5 MiB with one prior file |
| Native CLI authentication and history | New sessions use the computer's persistent `/home/agent` volume, including `.codex` and `.claude`; historical host sessions retain their original host homes. BotHearth runner diagnostics remain under `~/.modelbot/task-runs/` by default. These stores are outside the vault; no general purge is implemented |
| Paired devices and operator sessions | Session metadata and token hashes in the host database; the paired browser or native client's secure storage holds its own operator credential. Revoking a device does not erase content it already received |
| Proxy access log | Size-limited container stdout and `/tmp/proxy-access.jsonl`; default fields are destination host/port, verdict, and bytes |

**There is no general transcript/screenshot retention scheduler or per-task purge command.** Earlier plans for 7-day transcripts, 24-hour screenshots, and 30-day audit retention are not implemented guarantees. Stopping a task or daemon does not delete its records.

Before human takeover is acknowledged, native model processes inside the computer are frozen and MCP computer actions/capture are blocked. The operator desktop remains usable; messages to the guest model wait until control returns. Live frames and input are not routed to the model or retained in BotHearth task/audit records; the visited page still sees what you enter. Later page content and shared workspace edits can become model-visible after you return control. Do not enter credentials in chat. Browser profiles are not encrypted by BotHearth.

## Outbound data

- Remote model APIs and harnesses receive model-visible messages, tool descriptions/results, and any supplied screenshots or snapshots.
- Websites receive navigation requests, cookies, form submissions, and uploads from that computer's session.
- Host-side connectors send data according to the tools you install and authorize.
- Configured notifications send task/takeover status to ntfy, Telegram, or your webhook. Model-authored reason text is URL-stripped; trusted operator links may be included.
- Paired browsers and native clients receive task content and live frames over the configured local/private connection. Anyone with operator access can view the instance's tasks.
- Installation and updates contact npm, image registries, OS package mirrors, and DNS resolvers.

Sandbox traffic, including guest CLI model requests and native shell traffic, uses the proxy. Historical host runners, external harnesses, connectors and notifications run outside it. Native CLI requests are not inspected by BotHearth's MCP action classifier. TLS is not decrypted by the proxy. Enabling `PROXY_ACCESS_LOG_VERBOSE=1` adds the method and HTTP path, but not query strings, headers, or bodies.

## Backup and removal

Stop the daemon before copying its data. Back up the configured data directory, configuration/token files, audit JSONL **and chain head**, and any browser and native CLI home volumes you intend to retain. Preserve access to the vault's original key provider; copying encrypted vault bytes alone is not a usable backup. Encrypt backups and account for provider snapshots.

`bothearth computer destroy <name>` removes the computer containers; `--wipe-profile` additionally removes saved browser logins. Native CLI home volumes, workspace files and host task/audit data require separate removal. Removing the proxy container drops its tmpfs and container logs. There is no `computer reset` or `audit purge` command.

For complete local removal, stop BotHearth, identify the configured data/workspace paths and computer volumes, and remove each intended copy, including SQLite sidecars and backups. Deleting local data does not delete copies already sent to providers, sites, or notification services. Rotate credentials at their issuer when revoking them.

Review harness histories and `task-runs` diagnostics separately before sharing logs or removing an installation. Do not upload raw task databases, cookies, tokens, or vaults in bug reports. Deleting a BotHearth task copy cannot revoke a paired client's screenshots or a recipient's downloaded files.

On a remote VM, its provider can access unencrypted disks and snapshots. Use SSH or Tailscale to reach the UI and protect the host's vault and backups.

See [SECURITY.md](SECURITY.md) for trust boundaries and [configuration](docs/CONFIG.md) for paths.

## Enterprise licensing service

The separate enterprise service collects verified work emails, organisation names and domains, licence records and accepted terms, and optional enquiries for additional licences. It uses Resend for verification codes and sends enquiries to a private support inbox. It does not receive local agent tasks or model credentials.

Codes are keyed hashes, expire after ten minutes, and allow five attempts. HttpOnly session cookies expire after 24 hours; sign-out invalidates the server session. Hashed rate-limit identifiers expire within one hour. Expired authentication/rate records are removed on the next request. Perpetual licence records remain as evidence of the grant. Enquiry database records are removed after 90 days on the next request; mailbox, provider, backup, and hosting retention are separate. Use [the contact form](https://bothearth.com/contact/) for data corrections or requests. See the [website privacy notice](https://bothearth.com/security/#website) and [Resend privacy policy](https://resend.com/legal/privacy-policy).

The public contact form also accepts enquiries without sign-in. It forwards the submitted name, reply email, optional organisation, licence quantity, and message through Resend to the private support inbox. Reply addresses are unverified. This stateless form service keeps no enquiry database; temporary email hashes support rate limiting. Provider and mailbox retention apply separately.
