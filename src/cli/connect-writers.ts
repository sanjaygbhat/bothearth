/**
 * Harness MCP config writers. Shapes from docs/HARNESS-INTEGRATIONS.md.
 * Never embed raw tokens.
 */
import {
  copyFileSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { TOOL_NAMES } from "../types/contracts.ts";

const MCP_URL = "http://127.0.0.1:7777/mcp";
const MCP_TOKEN_ENV = "MODELBOT_TOKEN";
const SERVER_NAME = "modelbot";

export const HARNESSES = [
  "codex",
  "claude",
  "gemini",
  "cursor",
  "opencode",
  "copilot",
] as const;

export type Harness = (typeof HARNESSES)[number];

export function isHarness(s: string): s is Harness {
  return (HARNESSES as readonly string[]).includes(s);
}

export interface ConnectOptions {
  /** Override HOME for path resolution (tests). */
  home?: string;
  /** Explicit Codex CODEX_HOME (config.toml parent). */
  codexHome?: string;
  /** Explicit config file path. */
  config?: string;
  cwd?: string;
  print?: boolean;
  remove?: boolean;
}

export interface ConnectResult {
  harness: Harness;
  path: string;
  action: "wrote" | "unchanged" | "removed" | "absent" | "print";
  backupPath?: string;
  content: string;
  summary: string;
}

const ENABLED_TOOLS = [...TOOL_NAMES];

/** Codex `[mcp_servers.modelbot]` block — golden source. */
function renderCodexSection(): string {
  const rows: string[] = [];
  for (let i = 0; i < ENABLED_TOOLS.length; i += 5) {
    const chunk = ENABLED_TOOLS.slice(i, i + 5);
    const isLast = i + 5 >= ENABLED_TOOLS.length;
    rows.push(
      "  " +
        chunk.map((t) => `"${t}"`).join(", ") +
        (isLast ? "" : ","),
    );
  }
  return [
    `[mcp_servers.${SERVER_NAME}]`,
    `url = "${MCP_URL}"`,
    `bearer_token_env_var = "${MCP_TOKEN_ENV}"`,
    `startup_timeout_sec = 30`,
    `tool_timeout_sec = 300`,
    `enabled = true`,
    `# generated from src/tools/schemas — do not hand-edit drift`,
    `enabled_tools = [`,
    ...rows,
    `]`,
    `default_tools_approval_mode = "prompt"`,
    ``,
  ].join("\n");
}

function renderClaudeServerEntry(): Record<string, unknown> {
  return {
    type: "http",
    url: MCP_URL,
    headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV}}` },
  };
}

function renderClaudeMcpJson(): string {
  return stableJson({ mcpServers: { [SERVER_NAME]: renderClaudeServerEntry() } });
}

function renderGeminiServerEntry(): Record<string, unknown> {
  return {
    httpUrl: MCP_URL,
    headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV}}` },
    timeout: 300000,
  };
}

function renderCursorServerEntry(): Record<string, unknown> {
  return {
    url: MCP_URL,
    headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV}}` },
  };
}

function renderOpenCodeServerEntry(): Record<string, unknown> {
  return {
    type: "remote",
    url: MCP_URL,
    enabled: true,
    timeout: 300000,
    headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV}}` },
  };
}

