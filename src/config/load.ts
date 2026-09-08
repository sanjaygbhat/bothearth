import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { ModelbotConfig } from "../types/contracts.ts";
import { assertValid, type JsonSchemaLike } from "../schema/validate.ts";

export function loadModelbotYamlFile(path: string): unknown {
  return parseYaml(readFileSync(path, "utf8"));
}

/** modelbot.yaml with every unset key filled in, for callers that read one section. */
export function loadConfigDoc(path: string): Record<string, unknown> {
  return withDefaults(loadModelbotYamlFile(path)) as Record<string, unknown>;
}

/** The schema ships at the package root, two levels up from this module. */
export function loadModelbotSchema(): JsonSchemaLike {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../modelbot.schema.json", import.meta.url)),
      "utf8",
    ),
  ) as JsonSchemaLike;
}

type Doc = Record<string, unknown>;

function isPlainObject(v: unknown): v is Doc {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Every section of modelbot.yaml is optional. These are the values a config
 * gets when it says nothing — identical to `src/config/example.yaml`, which
 * stays the annotated full reference. Security defaults live here too: loopback
 * bind, supervised mode, all six policy gates, kill switch on. Weakening one is
 * an explicit edit in the user's own config, never an omission.
 */
function defaultConfigDoc(): Doc {
  return {
    version: 1,
    bind: "127.0.0.1",
    port: 7777,
    auth: { mcp_token_env: "MODELBOT_TOKEN" },
    data_dir: "~/ModelBot",
    updates: { check: false },
    mode: "supervised",
    policy: {
      gates: [
        "external_send",
        "payment",
        "upload",
        "delete",
        "secret_entry",
        "new_domain",
      ],
      categories_path: "policy/categories.json",
      tos_risk_path: "policy/tos-risk.json",
      strict_allowlist: [],
      kill_switch: true,
      approval_ttl_sec: 900,
    },
    sandbox: {
      runtime: "auto",
      image_browser: "modelbot/computer:dev",
      image_shell: "modelbot/shell:dev",
      memory: "2g",
      cpus: 2,
      shm_size: "1g",
      max_computers: 2,
      idle_pause_min: 10,
      capabilities: ["browser"],
    },
    browser: {
      max_tabs: 5,
      default_tabs: 1,
      snapshot_max_chars: 16000,
      screenshot_max: 2,
      screenshot_jpeg_q: 60,
    },
    agent: {
      max_steps: 400,
      loop_identical: 3,
      stall_sec: 300,
      spend_cap_usd: 20.0,
      spend_cap_max_usd: 100.0,
      max_runtime_sec: 0,
      context_tokens_max: 120000,
      compact_at: 0.6,
      token_cap_in: null,
      token_cap_out: null,
    },
    adapters: {
      default: "openai_compat",
      openai_compat: {
        base_url: "https://api.openai.com/v1",
        model: "gpt-5.5",
        api_key_vault: "providers/openai",
      },
      anthropic: {
        model: "claude-sonnet-4-5",
        api_key_vault: "providers/anthropic",
      },
    },
    mcp: {
      server: { http_path: "/mcp", stdio_bridge: true, tool_timeout_sec: 300 },
      connectors: [],
    },
    takeover: { ttl_sec: 600, notify: [] },
    scheduler: { enabled: true, routines: [] },
    remote: { access: "tailscale" },
    audit: {},
    vault: { keychain: "auto" },
  };
}

/** `~/ModelBot` + `computers` → `~/ModelBot/computers`, `~` left for expandHome. */
function childPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

/**
 * Assigning these from parsed YAML mutates the merged object's prototype rather
 * than setting a key. The config is owner-controlled so this is not exploitable
 * today, but a merge that silently does something other than what it says is a
 * trap for whoever next feeds this function something less trusted.
 */
const FORBIDDEN_MERGE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function deepMerge(base: Doc, over: Doc): Doc {
  const out: Doc = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined || FORBIDDEN_MERGE_KEYS.has(k)) continue;
    const b = out[k];
    out[k] = isPlainObject(b) && isPlainObject(v) ? deepMerge(b, v) : v;
  }
  return out;
}

/**
 * Fill every unset key from the defaults above. Objects merge key by key so a
 * config may set one knob (`agent: { spend_cap_usd: 5 }`) without restating its
 * section; arrays replace wholesale, because a partial gate list is a weaker
 * policy and must be written out in full to be chosen.
 *
 * `sandbox.workspace_root`, `audit.path` and `vault.path` derive from
 * `data_dir`, so moving the data directory moves all three with it.
 */
export function withDefaults(raw: unknown): unknown {
  assertKnownSections(raw);
  const merged = deepMerge(
    defaultConfigDoc(),
    isPlainObject(raw) ? raw : {},
  );
  // `agent.spend_cap_usd` written on its own is a ceiling, not a starting point.
  // Filling `spend_cap_max_usd` from the built-in $100 let a request raise a
  // configured $2 cap fifty-fold. `raw` is the only place the difference is
  // visible: after the merge both keys are set and neither says who set it.
  const rawAgent = isPlainObject(raw) && isPlainObject(raw.agent) ? raw.agent : {};
  if (rawAgent.spend_cap_usd !== undefined && rawAgent.spend_cap_max_usd === undefined) {
    (merged.agent as Doc).spend_cap_max_usd = rawAgent.spend_cap_usd;
  }
  const dataDir = typeof merged.data_dir === "string" ? merged.data_dir : "~/ModelBot";
  const sandbox = merged.sandbox as Doc;
  const audit = merged.audit as Doc;
  const vault = merged.vault as Doc;
  sandbox.workspace_root ??= childPath(dataDir, "computers");
  audit.path ??= childPath(dataDir, "audit.jsonl");
  vault.path ??= childPath(dataDir, "vault.enc");
  return merged;
}

/**
 * Defaults fill every unset key before the schema runs, which means a mistyped
 * section name (`polciy:`) would otherwise merge in as a harmless extra key and
 * the owner would get the strict defaults while believing their setting took.
 * Fail-safe, but silent — so name the key instead.
 */
function assertKnownSections(raw: unknown): void {
  if (!isPlainObject(raw)) return;
  const known = new Set(Object.keys(defaultConfigDoc()));
  const unknown = Object.keys(raw).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `config: unknown setting${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")}. ` +
      `Check the spelling — ModelBot would otherwise use its defaults and your setting would never take effect. ` +
      `Valid sections: ${[...known].sort().join(", ")}.`,
    );
  }
}

/**
 * Defaults first, then validate: the schema checks the config the daemon will
 * actually run, not the fragment the user typed.
 */
export function validateModelbotConfig(
  value: unknown,
  schema: JsonSchemaLike,
): ModelbotConfig {
  const filled = withDefaults(value);
  assertValid(schema, filled);
  return filled as ModelbotConfig;
}
