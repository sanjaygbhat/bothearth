/**
 * `modelbot start` — bind the loopback daemon.
 * MCP token: env MODELBOT_MCP_TOKEN / MODELBOT_TOKEN, else ~/.modelbot/tokens.json.
 * Bootstrap: minted fresh each start, printed, hash-only on disk.
 * Fake computer: MODELBOT_TEST_FAKE_COMPUTER=1.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { canonicalHttpsOrigin } from "../daemon/auth.ts";
import { startDaemon, type DaemonOptions } from "../daemon/server.ts";
import { readLicencePolicy } from "../daemon/licence.ts";
import { logInfo, logError } from "../daemon/log.ts";
import { clearOwnPid } from "./daemon-ctl.ts";
import { configPath, expandHome, modelbotHome, tokensPath } from "./paths.ts";
import { classifyStartupError, formatStartupErrorLine } from "./startup-error.ts";
import { mintStartBootstrapToken, resolveRuntimeTokens } from "./tokens.ts";
import {
  loadModelbotSchema,
  loadModelbotYamlFile,
  validateModelbotConfig,
} from "../config/load.ts";
import { openVault } from "../vault/vault.ts";
import { ensureAuditHmacKey, resolveProviderApiKey, vaultAuditKeyProvider } from "../vault/integrate.ts";
import { AuditLog } from "../audit/log.ts";
import { createAdapter, registeredAdapterNames } from "../adapters/index.ts";
import { parseConnectorConfigs } from "../daemon/connectors.ts";
import type { AdapterEndpointConfig, ModelbotConfig, ProviderAdapter } from "../types/contracts.ts";

interface StartCliOptions {
  host?: string;
  port?: number;
  allowPublicBind?: boolean;
  home?: string;
  /** Print the ready handshake as one JSON line instead of the human line. */
  readyJson?: boolean;
  /** macOS only: open the link in the default browser. Default true. */
  open?: boolean;
}

/** The one-line handshake a parent process (the Mac app) parses from stdout. */
interface ReadyMessage {
  type: "modelbot.ready";
  port: number;
  bootstrap_url: string;
  pid: number;
}

interface ProductionComposition {
  daemon: DaemonOptions;
  config: ModelbotConfig;
  bootstrapToken: string;
}

/**
 * A loopback model server (Ollama, LM Studio, vLLM) needs no API key. Loopback
 * only: an mDNS `*.local` name is claimable by anything on the LAN, and treating
 * it as trusted flipped `credentialed` — and so `task_start_available` — on for
 * a host ModelBot has no key for and no reason to trust.
 */
export function isLocalEndpoint(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  } catch {
    return false;
  }
}

function assertPrivateFile(path: string): void {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`${path} must not be readable or writable by group/other (mode ${mode.toString(8)})`);
  }
}

