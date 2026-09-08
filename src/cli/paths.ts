/**
 * CLI paths under ~/.modelbot, and the shared `--key value` argv parser.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A flag with no value (last argument, or followed by another `--flag`) is
 * recorded as the string "true" so callers can test it without a second shape.
 */
export function parseFlags(argv: string[]): {
  flags: Record<string, string>;
  positionals: string[];
} {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = "true";
    }
  }
  return { flags, positionals };
}

export function modelbotHome(override?: string): string {
  return (
    override ??
    process.env.MODELBOT_HOME ??
    join(homedir(), ".modelbot")
  );
}

export function configPath(home = modelbotHome()): string {
  return join(home, "modelbot.yaml");
}

export function tokensPath(home = modelbotHome()): string {
  return join(home, "tokens.json");
}

export function pidPath(home = modelbotHome()): string {
  return join(home, "daemon.pid");
}

export function logPath(home = modelbotHome()): string {
  return join(home, "daemon.log");
}

export function defaultDataDir(): string {
  return process.env.MODELBOT_DATA_DIR ?? join(homedir(), "ModelBot");
}

/** Expand leading ~/ only. */
export function expandHome(p: string, home = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}
