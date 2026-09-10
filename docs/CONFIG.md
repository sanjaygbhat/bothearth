# BotHearth configuration reference

Generated from `modelbot.schema.json`. Do not hand-edit; re-run:

```bash
node --experimental-strip-types scripts/gen-config-doc.ts
```

Schema title: **modelbot.yaml**.

ModelBot daemon config (ARCHITECTURE §3). Every key is optional: src/config/load.ts fills unset keys from its defaults before validation, so an empty modelbot.yaml is valid. Required columns below describe the config after defaults are applied.

## Zero configuration

Every section is optional. `src/config/load.ts` fills unset keys from its defaults
(`withDefaults()`) and the schema validates the result, so an empty `modelbot.yaml` is valid and
`modelbot init` writes only what the install decided:

```yaml
version: 1
data_dir: /Users/you/ModelBot
adapters:
  default: openai_compat
  openai_compat:
    base_url: https://api.openai.com/v1
    model: gpt-5.5
    api_key_vault: providers/openai
agent:
  spend_cap_usd: 20
```

Set only what you want to change; a section merges key by key, so
`agent: { spend_cap_usd: 5 }` keeps every other `agent` default. Arrays replace wholesale —
a shorter `policy.gates` list is a weaker policy and has to be written out in full.
`sandbox.workspace_root`, `audit.path` and `vault.path` derive from `data_dir` unless set.
Security defaults (`bind: 127.0.0.1`, `mode: supervised`, all six `policy.gates`,
`policy.kill_switch: true`) apply when the config is silent; weakening one is an explicit edit.
The annotated full reference is `src/config/example.yaml`, copied into `$MODELBOT_HOME` by init.

Standalone adapter settings are separate from the native Codex and Claude Code choices
in the task interface. Check [provider requirements](PROVIDERS.md) for model compatibility.

## Fields

Nothing here has to appear in your own `modelbot.yaml`. The **Required** column marks only the
fields inside list entries and shared definitions (a scheduler routine, an adapter endpoint) where
a missing value is a real error rather than a defaulted one.

| Path | Type | Required | Constraints | Notes |
|---|---|---|---|---|
| `version` | const 1 | no | — |  |
| `bind` | string | no | — |  |
| `port` | integer | no | min=1, max=65535 |  |
| `auth` | object | no | closed |  |
| `auth.mcp_token_env` | string | no | minLength=1 |  |
| `data_dir` | string | no | — |  |
| `updates` | object | no | closed |  |
| `updates.check` | boolean | no | — |  |
| `mode` | enum "supervised" | "strict" | no | — |  |
| `policy` | object | no | closed |  |
| `policy.gates` | array<enum "external_send" | "payment" | "upload" | "delete" | "secret_entry" | "new_domain"> | no | — |  |
| `policy.categories_path` | string | no | — |  |
| `policy.tos_risk_path` | string | no | — |  |
| `policy.strict_allowlist` | array<string> | no | — |  |
| `policy.kill_switch` | boolean | no | — |  |
| `policy.approval_ttl_sec` | integer | no | min=1 | Seconds an approval stays answerable before it expires and the task pauses. |
| `sandbox` | object | no | closed |  |
| `sandbox.runtime` | enum "auto" | "orbstack" | "colima" | "docker" | "podman" | no | — |  |
| `sandbox.image_browser` | string | no | — |  |
| `sandbox.image_shell` | string | no | — |  |
| `sandbox.memory` | string | no | — |  |
| `sandbox.cpus` | number | no | — |  |
| `sandbox.shm_size` | string | no | — |  |
| `sandbox.max_computers` | integer | no | min=1 |  |
| `sandbox.idle_pause_min` | integer | no | min=0 |  |
| `sandbox.workspace_root` | string | no | — |  |
| `sandbox.capabilities` | array<enum "browser" | "shell"> | no | — |  |
| `browser` | object | no | closed |  |
| `browser.max_tabs` | integer | no | min=1 |  |
| `browser.default_tabs` | integer | no | min=1 |  |
| `browser.snapshot_max_chars` | integer | no | min=1 |  |
| `browser.screenshot_max` | integer | no | min=1 |  |
| `browser.screenshot_jpeg_q` | integer | no | min=1, max=100 |  |
| `agent` | object | no | closed |  |
| `agent.max_steps` | integer | no | min=1 |  |
| `agent.loop_identical` | integer | no | min=1 |  |
| `agent.stall_sec` | integer | no | min=1 |  |
| `agent.spend_cap_usd` | number | no | min=0 | What one task is given when the request names no budget. |
| `agent.spend_cap_max_usd` | number | no | min=0 | The most a task request or a resume may ask for; above it the daemon answers E_LIMIT. |
| `agent.max_runtime_sec` | integer | no | min=0 | Seconds of wall clock one run may take before it pauses; 0 (the default) means no time limit. A run that reaches it pauses with failure_kind max_runtime and keeps its receipt; POST /api/v1/tasks/:id/resume with a larger max_runtime_sec carries it on. It never fails a task. |
| `agent.context_tokens_max` | integer | no | min=1 |  |
| `agent.compact_at` | number | no | min=0, max=1 |  |
| `agent.token_cap_in` | integer | null | no | — |  |
| `agent.token_cap_out` | integer | null | no | — |  |
| `adapters` | object | no | — | AI connection. `default` names a registered adapter (see docs/EXTENDING.md). |
| `adapters.default` | string | no | minLength=1 | Registered adapter name. Built-in: openai_compat, anthropic. A third-party adapter registers its own name. |
| `adapters.openai_compat` | $defs.adapterEndpoint | no | — |  |
| `adapters.anthropic` | $defs.adapterEndpoint | no | — |  |
| `mcp` | object | no | closed |  |
| `mcp.server` | object | no | closed |  |
| `mcp.server.http_path` | string | no | — |  |
| `mcp.server.stdio_bridge` | boolean | no | — |  |
| `mcp.server.tool_timeout_sec` | integer | no | min=1 |  |
| `mcp.connectors` | array<unknown> | no | — |  |
| `takeover` | object | no | closed |  |
| `takeover.ttl_sec` | integer | no | min=1 |  |
| `takeover.notify` | array<string> | no | — |  |
| `scheduler` | object | no | closed |  |
| `scheduler.enabled` | boolean | no | — |  |
| `scheduler.routines` | array<object> | no | — |  |
| `remote` | object | no | closed |  |
| `remote.access` | string | no | — |  |
| `remote.allowed_hosts` | array<string> | no | — |  |
| `remote.public_origin` | string | no | — | Canonical HTTPS origin of the trusted reverse proxy; daemon remains on loopback. |
| `audit` | object | no | closed |  |
| `audit.path` | string | no | — |  |
| `vault` | object | no | closed |  |
| `vault.path` | string | no | — |  |
| `vault.keychain` | enum "auto" | "passphrase" | no | — |  |