export async function buildProductionComposition(
  opts: StartCliOptions = {},
): Promise<ProductionComposition> {
  const home = modelbotHome(opts.home);
  const cfgPath = process.env.MODELBOT_CONFIG ?? configPath(home);
  assertPrivateFile(cfgPath);
  const config = validateModelbotConfig(loadModelbotYamlFile(cfgPath), loadModelbotSchema());
  const tokFile = tokensPath(home);
  const mcpToken = resolveRuntimeTokens(tokFile).mcp_token;
  if (!mcpToken) throw new Error("empty MCP token");

  const vaultPath = expandHome(config.vault.path);
  const vault = await openVault({ path: vaultPath, keychain: config.vault.keychain });
  await ensureAuditHmacKey(vault);
  const auditPath = expandHome(config.audit.path);
  const newAudit = !existsSync(auditPath) && !existsSync(`${auditPath}.head`);
  const auditLog = new AuditLog({
    path: auditPath,
    keyProvider: vaultAuditKeyProvider(vault),
  });
  // A fresh install needs a signed head before its first task. Existing logs
  // and heads stay untouched so doctor can still detect missing/truncated data.
  if (newAudit) await auditLog.appendAnchor();

  // `adapters.<name>` blocks, keyed by registered adapter name (`default` aside).
  const endpoints = config.adapters as unknown as Record<
    string,
    AdapterEndpointConfig | undefined
  >;
  const adapters: Record<string, ProviderAdapter> = {};
  const adapterKeys: Record<string, string | undefined> = {};
  for (const name of registeredAdapterNames()) {
    const endpoint = endpoints[name];
    if (!endpoint) continue;
    adapterKeys[name] = await resolveProviderApiKey(endpoint, vault);
    adapters[name] = createAdapter({ name, endpoint, apiKey: adapterKeys[name] });
  }
  // Own properties only: `adapters["constructor"]` is `Object` — truthy, so it
  // passes the check below and fails much later as a non-adapter.
  const defaultName = config.adapters.default;
  const defaultAdapter = Object.hasOwn(adapters, defaultName) ? adapters[defaultName] : undefined;
  if (!defaultAdapter) throw new Error(`configured adapter unavailable: ${defaultName}`);
  const defaultEndpoint = endpoints[config.adapters.default];
  // The example config names a model with no key. Without this, a fresh install
  // reported "Connected" and offered a Start button that could only fail.
  const credentialed = Boolean(adapterKeys[config.adapters.default])
    || isLocalEndpoint(defaultEndpoint?.base_url);

  const dataDir = expandHome(process.env.MODELBOT_DATA_DIR ?? config.data_dir);
  const workspaceRoot = expandHome(
    process.env.MODELBOT_WORKSPACE_ROOT ?? config.sandbox.workspace_root,
  );
  const persistPaths = [tokFile];
  const dataTok = join(dataDir, "tokens.json");
  if (existsSync(dataTok)) persistPaths.push(dataTok);
  const bootstrapToken = mintStartBootstrapToken(mcpToken, persistPaths);
  return {
    config,
    bootstrapToken,
    daemon: {
      host: opts.host ?? process.env.MODELBOT_HOST ?? process.env.MODELBOT_BIND ?? config.bind,
      port: opts.port ?? Number(process.env.MODELBOT_PORT ?? config.port),
      allowPublicBind: opts.allowPublicBind === true || process.env.MODELBOT_ALLOW_PUBLIC_BIND === "1",
      mcpToken,
      bootstrapToken,
      sqlitePath: process.env.MODELBOT_SQLITE_PATH ?? join(dataDir, "modelbot.sqlite"),
      workspaceRoot,
      idlePauseMin: config.sandbox.idle_pause_min,
      schedulerEnabled: config.scheduler.enabled,
      ...(process.env.MODELBOT_CODEX_HOME ? { codexRunner: {
        codexHome: expandHome(process.env.MODELBOT_CODEX_HOME),
        model: process.env.MODELBOT_CODEX_MODEL ?? "gpt-6-astra",
      } } : {}),
      allowedHosts: config.remote.allowed_hosts ?? [],
      publicOrigin: process.env.MODELBOT_PUBLIC_ORIGIN ?? config.remote.public_origin,
      headless: Boolean(process.env.SSH_CONNECTION)
        || (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY),
      vault,
      auditLog,
      mode: config.mode,
      declaredOrigins: {
        readable: config.policy.strict_allowlist,
        writable: config.policy.strict_allowlist,
      },
      connectorConfigs: parseConnectorConfigs(config.mcp.connectors),
      // Without this the config key is inert and the dispatcher keeps its own default.
      approvalTtlSec: config.policy.approval_ttl_sec,
      takeoverTtlSec: config.takeover.ttl_sec,
      maxSteps: config.agent.max_steps,
      spendCapMaxUsd: config.agent.spend_cap_max_usd,
      maxRuntimeSec: config.agent.max_runtime_sec,
      dataDir,
      autoConnectProvider: true,
      nativeExecutionLocation: "computer",
      licencePolicy: readLicencePolicy(process.env.BOTHEARTH_LICENCE_POLICY),
      agentLoop: {
        adapter: defaultAdapter,
        adapters,
        credentialed,
        model: defaultEndpoint?.model ?? config.adapters.openai_compat.model,
        models: Object.fromEntries(
          Object.entries(config.adapters)
            .filter((entry): entry is [string, { model: string }] =>
              Boolean(entry[1]) && typeof entry[1] === "object" && typeof entry[1].model === "string",
            )
            .map(([name, endpoint]) => [name, endpoint.model]),
        ),
        spendCapUsd: config.agent.spend_cap_usd,
        compactAt: config.agent.compact_at,
        contextTokensMax: config.agent.context_tokens_max,
        tokenCapIn: config.agent.token_cap_in,
        loopIdentical: config.agent.loop_identical,
        stallSec: config.agent.stall_sec,
        snapshotMaxBytes: config.browser.snapshot_max_chars,
        mode: config.mode,
        declaredOrigins: {
          readable: config.policy.strict_allowlist,
          writable: config.policy.strict_allowlist,
        },
      },
    },
  };
}

