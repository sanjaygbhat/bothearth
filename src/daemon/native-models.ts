import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { NativeProvider, NativeTaskSettings } from "../types/contracts.ts";
import { claudeEnvironment } from "./claude-code.ts";
import { toolPath } from "./resolve-tool.ts";

export type { NativeProvider, NativeTaskSettings } from "../types/contracts.ts";
export interface NativeModelOption {
  id: string;
  label: string;
  source: "native_cli" | "cache" | "documented" | "custom";
  /** A native listing is not proof of current quota or permission to generate. */
  access: "listed" | "unverified";
}
export interface NativeModelCatalog {
  provider: NativeProvider;
  default_model: string;
  models: NativeModelOption[];
  message?: string;
}

// Documented suggestions remain visibly unverified when native discovery fails.
// https://developers.openai.com/api/docs/models/gpt-6-astra
// https://platform.claude.com/docs/en/models/fable-5-1/overview
// https://platform.claude.com/docs/en/models/opus-5/overview
const documented = {
  codex: [{ id: "gpt-6-astra", label: "GPT-6 Astra" }],
  claude: [{ id: "claude-fable-5-1", label: "Claude Fable 5.1" }, { id: "claude-opus-5", label: "Claude Opus 5" }],
} satisfies Record<NativeProvider, { id: string; label: string }[]>;

function validModel(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+\[\]-]{0,511}$/.test(value);
}

function modelOptions(provider: NativeProvider, rows: unknown[], source: "native_cli" | "cache"): NativeModelOption[] {
  const options = new Map<string, NativeModelOption>();
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (row.hidden === true || row.visibility === "hide") continue;
    const id = provider === "codex" ? row.model ?? row.slug : row.resolvedModel ?? row.value;
    if (!validModel(id) || ["default", "best", "opusplan"].includes(id)) continue;
    const name = row.displayName ?? row.display_name;
    const description = typeof row.description === "string" ? row.description.split(" · ")[0] : "";
    const label = provider === "claude" && description ? description
      : typeof name === "string" && name.trim() ? name : id;
    options.set(id, { id, label: label.slice(0, 120), source, access: source === "native_cli" ? "listed" : "unverified" });
  }
  return [...options.values()];
}

type CatalogOptions = {
  home?: string; binary?: string; configuredModel?: string; computerId?: string;
  spawn?(args: string[]): Promise<{ child: ChildProcess; stop(): Promise<void> }>;
};
const cache = new Map<string, { until: number; promise: Promise<NativeModelCatalog> }>();

