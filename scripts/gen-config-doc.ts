#!/usr/bin/env node
/**
 * WP20 — generate docs/CONFIG.md from modelbot.schema.json.
 * Usage: node --experimental-strip-types scripts/gen-config-doc.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = join(ROOT, "modelbot.schema.json");
const OUT = join(ROOT, "docs", "CONFIG.md");

type JsonSchema = {
  title?: string;
  description?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
};

function typeLabel(s: JsonSchema): string {
  if (s.$ref) return s.$ref.replace("#/$defs/", "$defs.");
  if (s.const !== undefined) return `const ${JSON.stringify(s.const)}`;
  if (s.enum) return `enum ${s.enum.map((e) => JSON.stringify(e)).join(" | ")}`;
  if (Array.isArray(s.type)) return s.type.join(" | ");
  if (s.type === "array") {
    const item = s.items ? typeLabel(s.items) : "unknown";
    return `array<${item}>`;
  }
  if (s.type === "object" && s.properties) return "object";
  return String(s.type ?? "any");
}

function constraints(s: JsonSchema): string {
  const bits: string[] = [];
  if (s.minimum !== undefined) bits.push(`min=${s.minimum}`);
  if (s.maximum !== undefined) bits.push(`max=${s.maximum}`);
  if (s.minLength !== undefined) bits.push(`minLength=${s.minLength}`);
  if (s.additionalProperties === false) bits.push("closed");
  return bits.length ? bits.join(", ") : "—";
}

function walk(
  name: string,
  s: JsonSchema,
  required: Set<string>,
  rows: string[],
  prefix = "",
): void {
  const path = prefix ? `${prefix}.${name}` : name;
  const req = required.has(name) ? "yes" : "no";
  rows.push(
    `| \`${path}\` | ${typeLabel(s)} | ${req} | ${constraints(s)} | ${(s.description ?? "").replace(/\|/g, "\\|")} |`,
  );
  if (s.properties) {
    const childReq = new Set(s.required ?? []);
    for (const [k, child] of Object.entries(s.properties)) {
      walk(k, child, childReq, rows, path);
    }
  }
}


/**
 * Environment variables the product exposes. Anything test-only is prefixed
 * MODELBOT_TEST_* and is deliberately absent from this table.
 */
const ENV_VARS: Array<[string, string]> = [
  ["MODELBOT_HOME", "Config and state directory (default `~/.modelbot`)."],
  ["MODELBOT_CONFIG", "Path to modelbot.yaml, overriding `$MODELBOT_HOME/modelbot.yaml`."],
  ["MODELBOT_DATA_DIR", "Overrides `data_dir`."],
  ["MODELBOT_WORKSPACE_ROOT", "Overrides `sandbox.workspace_root`."],
  ["MODELBOT_SQLITE_PATH", "Overrides the task database path under `data_dir`."],
  ["MODELBOT_HOST", "Overrides `bind` for one `modelbot start`."],
  ["MODELBOT_BIND", "Same as MODELBOT_HOST; MODELBOT_HOST wins if both are set."],
  ["MODELBOT_PORT", "Overrides `port`."],
  ["MODELBOT_ALLOW_PUBLIC_BIND", "`1` permits a non-loopback bind. Read SECURITY.md first."],
  ["MODELBOT_PUBLIC_ORIGIN", "Overrides `remote.public_origin` (HTTPS origin of the trusted proxy)."],
  ["MODELBOT_TOKEN", "MCP token, used when `~/.modelbot/tokens.json` is not readable."],
  ["MODELBOT_MCP_TOKEN", "Same as MODELBOT_TOKEN; checked first."],
  ["MODELBOT_BOOTSTRAP_TOKEN", "One-time UI session token, required by `modelbot status`."],
  ["MODELBOT_SCOPED_TOKEN", "Per-task token a harness receives; set by the daemon, not by you."],
  ["MODELBOT_ENDPOINT", "Daemon base URL for the MCP stdio bridge."],
  ["MODELBOT_MCP_URL", "Full MCP endpoint URL, if it is not `<endpoint>/mcp`."],
  ["MODELBOT_BASE_URL", "Daemon base URL for CLI and flavour clients."],
  ["MODELBOT_VAULT_KEY_HEX", "32-byte hex vault master key, for headless hosts with no OS keychain."],
  ["MODELBOT_VAULT_PATH", "Overrides `vault.path` for `modelbot vault` commands."],
  ["MODELBOT_AUDIT_KEY_HEX", "Hex audit HMAC key for `modelbot audit verify` off-host."],
  ["MODELBOT_AUDIT_KEY", "Same key as raw text instead of hex."],
  ["MODELBOT_TOOL_PATH", "Extra directories searched before PATH when resolving a harness binary."],
  ["MODELBOT_CODEX_HOME", "Codex home directory; presence enables the Codex harness runner."],
  ["MODELBOT_CODEX_MODEL", "Model the Codex runner requests."],
  ["MODELBOT_INIT_FORCE", "`1` makes `modelbot init` overwrite an existing config."],
  ["MODELBOT_INIT_SKIP_DETECT", "`1` skips container-runtime detection during init."],
  ["MODELBOT_PROXY_SERVER", "Egress proxy URL for the container browser."],
  ["MODELBOT_PROXY_BYPASS", "Hosts that bypass that proxy."],
  ["MODELBOT_SECCOMP", "Path to the seccomp profile applied to the browser container."],
  ["MODELBOT_QUARANTINE", "In-container quarantine directory for downloads (default `/quarantine`)."],
  ["MODELBOT_PROFILE", "In-container browser profile directory."],
  ["MODELBOT_WORKSPACE", "In-container workspace mount point (default `/workspace`)."],
];

