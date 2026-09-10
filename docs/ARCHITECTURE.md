# Architecture

BotHearth runs an operator-controlled daemon on a Mac or Linux host and gives tasks a separate computer with native model CLIs, a browser and a shared workspace. This page describes the source implementation reviewed on 2026-09-10; [configuration](CONFIG.md) and [CLI reference](CLI.md) are generated from the schema and commands.

## Where work runs

```mermaid
flowchart LR
  UI[Operator browser or native client] --> Daemon[Host daemon]
  subgraph Computer[Computer container]
    Harness[Stock Codex or Claude Code / agent uid]
    Browser[Chromium and operator desktop / browser uid]
  end
  Daemon -->|exec over stdio| Harness
  Harness -->|Scoped MCP over stdio| Daemon
  Daemon -->|exec over stdio| Browser
  Daemon -->|exec over stdio| Shell[Optional shell-tool container]
  Harness --> Proxy[Egress proxy]
  Browser --> Proxy
  Shell --> Proxy
  Proxy --> Model[Remote model provider]
  Proxy --> Sites[Permitted websites]
```

The host daemon serves the UI, operator API, live WebSockets, and MCP on one listener, normally `127.0.0.1:7777`. It also owns task state, policy, container lifecycle, the vault, and audit logging. It is not a container with the Docker socket mounted inside it. Remote installation keeps the daemon on the VM host and uses private HTTPS or an SSH tunnel; see [remote deployment](REMOTE-DEPLOY.md).

Each computer has a browser container and proxy, with an optional separate shell-tool container. In the computer, uid 1001 owns the private browser profile and operator desktop; uid 1002 runs native CLIs with a separate persistent model home. Both can edit the configured host workspace through a shared group. The agent uid cannot read the browser profile or quarantine. The separate shell-tool container has no profile mount. Sandbox ports are not published; guest network requests use the egress proxy. Domain controls do not inspect encrypted request content.

## Task execution

New tasks launch stock Codex or Claude Code inside the computer through Docker stdio, retaining native tools, skills and guest configuration. Provider authentication also runs there. Tasks save their provider, model, execution location and native thread ID; historical host tasks resume with their original host CLI/login. **Use subagents** is unchecked for every new task. Checking it enables native delegation or the selected subagent provider’s stock CLI inside the same guest. The internal API values remain `execution_mode: "executor" | "orchestrator"`. MCP calls cross a scoped stdio bridge to the host daemon, which validates those calls before dispatch.

Model discovery and model access are separate: `/api/v1/models` returns model choices with connection/readiness metadata. Home preserves a selected model while showing sign-in or quota problems, refreshes readiness after Settings, and leaves task submission under the operator’s control. Native events supply model messages and tool activity; the UI does not classify model prose to invent questions or approval prompts.

Manual harness connections use the separately configured MCP interface and an operator-created task binding. Standalone tasks use an adapter in `src/adapters/`; scheduled tasks currently require this standalone path. Model/tool-call compatibility and provider terms still apply. See [provider requirements](PROVIDERS.md) and [harness integrations](HARNESS-INTEGRATIONS.md).

The computer-server uses Playwright and Chromium for browser actions and snapshots. Live view is relayed through the daemon to authenticated operators. MCP file tools are confined to the workspace; native tools can access other files and network destinations permitted to their guest uid. A clean model turn without `done` keeps the conversation open for an operator reply; `done` records an explicit task outcome.

## Approval and human control

Operator UI sessions and model MCP tokens have different authority. The MCP credential cannot grant operator approvals or watch human-control frames. Approvals bind the task, action, destination, control epoch and expiry. Normal public browsing proceeds without destination prompts; strict mode restricts destinations, and detected sensitive effects through MCP browser tools can request approval. Native shell/network operations bypass these action checks, and native CLI permission prompts are disabled inside the container.

Human takeover freezes all guest model processes, including tool children, and blocks new native launches and MCP computer actions before the UI grants control. The browser/desktop is initialized before a browser-role grant is acknowledged. The operator desktop remains usable. Messages to the frozen model wait until return. Handback validates the page before processes and capture resume; an expired lease stays paused. This process freeze does not extend to independently connected host harnesses.

If human control interrupts guest startup before any native output or established thread, the runner can retry that untouched startup after handback. Existing sessions, emitted native output, provider failures and cancellation are excluded from this recovery. Live subscriptions serialize start/stop operations so an early takeover cannot lose its screen subscription.

## State and costs