## Shared definitions (`$defs`)

| Path | Type | Required | Constraints | Notes |
|---|---|---|---|---|
| `$defs.adapterEndpoint` | object | no | closed |  |
| `$defs.adapterEndpoint.base_url` | string | no | — |  |
| `$defs.adapterEndpoint.model` | string | yes | — |  |
| `$defs.adapterEndpoint.api_key_vault` | string | no | — |  |
| `$defs.adapterEndpoint.api_key_env` | string | no | — |  |
| `$defs.adapterEndpoint.price_per_mtok_in` | number | no | — |  |
| `$defs.adapterEndpoint.price_per_mtok_out` | number | no | — |  |
| `$defs.adapterEndpoint.extra` | object | no | — |  |

## Environment variables

Environment overrides win over the file. Variables prefixed `MODELBOT_TEST_` are test and
development scaffolding, are not part of the product surface, and are not listed here.

| Variable | Purpose |
|---|---|
| `MODELBOT_HOME` | Config and state directory (default `~/.modelbot`). |
| `MODELBOT_CONFIG` | Path to modelbot.yaml, overriding `$MODELBOT_HOME/modelbot.yaml`. |
| `MODELBOT_DATA_DIR` | Overrides `data_dir`. |
| `MODELBOT_WORKSPACE_ROOT` | Overrides `sandbox.workspace_root`. |
| `MODELBOT_SQLITE_PATH` | Overrides the task database path under `data_dir`. |
| `MODELBOT_HOST` | Overrides `bind` for one `modelbot start`. |
| `MODELBOT_BIND` | Same as MODELBOT_HOST; MODELBOT_HOST wins if both are set. |
| `MODELBOT_PORT` | Overrides `port`. |
| `MODELBOT_ALLOW_PUBLIC_BIND` | `1` permits a non-loopback bind. Read SECURITY.md first. |
| `MODELBOT_PUBLIC_ORIGIN` | Overrides `remote.public_origin` (HTTPS origin of the trusted proxy). |
| `MODELBOT_TOKEN` | MCP token, used when `~/.modelbot/tokens.json` is not readable. |
| `MODELBOT_MCP_TOKEN` | Same as MODELBOT_TOKEN; checked first. |
| `MODELBOT_BOOTSTRAP_TOKEN` | One-time UI session token, required by `modelbot status`. |
| `MODELBOT_SCOPED_TOKEN` | Per-task token a harness receives; set by the daemon, not by you. |
| `MODELBOT_ENDPOINT` | Daemon base URL for the MCP stdio bridge. |
| `MODELBOT_MCP_URL` | Full MCP endpoint URL, if it is not `<endpoint>/mcp`. |
| `MODELBOT_BASE_URL` | Daemon base URL for CLI and flavour clients. |
| `MODELBOT_VAULT_KEY_HEX` | 32-byte hex vault master key, for headless hosts with no OS keychain. |
| `MODELBOT_VAULT_PATH` | Overrides `vault.path` for `modelbot vault` commands. |
| `MODELBOT_AUDIT_KEY_HEX` | Hex audit HMAC key for `modelbot audit verify` off-host. |
| `MODELBOT_AUDIT_KEY` | Same key as raw text instead of hex. |
| `MODELBOT_TOOL_PATH` | Extra directories searched before PATH when resolving a harness binary. |
| `MODELBOT_CODEX_HOME` | Codex home directory; presence enables the Codex harness runner. |
| `MODELBOT_CODEX_MODEL` | Model the Codex runner requests. |
| `MODELBOT_INIT_FORCE` | `1` makes `modelbot init` overwrite an existing config. |
| `MODELBOT_INIT_SKIP_DETECT` | `1` skips container-runtime detection during init. |
| `MODELBOT_PROXY_SERVER` | Egress proxy URL for the container browser. |
| `MODELBOT_PROXY_BYPASS` | Hosts that bypass that proxy. |
| `MODELBOT_SECCOMP` | Path to the seccomp profile applied to the browser container. |
| `MODELBOT_QUARANTINE` | In-container quarantine directory for downloads (default `/quarantine`). |
| `MODELBOT_PROFILE` | In-container browser profile directory. |
| `MODELBOT_WORKSPACE` | In-container workspace mount point (default `/workspace`). |

## See also

- Example config: `docs/ARCHITECTURE.md` §3
- Operator guide: `docs/QUICKSTART.md`
- Security defaults: `SECURITY.md`
