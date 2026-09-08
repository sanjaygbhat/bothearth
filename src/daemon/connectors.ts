/**
 * Connector broker: config registry, approval gate, digest pin.
 *
 * Browser-session connectors = named persistent computers (`persistent: true`)
 * with per-site notes for login continuity. Cookies stay in the computer profile;
 * host never exports them to the model.
 *
 * MCP connectors run host-side after the user approves listed tools. Descriptions
 * are wrapped as untrusted data and never merged into the system prompt.
 * No OAuth DCR in MVP — env comes from the vault.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ConnectorMcpClient,
  DEFAULT_CONNECTOR_TIMEOUT_MS,
  manifestDigest,
  wrapUntrustedToolDescription,
  type ConnectorToolDescriptor,
} from "../mcp/client.ts";
import { toolError } from "../protocol/errors.ts";
import type { ToolResult } from "../types/contracts.ts";
import { loadConnectorEnv } from "../vault/integrate.ts";
import type { Vault } from "../vault/types.ts";
import { logInfo, logWarn } from "./log.ts";

type McpStdioConnectorConfig = {
  id: string;
  kind: "mcp_stdio";
  command: string;
  args?: string[];
  cwd?: string;
  /** Vault env names under connectors/<id>/<NAME>. */
  env?: string[];
  timeout_ms?: number;
};

export type McpHttpConnectorConfig = {
  id: string;
  kind: "mcp_http";
  url: string;
  headers?: Record<string, string>;
  env?: string[];
  timeout_ms?: number;
};

/** Named persistent computer for site login cookies. */
type BrowserSessionConnectorConfig = {
  id: string;
  kind: "browser_session";
  origin: string;
  computer_name: string;
  persistent: true;
  notes?: string;
};

export type ConnectorConfig =
  | McpStdioConnectorConfig
  | McpHttpConnectorConfig
  | BrowserSessionConnectorConfig;

type PendingToolView = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ConnectorPublicView = {
  id: string;
  kind: ConnectorConfig["kind"];
  status: "configured" | "discovered" | "approved" | "stale_manifest";
  approved_tools: string[];
  pending_tools: PendingToolView[];
  manifest_digest: string | null;
  origin?: string;
  computer_name?: string;
  persistent?: boolean;
  notes?: string;
};

type ApprovalRecord = {
  manifest_digest: string;
  approved_tools: string[];
};

type ApprovalFile = {
  version: 1;
  connectors: Record<string, ApprovalRecord>;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** Parse modelbot.yaml `mcp.connectors` entries. */
export function parseConnectorConfigs(raw: unknown): ConnectorConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: ConnectorConfig[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const kind = typeof item.kind === "string" ? item.kind : "";
    if (!id) continue;
    if (kind === "mcp_stdio") {
      if (typeof item.command !== "string" || !item.command) continue;
      out.push({
        id,
        kind: "mcp_stdio",
        command: item.command,
        args: Array.isArray(item.args)
          ? item.args.filter((a): a is string => typeof a === "string")
          : undefined,
        cwd: typeof item.cwd === "string" ? item.cwd : undefined,
        env: Array.isArray(item.env)
          ? item.env.filter((a): a is string => typeof a === "string")
          : undefined,
        timeout_ms:
          typeof item.timeout_ms === "number" ? item.timeout_ms : undefined,
      });
    } else if (kind === "mcp_http") {
      if (typeof item.url !== "string" || !item.url) continue;
      out.push({
        id,
        kind: "mcp_http",
        url: item.url,
        headers: isRecord(item.headers)
          ? Object.fromEntries(
              Object.entries(item.headers).filter(
                (e): e is [string, string] => typeof e[1] === "string",
              ),
            )
          : undefined,
        env: Array.isArray(item.env)
          ? item.env.filter((a): a is string => typeof a === "string")
          : undefined,
        timeout_ms:
          typeof item.timeout_ms === "number" ? item.timeout_ms : undefined,
      });
    } else if (kind === "browser_session") {
      if (typeof item.origin !== "string" || !item.origin) continue;
      if (typeof item.computer_name !== "string" || !item.computer_name) {
        continue;
      }
      if (item.persistent !== true) continue;
      out.push({
        id,
        kind: "browser_session",
        origin: item.origin,
        computer_name: item.computer_name,
        persistent: true,
        notes: typeof item.notes === "string" ? item.notes : undefined,
      });
    }
  }
  return out;
}

function connectorError(e: unknown): ToolResult {
  const msg = e instanceof Error ? e.message : String(e);
  return (e as { code?: string }).code === "E_TIMEOUT"
    ? toolError("E_TIMEOUT", msg)
    : toolError("E_IO", msg);
}