Task history and sessions use host SQLite storage. The vault encrypts provider API keys and connector environment values; browser profiles, workspaces and task databases are not encrypted by BotHearth. The keyed audit chain detects some changes to saved records, not every compromise of a host holding its key. Guest CLI authentication/history live in the computer’s persistent model-home volume; historical host homes and runner diagnostics remain separate. See [privacy and removal](../PRIVACY.md).

Native usage is estimated from MCP calls, not every stock CLI command or model request. Standalone API estimates depend on reported usage and configured prices. Task limits can pause work but cannot guarantee a cap on a provider's bill. See [quickstart limits](QUICKSTART.md#what-the-task-cost-means).

## Integration contracts

The canonical catalogue is [TOOL_NAMES and shared contracts](https://github.com/sanjaygbhat/bothearth/blob/main/src/types/contracts.ts), with argument schemas under [src/tools/schemas](https://github.com/sanjaygbhat/bothearth/tree/main/src/tools/schemas). The current tools are:

```text
browser_navigate browser_snapshot browser_click browser_type browser_press
browser_scroll browser_select browser_upload browser_tabs browser_screenshot
browser_wait computer_mouse computer_key computer_type shell_exec
files_list files_read files_write files_delete write_file
request_takeover takeover_status connector_call done
```

Use the returned `snapshot_id` with reference-based actions. A stale reference requires a fresh snapshot. Pointer coordinates use CSS viewport pixels, not screenshot/device pixels. File/upload paths are confined to the workspace. Errors use the shared `ToolResult` envelope; transport JSON-RPC failures are separate from application error codes. [Extending BotHearth](EXTENDING.md) describes providers, connectors, and policy; do not infer a new tool from a name in an old design note.

The daemon/computer stream uses a four-byte big-endian body length, then a type byte and payload: `0` for UTF-8 JSON-RPC, `1` for binary live frames. The body limit is 8 MiB and JSON-RPC JSON limit 2 MiB. Browser role accepts RPC/live frames; shell role rejects live frames. Use the actual [stdio codec](https://github.com/sanjaygbhat/bothearth/blob/main/src/protocol/stdio.ts) and [live codec](https://github.com/sanjaygbhat/bothearth/blob/main/src/protocol/live.ts), which have contract tests. This private transport is distinct from the external MCP protocol.

| Endpoint family | Authority and purpose |
|---|---|
| `GET /healthz` | Unauthenticated liveness only |
| `/api/v1/session/*` | Bootstrap, pairing, device revocation; exact requests and credential storage in [remote client contract](REMOTE-CLIENT.md) |
| `/mcp` | MCP bearer, with browser origins rejected; [harness setup and task bindings](HARNESS-INTEGRATIONS.md) |
| `/api/v1/tasks`, `/api/v1/computers` | Authenticated operator administration; mutation requires CSRF |
| `/api/v1/approvals`, `/api/v1/takeover/*` | Operator decisions and human control; model credentials cannot approve |
| `/api/v1/events`, `/api/v1/live/:computerId` | Operator WebSockets with session/origin checks; control epoch must be preserved |
| `/api/v1/runtime`, `/api/v1/runtime/prepare` | Runtime readiness and operator-triggered image preparation |

For full request validation, read [daemon/server.ts](https://github.com/sanjaygbhat/bothearth/blob/main/src/daemon/server.ts). This pre-release API is not a version-stability promise. Runtime readiness checks the actual Node version, runtime, stamped images, browser, and configured model connection; the home screen can open before task execution is ready. [Troubleshooting](TROUBLESHOOTING.md) maps the visible blockers to recovery actions.

Each vault file has its own OS-store key identity derived from its real path, so resetting one installation does not intentionally rotate another's key. [Keychain and recovery details](https://github.com/sanjaygbhat/bothearth/blob/main/src/vault/KEYCHAIN.md) cover legacy keys and host ACL limits. [Compose](COMPOSE.md) and [security](../SECURITY.md) describe the sandbox configuration and boundaries.

## Code map

| Path | Responsibility |
|---|---|
| `src/cli/`, `src/config/` | Commands, initialization, generated config defaults |
| `src/daemon/` | HTTP API, task state, runners, dispatch, connections |
| `src/policy/`, `src/protocol/` | Approval decisions, origin checks, control state |
| `src/sandbox/`, `src/proxy/` | Container lifecycle, runtime flags, outbound proxy |
| `computer-server/src/` | Browser and shell tool implementations |
| `src/mcp/`, `src/adapters/` | Harness transport, connectors, standalone models |
| `src/vault/`, `src/audit/` | Encrypted vault and audit chain |
| `src/ui/`, `apps/macos/`, `mobile/` | Browser UI and optional native clients |

Read [security](../SECURITY.md) before changing a trust boundary, and [contributing](../CONTRIBUTING.md) for validation.