function renderCopilotServerEntry(): Record<string, unknown> {
  return {
    type: "http",
    url: MCP_URL,
    headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV}}` },
    toolInvocationTimeout: 300,
  };
}

export function renderHarnessFragment(harness: Harness): string {
  switch (harness) {
    case "codex":
      return renderCodexSection();
    case "claude":
      return renderClaudeMcpJson();
    case "gemini":
      return stableJson({ mcpServers: { [SERVER_NAME]: renderGeminiServerEntry() } });
    case "cursor":
      return stableJson({ mcpServers: { [SERVER_NAME]: renderCursorServerEntry() } });
    case "opencode":
      return stableJson({
        $schema: "https://opencode.ai/config.json",
        mcp: { [SERVER_NAME]: renderOpenCodeServerEntry() },
      });
    case "copilot":
      return stableJson({ mcpServers: { [SERVER_NAME]: renderCopilotServerEntry() } });
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function resolveConfigPath(
  harness: Harness,
  opts: ConnectOptions = {},
): string {
  if (opts.config) return opts.config;
  const home = opts.home ?? process.env.HOME ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  switch (harness) {
    case "codex": {
      const codexHome =
        opts.codexHome ?? process.env.CODEX_HOME ?? join(home, ".codex");
      return join(codexHome, "config.toml");
    }
    case "claude":
      return join(cwd, ".mcp.json");
    case "gemini":
      return join(
        process.env.GEMINI_CONFIG_DIR ?? join(home, ".gemini"),
        "settings.json",
      );
    case "cursor":
      return join(home, ".cursor", "mcp.json");
    case "opencode":
      return join(cwd, "opencode.json");
    case "copilot":
      return join(
        process.env.COPILOT_HOME ?? join(home, ".copilot"),
        "mcp-config.json",
      );
  }
}

/** Strip `[mcp_servers.modelbot]` (+ nested) from TOML text. */
function stripCodexModelbotSection(toml: string): string {
  const lines = toml.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const table = line.match(/^\[([^\]]+)\]\s*$/);
    if (table) {
      const name = table[1]!;
      if (
        name === `mcp_servers.${SERVER_NAME}` ||
        name.startsWith(`mcp_servers.${SERVER_NAME}.`)
      ) {
        skipping = true;
        continue;
      }
      skipping = false;
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n*$/, "\n");
}

function mergeCodexConfig(existing: string | null, remove: boolean): string {
  const base = existing ? stripCodexModelbotSection(existing) : "";
  if (remove) {
    return base === "\n" || base === "" ? "" : base;
  }
  const section = renderCodexSection();
  if (!base.trim()) return section;
  const trimmed = base.replace(/\n*$/, "\n");
  return trimmed.endsWith("\n\n")
    ? trimmed + section
    : trimmed + "\n" + section;
}

type JsonDoc = Record<string, unknown>;

function parseJsonFile(raw: string | null): JsonDoc {
  if (!raw || !raw.trim()) return {};
  const v = JSON.parse(raw) as unknown;
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error("config root must be a JSON object");
  }
  return v as JsonDoc;
}

function mergeMcpServers(
  doc: JsonDoc,
  entry: Record<string, unknown> | null,
): JsonDoc {
  const servers =
    doc.mcpServers && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers)
      ? { ...(doc.mcpServers as Record<string, unknown>) }
      : {};
  if (entry === null) {
    delete servers[SERVER_NAME];
  } else {
    servers[SERVER_NAME] = entry;
  }
  const next: JsonDoc = { ...doc };
  if (Object.keys(servers).length === 0) {
    delete next.mcpServers;
  } else {
    next.mcpServers = servers;
  }
  return next;
}

function mergeJsonHarness(
  harness: Exclude<Harness, "codex">,
  existing: string | null,
  remove: boolean,
): string {
  const doc = parseJsonFile(existing);
  if (harness === "opencode") {
    const mcp =
      doc.mcp && typeof doc.mcp === "object" && !Array.isArray(doc.mcp)
        ? { ...(doc.mcp as Record<string, unknown>) }
        : {};
    if (remove) {
      delete mcp[SERVER_NAME];
    } else {
      mcp[SERVER_NAME] = renderOpenCodeServerEntry();
    }
    const next: JsonDoc = { ...doc };
    if (!next.$schema) {
      next.$schema = "https://opencode.ai/config.json";
    }
    if (Object.keys(mcp).length === 0) {
      delete next.mcp;
    } else {
      next.mcp = mcp;
    }
    if (Object.keys(next).length === 0) return "";
    return stableJson(next);
  }

  let entry: Record<string, unknown> | null = null;
  if (!remove) {
    switch (harness) {
      case "claude":
        entry = renderClaudeServerEntry();
        break;
      case "gemini":
        entry = renderGeminiServerEntry();
        break;
      case "cursor":
        entry = renderCursorServerEntry();
        break;
      case "copilot":
        entry = renderCopilotServerEntry();
        break;
    }
  }
  const next = mergeMcpServers(doc, remove ? null : entry);
  if (Object.keys(next).length === 0) return "";
  return stableJson(next);
}

function computeNewContent(
  harness: Harness,
  existing: string | null,
  remove: boolean,
): string {
  if (harness === "codex") {
    return mergeCodexConfig(existing, remove);
  }
  return mergeJsonHarness(harness, existing, remove);
}

function backupFile(path: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`refusing symlink config: ${path}`);
  const bak = `${path}.bak`;
  copyFileSync(path, bak);
  chmodSync(bak, Math.min(stat.mode & 0o777, 0o600));
  return bak;
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  let mode = 0o600;
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`refusing symlink config: ${path}`);
    mode = Math.min(stat.mode & 0o777, 0o600);
  }
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    writeSync(fd, content, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  chmodSync(path, mode);
  const dirFd = openSync(dirname(path), constants.O_RDONLY);
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

export function applyConnect(
  harness: Harness,
  opts: ConnectOptions = {},
): ConnectResult {
  const path = resolveConfigPath(harness, opts);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
  const content = computeNewContent(harness, existing, opts.remove === true);

  if (opts.print) {
    return {
      harness,
      path,
      action: "print",
      content,
      summary: `print ${harness} → ${path} (${content.length} bytes)`,
    };
  }

  if (opts.remove) {
    if (existing === null) {
      return {
        harness,
        path,
        action: "absent",
        content: "",
        summary: `no file at ${path}; nothing to remove`,
      };
    }
    if (content === existing || (content === "" && existing.trim() === "")) {
      if (content === "" && existsSync(path)) {
        const bak = backupFile(path);
        atomicWrite(path, "");
        return {
          harness,
          path,
          action: "removed",
          backupPath: bak,
          content,
          summary: `removed modelbot from ${path} (backup ${bak})`,
        };
      }
      return {
        harness,
        path,
        action: "unchanged",
        content,
        summary: `modelbot already absent in ${path}`,
      };
    }
    const bak = backupFile(path);
    atomicWrite(path, content);
    return {
      harness,
      path,
      action: "removed",
      backupPath: bak,
      content,
      summary: `removed modelbot from ${path} (backup ${bak})`,
    };
  }

  if (existing !== null && existing === content) {
    return {
      harness,
      path,
      action: "unchanged",
      content,
      summary: `unchanged ${path}`,
    };
  }

  let backupPath: string | undefined;
  if (existing !== null) {
    backupPath = backupFile(path);
  }
  atomicWrite(path, content);
  return {
    harness,
    path,
    action: "wrote",
    backupPath,
    content,
    summary: backupPath
      ? `wrote ${path} (backup ${backupPath})`
      : `wrote ${path}`,
  };
}