export type ConnectorBrokerOpts = {
  dataDir: string;
  configs: ConnectorConfig[];
  vault?: Vault;
  connectStdio?: typeof ConnectorMcpClient.connectStdio;
  connectHttp?: typeof ConnectorMcpClient.connectHttp;
};

export class ConnectorBroker {
  private readonly dataDir: string;
  private readonly configs: Map<string, ConnectorConfig>;
  private readonly vault: Vault | undefined;
  private readonly connectStdio: typeof ConnectorMcpClient.connectStdio;
  private readonly connectHttp: typeof ConnectorMcpClient.connectHttp;
  private approvals: ApprovalFile = { version: 1, connectors: {} };
  private discovered = new Map<string, ConnectorToolDescriptor[]>();
  private sessions = new Map<string, ConnectorMcpClient>();

  constructor(opts: ConnectorBrokerOpts) {
    this.dataDir = opts.dataDir;
    this.configs = new Map(opts.configs.map((c) => [c.id, c]));
    this.vault = opts.vault;
    this.connectStdio = opts.connectStdio ?? ConnectorMcpClient.connectStdio;
    this.connectHttp = opts.connectHttp ?? ConnectorMcpClient.connectHttp;
  }

  async init(): Promise<void> {
    await mkdir(join(this.dataDir, "connectors"), { recursive: true });
    await this.loadApprovals();
  }

  list(): ConnectorPublicView[] {
    return [...this.configs.values()].map((c) => this.viewOf(c));
  }

  get(id: string): ConnectorPublicView | undefined {
    const c = this.configs.get(id);
    return c ? this.viewOf(c) : undefined;
  }

  async discover(id: string): Promise<ConnectorPublicView> {
    const cfg = this.configs.get(id);
    if (!cfg) throw new Error(`unknown connector: ${id}`);
    if (cfg.kind === "browser_session") return this.viewOf(cfg);

    const client = await this.ensureSession(cfg);
    const tools = await client.listTools();
    this.discovered.set(id, tools);
    const digest = manifestDigest(tools);
    const prev = this.approvals.connectors[id];
    if (prev && prev.manifest_digest !== digest) {
      logWarn("connector_manifest_changed", { connector_id: id });
      delete this.approvals.connectors[id];
      await this.saveApprovals();
    }
    logInfo("connector_discovered", {
      connector_id: id,
      tool_count: tools.length,
      digest: digest.slice(0, 12),
    });
    return this.viewOf(cfg);
  }

  async approve(id: string, toolNames: string[]): Promise<ConnectorPublicView> {
    const cfg = this.configs.get(id);
    if (!cfg) throw new Error(`unknown connector: ${id}`);
    if (cfg.kind === "browser_session") return this.viewOf(cfg);

    let tools = this.discovered.get(id);
    if (!tools) {
      await this.discover(id);
      tools = this.discovered.get(id) ?? [];
    }
    const digest = manifestDigest(tools);
    const allowed = new Set(tools.map((t) => t.name));
    const approved = [
      ...new Set(toolNames.filter((n) => allowed.has(n))),
    ].sort();
    this.approvals.connectors[id] = {
      manifest_digest: digest,
      approved_tools: approved,
    };
    await this.saveApprovals();
    logInfo("connector_tools_approved", {
      connector_id: id,
      approved_count: approved.length,
    });
    return this.viewOf(cfg);
  }

  /** Approved tools only; descriptions wrapped as untrusted. */
  listApprovedForModel(): Array<{
    connector_id: string;
    tool: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    const out: Array<{
      connector_id: string;
      tool: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }> = [];
    for (const cfg of this.configs.values()) {
      if (cfg.kind === "browser_session") continue;
      const rec = this.approvals.connectors[cfg.id];
      const tools = this.discovered.get(cfg.id) ?? [];
      if (!rec) continue;
      if (manifestDigest(tools) !== rec.manifest_digest) continue;
      for (const t of tools) {
        if (!rec.approved_tools.includes(t.name)) continue;
        out.push({
          connector_id: cfg.id,
          tool: t.name,
          description: wrapUntrustedToolDescription(cfg.id, t.description),
          inputSchema: t.inputSchema,
        });
      }
    }
    return out;
  }