function main(): void {
  const schema = JSON.parse(readFileSync(SCHEMA, "utf8")) as JsonSchema;
  const rows: string[] = [];
  const topReq = new Set(schema.required ?? []);
  for (const [k, child] of Object.entries(schema.properties ?? {})) {
    walk(k, child, topReq, rows);
  }

  const defsRows: string[] = [];
  for (const [k, child] of Object.entries(schema.$defs ?? {})) {
    walk(k, child, new Set(child.required ?? []), defsRows, "$defs");
  }

  const md = `# BotHearth configuration reference

Generated from \`modelbot.schema.json\`. Do not hand-edit; re-run:

\`\`\`bash
node --experimental-strip-types scripts/gen-config-doc.ts
\`\`\`

Schema title: **${schema.title ?? "modelbot.yaml"}**.
${schema.description ? `\n${schema.description}\n` : ""}
## Zero configuration

Every section is optional. \`src/config/load.ts\` fills unset keys from its defaults
(\`withDefaults()\`) and the schema validates the result, so an empty \`modelbot.yaml\` is valid and
\`modelbot init\` writes only what the install decided:

\`\`\`yaml
version: 1
data_dir: /Users/you/ModelBot
adapters:
  default: openai_compat
  openai_compat:
    base_url: https://api.openai.com/v1
    model: gpt-5.6-sol
    api_key_vault: providers/openai
agent:
  spend_cap_usd: 20
\`\`\`

Set only what you want to change; a section merges key by key, so
\`agent: { spend_cap_usd: 5 }\` keeps every other \`agent\` default. Arrays replace wholesale —
a shorter \`policy.gates\` list is a weaker policy and has to be written out in full.
\`sandbox.workspace_root\`, \`audit.path\` and \`vault.path\` derive from \`data_dir\` unless set.
Security defaults (\`bind: 127.0.0.1\`, \`mode: supervised\`, all six \`policy.gates\`,
\`policy.kill_switch: true\`) apply when the config is silent; weakening one is an explicit edit.
The annotated full reference is \`src/config/example.yaml\`, copied into \`$MODELBOT_HOME\` by init.

## Fields

Nothing here has to appear in your own \`modelbot.yaml\`. The **Required** column marks only the
fields inside list entries and shared definitions (a scheduler routine, an adapter endpoint) where
a missing value is a real error rather than a defaulted one.

| Path | Type | Required | Constraints | Notes |
|---|---|---|---|---|
${rows.join("\n")}

## Shared definitions (\`$defs\`)

| Path | Type | Required | Constraints | Notes |
|---|---|---|---|---|
${defsRows.join("\n") || "| — | — | — | — | none |"}

## Environment variables

Environment overrides win over the file. Variables prefixed \`MODELBOT_TEST_\` are test and
development scaffolding, are not part of the product surface, and are not listed here.

| Variable | Purpose |
|---|---|
${ENV_VARS.map(([k, v]) => `| \`${k}\` | ${v} |`).join("\n")}

## See also

- Example config: \`docs/ARCHITECTURE.md\` §3
- Operator guide: \`docs/QUICKSTART.md\`
- Security defaults: \`SECURITY.md\`
`;

  writeFileSync(OUT, md);
  console.log(`wrote ${OUT} (${rows.length} fields)`);
}

main();
