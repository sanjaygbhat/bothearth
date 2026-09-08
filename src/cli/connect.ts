/**
 * `modelbot connect <harness>` — write harness MCP config.
 * Flags: --print (dry-run), --remove, --config <path>, --home <dir>,
 *        --codex-home <dir> (Codex only; writes $CODEX_HOME/config.toml)
 */
import {
  applyConnect,
  HARNESSES,
  isHarness,
  type ConnectOptions,
  type ConnectResult,
  type Harness,
} from "./connect-writers.ts";

export type { ConnectOptions, ConnectResult, Harness };

function usage(): never {
  console.error(
    `usage: modelbot connect <${HARNESSES.join("|")}> [--print] [--remove] [--config <path>] [--home <dir>] [--codex-home <dir>]`,
  );
  process.exit(2);
}

function parseConnectArgs(argv: string[]): {
  harness: Harness;
  opts: ConnectOptions;
} {
  if (argv.length === 0) usage();
  const harnessArg = argv[0]!;
  if (!isHarness(harnessArg)) {
    console.error(`unknown harness: ${harnessArg}`);
    usage();
  }
  const opts: ConnectOptions = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--print") {
      opts.print = true;
    } else if (a === "--remove") {
      opts.remove = true;
    } else if (a === "--config") {
      const next = argv[++i];
      if (!next) usage();
      opts.config = next;
    } else if (a === "--home") {
      const next = argv[++i];
      if (!next) usage();
      opts.home = next;
    } else if (a === "--codex-home") {
      const next = argv[++i];
      if (!next) usage();
      opts.codexHome = next;
    } else if (a === "--help" || a === "-h") {
      usage();
    } else {
      console.error(`unknown flag: ${a}`);
      usage();
    }
  }
  return { harness: harnessArg, opts };
}

export function runConnect(argv: string[]): ConnectResult {
  const { harness, opts } = parseConnectArgs(argv);
  const result = applyConnect(harness, opts);
  if (opts.print) {
    process.stdout.write(result.content);
    if (!result.content.endsWith("\n") && result.content.length > 0) {
      process.stdout.write("\n");
    }
    if (
      result.content.includes("MODELBOT_TOKEN") ||
      result.content.includes("bearer_token_env_var")
    ) {
      console.error(`# dry-run ${harness} → ${result.path} (includes MODELBOT_TOKEN)`);
    } else {
      console.error(`# dry-run ${harness} → ${result.path}`);
    }
  } else {
    console.log(result.summary);
  }
  return result;
}