/**
 * macOS default browser. No log holds the token, but `open`'s argv does, so
 * any process running as this user can read the link out of `ps` until it is
 * used or its ten minutes are up.
 */
function openWithFinder(url: string): void {
  spawn("open", [url], { stdio: "ignore", detached: true }).unref();
}

/**
 * A browser window is only ever wanted in front of a person who just typed
 * `modelbot start`. Without stdout being a terminal this is a test, a packaging
 * run, a `--daemon` child or the Mac shell's daemon — every one of which used to
 * throw a window onto the owner's screen at a link that dies with the process.
 */
function interactiveTerminal(): boolean {
  return (
    process.stdout.isTTY === true &&
    !process.env.CI &&
    !process.env.MODELBOT_NO_OPEN
  );
}

/**
 * The one place the bootstrap link reaches a human: two stdout lines, plus the
 * browser on macOS. `start --daemon` calls this from the parent, whose stdout is
 * the terminal — the detached child's stdout is the log file, so it stays quiet.
 */
export function announceBootstrapUrl(
  url: string,
  deps: {
    open: boolean;
    platform?: NodeJS.Platform;
    log?: (line: string) => void;
    openUrl?: (url: string) => void;
    /** Tests only. Real callers are judged by `interactiveTerminal()`. */
    interactive?: boolean;
  },
): void {
  const log = deps.log ?? console.log;
  log(`Open ${url}`);
  log("This link works for 10 minutes. Lost it? Run: modelbot pair");
  if (!deps.open) return;
  if (!(deps.interactive ?? interactiveTerminal())) return;
  if ((deps.platform ?? process.platform) !== "darwin") return;
  (deps.openUrl ?? openWithFinder)(url);
}

export async function runStart(opts: StartCliOptions = {}): Promise<void> {
  const composition = await buildProductionComposition(opts);
  const handle = await startDaemon(composition.daemon);

  const bootstrapUrl = `${composition.daemon.publicOrigin ? canonicalHttpsOrigin(composition.daemon.publicOrigin) : handle.baseUrl}/#bootstrap=${composition.bootstrapToken}`;
  const ready: ReadyMessage = {
    type: "modelbot.ready",
    port: handle.port,
    bootstrap_url: bootstrapUrl,
    pid: process.pid,
  };
  // The token leaves this process on one channel only, and the log keeps the
  // base URL alone. A Node parent (`start --daemon`, the test harness) gets it
  // over IPC and prints it itself; printing here would put it in daemon.log.
  if (opts.readyJson) console.log(JSON.stringify(ready));
  else if (!process.send) announceBootstrapUrl(bootstrapUrl, { open: opts.open !== false });
  logInfo("modelbot start ready", { baseUrl: handle.baseUrl, port: handle.port });

  const shutdown = async (signal: string) => {
    logInfo("shutdown", { signal });
    let code = 0;
    try {
      await handle.close();
    } catch (err) {
      logError("shutdown failed", { err: String(err) });
      code = 1;
    }
    // Otherwise the pid file outlives the process and the next `start --daemon`
    // reads a dead pid as a running daemon and refuses to start.
    clearOwnPid(opts.home);
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.send?.(ready);
}

/**
 * The daemon's last word on stderr, for a parent process that has no other way to know
 * why it died. The human log line above it is unchanged; this adds one parseable line
 * and an exit code that separates "your configuration is wrong" (EX_CONFIG) from
 * "something else went wrong" (1).
 */
export function reportStartupFailure(err: unknown, homeOpt?: string): never {
  const failure = classifyStartupError(err, homeOpt);
  logError("start failed", { err: String(err) });
  process.stderr.write(`${formatStartupErrorLine(failure)}\n`);
  process.exit(failure.exitCode);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runStart().catch((err) => reportStartupFailure(err));
}