/** Ask the installed CLI for its model picker without starting an agent turn. */
async function listNativeModels(provider: NativeProvider, options: CatalogOptions): Promise<unknown[] | undefined> {
  const codex = provider === "codex";
  const args = codex ? ["app-server", "--stdio"] : ["--print", "--input-format", "stream-json", "--output-format", "stream-json",
    "--verbose", "--tools", "", "--disable-slash-commands", "--no-chrome", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--settings", '{"disableAllHooks":true}'];
  const env = codex ? { HOME: homedir(), PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
    LANG: process.env.LANG, TMPDIR: process.env.TMPDIR, CODEX_HOME: options.home ?? process.env.CODEX_HOME ?? join(homedir(), ".codex") }
    : claudeEnvironment(options.home ?? "");
  let owned: Awaited<ReturnType<NonNullable<CatalogOptions["spawn"]>>> | undefined;
  try { owned = await options.spawn?.(args); } catch { return; }
  return new Promise(resolve => {
    const child = owned?.child ?? spawn(options.binary ?? toolPath(provider), args, { env, cwd: homedir(), stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32" });
    child.stderr?.resume();
    let buffer = "", settled = false;
    const finish = (models?: unknown[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin?.end();
      if (owned) void owned.stop().catch(() => {});
      else if (child.pid) {
        try { process.platform === "win32" ? child.kill("SIGKILL") : process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
      }
      resolve(models);
    };
    const timer = setTimeout(() => finish(), 8000);
    child.once("error", () => finish());
    child.once("close", () => finish());
    if (!child.stdin || !child.stdout) { finish(); return; }
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) { finish(); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (!event || typeof event !== "object") continue;
        if (codex && event.id === 1) {
          if (event.error) { finish(); return; }
          child.stdin!.write(JSON.stringify({ method: "initialized" }) + "\n");
          child.stdin!.write(JSON.stringify({ id: 2, method: "model/list", params: { includeHidden: false, limit: 100 } }) + "\n");
        } else if (codex && event.id === 2) {
          finish(Array.isArray(event.result?.data) ? event.result.data : undefined);
        } else if (!codex && event.type === "control_response" && event.response?.request_id === "bothearth-models") {
          const models = event.response.response?.models;
          finish(event.response.subtype === "success" && Array.isArray(models) ? models : undefined);
        }
      }
    });
    const initialize = codex ? { id: 1, method: "initialize", params: { clientInfo: { name: "bothearth-model-picker", version: "1" }, capabilities: { experimentalApi: true } } }
      : { type: "control_request", request_id: "bothearth-models", request: { subtype: "initialize" } };
    child.stdin.write(JSON.stringify(initialize) + "\n");
  });
}

export function getNativeModelCatalog(provider: NativeProvider, options: CatalogOptions = {}): Promise<NativeModelCatalog> {
  const key = JSON.stringify([provider, options.home, options.binary, options.configuredModel, options.computerId]);
  const existing = cache.get(key);
  if (existing && existing.until > Date.now()) return existing.promise;
  const promise = (async () => {
    const native = await listNativeModels(provider, options);
    let models = native ? modelOptions(provider, native, "native_cli") : [];
    if (!models.length && provider === "codex" && !options.spawn) {
      try {
        const path = join(options.home ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"), "models_cache.json");
        const cached = JSON.parse(await readFile(path, "utf8"));
        if (Array.isArray(cached.models)) models = modelOptions(provider, cached.models, "cache");
      } catch { /* An absent or obsolete cache is not account availability. */ }
    }
    const listed = models.filter(model => model.access === "listed");
    const nativeDefault = native?.find(row => row && typeof row === "object" && (row as Record<string, unknown>).isDefault === true) as Record<string, unknown> | undefined;
    const newest = (family: string) => models.filter(model => model.id.startsWith(family))
      .sort((a, b) => b.id.localeCompare(a.id, "en", { numeric: true }))[0];
    const preferred = provider === "codex" ? models.find(model => model.id === nativeDefault?.model) ?? models[0]
      : newest("claude-fable-") ?? newest("claude-opus-");
    for (const model of documented[provider]) if (!models.some(option => option.id === model.id))
      models.push({ ...model, source: "documented", access: "unverified" });
    if (validModel(options.configuredModel) && !models.some(model => model.id === options.configuredModel))
      models.push({ id: options.configuredModel, label: options.configuredModel, source: "custom", access: "unverified" });
    return { provider, default_model: preferred?.id ?? documented[provider][0]!.id, models,
      message: listed.length ? "Listed by the native CLI. Account permissions and usage limits still apply."
        : "Model availability could not be refreshed. These suggestions are unverified; the selected CLI will check access when a task starts." };
  })();
  cache.set(key, { until: Date.now() + 60_000, promise });
  return promise;
}

/** Resolve once at task creation; resumes use the saved selection verbatim. */
export function resolveNativeTaskSettings(input: { adapter?: unknown; model?: unknown; execution_mode?: unknown; executor?: unknown; reasoning_effort?: unknown },
  defaults: { adapter: NativeProvider; model: string; models?: Partial<Record<NativeProvider, string>> }): NativeTaskSettings {
  const provider = (value: unknown): NativeProvider => {
    if (value !== "codex" && value !== "claude") throw new Error("Choose Codex or Claude Code.");
    return value;
  };
  const model = (value: unknown): string => {
    if (!validModel(value)) throw new Error("Enter a valid model ID without spaces (up to 512 characters).");
    if (["default", "best", "opusplan", "opus", "sonnet", "haiku"].includes(value.toLowerCase()))
      throw new Error("Choose an explicit model ID so your task cannot silently switch model families.");
    return value;
  };
  const defaultFor = (adapter: NativeProvider) => adapter === defaults.adapter && defaults.model
    ? defaults.model : defaults.models?.[adapter] ?? documented[adapter][0]!.id;
  const adapter = provider(input.adapter ?? defaults.adapter);
  const execution_mode = input.execution_mode ?? "executor";
  if (execution_mode !== "executor" && execution_mode !== "orchestrator") throw new Error("Choose executor or orchestrator mode.");
  const result: NativeTaskSettings = { adapter, model: model(input.model ?? defaultFor(adapter)), execution_mode };
  if (input.reasoning_effort !== undefined) {
    if (adapter !== "codex" || !["low", "medium", "high"].includes(input.reasoning_effort as string))
      throw new Error("Choose low, medium or high reasoning for Codex.");
    result.reasoning_effort = input.reasoning_effort as NativeTaskSettings["reasoning_effort"];
  }
  if (input.executor !== undefined) {
    if (execution_mode !== "orchestrator") throw new Error("Executor overrides apply when orchestration is on.");
    if (!input.executor || typeof input.executor !== "object" || Array.isArray(input.executor)) throw new Error("Choose an executor provider and model.");
    const executor = input.executor as Record<string, unknown>;
    const executorAdapter = provider(executor.adapter ?? adapter);
    result.executor = { adapter: executorAdapter, model: model(executor.model ?? (executorAdapter === adapter ? result.model : defaultFor(executorAdapter))) };
  } else if (execution_mode === "orchestrator") result.executor = { adapter, model: result.model };
  return result;
}
