# Extending BotHearth

Four seams. No marketplace, no plugin loader. Each seam = one file + one line.

## Before you start

Trust boundary: daemon, vault, policy, audit run on **host**. Browser + shell run in **container**.
Extension code runs on host = same power as you. Review before install.

`TOOL_NAMES` (`src/types/contracts.ts`) closed on purpose: each name = one policy gate + one
schema + one audit shape. New capability goes through a **connector**, never a new tool name.

## Add a model provider

One file `src/adapters/<name>.ts` + one `registerAdapter` line in `src/adapters/index.ts`.

```ts
// src/adapters/gemini.ts
import type { AdapterContext, ModelAdapter } from "./types.ts";

export function createGeminiAdapter({ endpoint, apiKey }: AdapterContext): ModelAdapter {
  return {
    kind: "gemini",
    // req:  { system, messages, tools, model, signal }
    // resp: { content?, tool_calls: [], usage: { tokens_in, tokens_out, usd_est? } }
    async complete(req) { /* ... */ },
  };
}

// src/adapters/index.ts
registerAdapter("gemini", createGeminiAdapter);
```

```yaml
adapters:
  default: gemini
  gemini: { base_url: https://…/v1beta, model: gemini-3-pro, api_key_vault: providers/gemini }
```

- `kind` = registered name = config block name. `adapters.<name>` validated against `$defs/adapterEndpoint`.
- Key already resolved from vault/env, arrives as `ctx.apiKey`. Factory never reads a key itself.
- Unknown name at startup → error listing registered names. No silent fallback.
- Interface: `src/adapters/types.ts`. Registry: `src/adapters/registry.ts`.

## Add a connector (tools)

Connector = the tool seam, reached through `connector_call`. Kinds: `mcp_stdio`, `mcp_http`,
`browser_session`. Broker: `src/daemon/connectors.ts`.

```js
// ~/mytools/weather.mjs — MCP over stdin/stdout
const TOOL = { name: "forecast", description: "City forecast",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } };
process.stdin.on("data", (buf) => {
  for (const line of String(buf).trim().split("\n")) {
    const m = JSON.parse(line);
    const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n");
    if (m.method === "initialize") send({ protocolVersion: "2024-11-05", capabilities: { tools: {} },
      serverInfo: { name: "weather", version: "1" } });
    if (m.method === "tools/list") send({ tools: [TOOL] });
    if (m.method === "tools/call") send({ content: [{ type: "text", text: "sunny" }] });
  }
});
```

```yaml
mcp:
  connectors:
    - id: weather
      kind: mcp_stdio
      command: node
      args: ["/Users/you/mytools/weather.mjs"]
      env: [API_TOKEN]   # read from vault at connectors/weather/API_TOKEN
```

Restart daemon. Tools stay **hidden** until approved in the UI (manifest digest pinned; manifest
change → `stale_manifest`, re-approve). After approval the model calls
`connector_call {"connector_id":"weather","tool":"forecast","arguments":{"city":"Austin"}}`.
Tool descriptions are wrapped as untrusted data, never merged into the system prompt.
Secrets stay in the vault, never in the connector config.

## Add a flavour

`flavours/<name>/` = harness-side client. Existing: `claude-modelbot`, `codex-modelbot`,
`herdr-plugin`. Pattern: manifest (`plugin.json` / `.mcp.json` / `*.toml`), `bin/` entry,
`skills/` prompt. Talks HTTP to the daemon with an MCP token. No core edit.

## Customise policy

Data files, no code. `policy/categories.json` (force-human categories, example origins) and
`policy/tos-risk.json`, pointed at by `policy.categories_path` / `policy.tos_risk_path`.
`policy.gates` = optional approval classes for BotHearth browser/file tools. Empty by default;
an explicit list is a deliberate choice. `policy.strict_allowlist` = origins allowed in `mode: strict`.
Password, OTP, passkey, CAPTCHA and force-human categories still stop the task when the list is empty.

## Config keys

`modelbot.schema.json` = source of truth. Add the key there, a default in `withDefaults()`
(`src/config/load.ts`), the field on `ModelbotConfig` (`src/types/contracts.ts`), then
`npm run docs:gen` to regenerate `docs/CONFIG.md`. Every section is optional: defaults apply
first, schema validates after, so an empty `modelbot.yaml` is valid.

## Tests

provider → `tests/unit/adapters/` · connector → `tests/unit/connectors/`, `tests/unit/mcp/` ·
config/schema → `tests/contracts/config.test.ts` · policy → `tests/unit/policy/` ·
flavour → `tests/unit/herdr-plugin/`

```bash
npm ci --prefix computer-server --ignore-scripts   # once
npm run typecheck && npm run test:unit && npm run test:contracts
```

Container suites (`tests/docker-int`, `tests/e2e`) need built images — not required for a
provider, connector, or policy change. Test-only env vars are prefixed `MODELBOT_TEST_*`.

## Submitting

CLA sign-off (`git commit -s`; see `CLA.md`). No new runtime dependency without discussion first.
Never weaken a security default to make an extension work.