  async call(
    connectorId: string,
    tool: string,
    args: Record<string, unknown> | null,
  ): Promise<ToolResult> {
    const cfg = this.configs.get(connectorId);
    if (!cfg) {
      return toolError("E_POLICY", `unknown connector: ${connectorId}`);
    }
    if (cfg.kind === "browser_session") {
      return toolError(
        "E_CAPABILITY",
        "browser_session connectors use persistent computers + browser tools, not connector_call",
        {
          computer_name: cfg.computer_name,
          origin: cfg.origin,
          persistent: true,
        },
      );
    }

    let tools = this.discovered.get(connectorId);
    if (!tools) {
      try {
        await this.discover(connectorId);
        tools = this.discovered.get(connectorId) ?? [];
      } catch (e) {
        return connectorError(e);
      }
    }

    const digest = manifestDigest(tools);
    const rec = this.approvals.connectors[connectorId];
    if (!rec || rec.manifest_digest !== digest) {
      return toolError(
        "E_POLICY_PENDING",
        "connector tools require user approval",
        {
          connector_id: connectorId,
          tool,
          pending_tools: tools.map((t) => t.name),
        },
      );
    }
    if (!rec.approved_tools.includes(tool)) {
      return toolError("E_POLICY_PENDING", `tool not approved: ${tool}`, {
        connector_id: connectorId,
        tool,
      });
    }

    try {
      const client = await this.ensureSession(cfg);
      const result = await client.callTool(tool, args);
      return {
        ok: true,
        data: {
          connector_id: connectorId,
          tool,
          content: result.content,
          isError: result.isError === true,
          truncated: result.truncated === true,
        },
      };
    } catch (e) {
      return connectorError(e);
    }
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((s) => s.close().catch(() => undefined)));
  }

  private viewOf(cfg: ConnectorConfig): ConnectorPublicView {
    if (cfg.kind === "browser_session") {
      return {
        id: cfg.id,
        kind: cfg.kind,
        status: "configured",
        approved_tools: [],
        pending_tools: [],
        manifest_digest: null,
        origin: cfg.origin,
        computer_name: cfg.computer_name,
        persistent: true,
        notes: cfg.notes,
      };
    }
    const tools = this.discovered.get(cfg.id) ?? [];
    const digest = tools.length ? manifestDigest(tools) : null;
    const rec = this.approvals.connectors[cfg.id];
    const matched = Boolean(rec && digest && rec.manifest_digest === digest);
    let status: ConnectorPublicView["status"] = "configured";
    if (tools.length && !rec) status = "discovered";
    if (matched) status = "approved";
    if (rec && digest && !matched) status = "stale_manifest";
    const approved = new Set(matched ? rec!.approved_tools : []);
    const pending_tools: PendingToolView[] = tools
      .filter((t) => !approved.has(t.name))
      .map((t) => ({
        name: t.name,
        description: wrapUntrustedToolDescription(cfg.id, t.description),
        inputSchema: t.inputSchema,
      }));
    return {
      id: cfg.id,
      kind: cfg.kind,
      status,
      approved_tools: matched ? [...rec!.approved_tools] : [],
      pending_tools,
      manifest_digest: digest,
    };
  }

  private async ensureSession(
    cfg: McpStdioConnectorConfig | McpHttpConnectorConfig,
  ): Promise<ConnectorMcpClient> {
    const existing = this.sessions.get(cfg.id);
    if (existing) return existing;

    const envNames = cfg.env ?? [];
    let env: Record<string, string> = {};
    if (envNames.length && this.vault) {
      env = await loadConnectorEnv(this.vault, cfg.id, envNames);
    }
    const secretValues = Object.values(env);
    if (envNames.length) {
      logInfo("connector_env_loaded", {
        connector_id: cfg.id,
        env_keys: envNames,
      });
    }

    const timeoutMs = cfg.timeout_ms ?? DEFAULT_CONNECTOR_TIMEOUT_MS;
    let client: ConnectorMcpClient;
    if (cfg.kind === "mcp_stdio") {
      client = await this.connectStdio({
        command: cfg.command,
        args: cfg.args,
        cwd: cfg.cwd,
        env,
        timeoutMs,
        secretValues,
      });
    } else {
      const headers: Record<string, string> = { ...(cfg.headers ?? {}) };
      if (env.AUTHORIZATION && !headers.Authorization) {
        headers.Authorization = env.AUTHORIZATION;
      } else if (env.BEARER_TOKEN && !headers.Authorization) {
        headers.Authorization = `Bearer ${env.BEARER_TOKEN}`;
      }
      client = await this.connectHttp({
        url: cfg.url,
        headers,
        timeoutMs,
        secretValues,
      });
    }
    this.sessions.set(cfg.id, client);
    return client;
  }

  private approvalsPath(): string {
    return join(this.dataDir, "connectors", "approvals.json");
  }

  private async loadApprovals(): Promise<void> {
    try {
      const raw = await readFile(this.approvalsPath(), "utf8");
      const parsed = JSON.parse(raw) as ApprovalFile;
      if (parsed?.version === 1 && isRecord(parsed.connectors)) {
        this.approvals = parsed;
      }
    } catch {
      this.approvals = { version: 1, connectors: {} };
    }
  }

  private async saveApprovals(): Promise<void> {
    await mkdir(join(this.dataDir, "connectors"), { recursive: true });
    await writeFile(
      this.approvalsPath(),
      `${JSON.stringify(this.approvals, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
}
