/**
 * One classification of "the daemon could not start", shared by `modelbot start` and
 * `modelbot doctor` so both name the same cause and the same way out.
 *
 * A GUI parent (the Mac app) cannot parse human log prose, and the cost of that showed:
 * the app offered "Try again" for an undecryptable vault, and trying again could never
 * work. Startup failures therefore end with exactly one machine-readable stderr line
 * and a distinguishing exit code.
 *
 * Deliberately dependency-free (paths only) so `doctor` can reuse it without pulling in
 * the daemon.
 */
import { existsSync } from "node:fs";
import { configPath, modelbotHome, tokensPath } from "./paths.ts";

/**
 * What the caller should offer the user. Stable identifiers — the Mac shell switches on these
 * (`StartupError.actions` in apps/macos/Sources/DaemonSupervisor.swift) and shows a button only
 * for a name it knows. An unrecoverable failure must therefore say `none` rather than invent an
 * id, and a recoverable one must never fall back to `none`.
 */
export type RecoveryAction = "reset_vault_key" | "init" | "open_settings" | "none";

/** `sysexits.h` EX_CONFIG: the configuration or its vault is at fault, not the run. */
export const EX_CONFIG = 78;

export const STARTUP_ERROR_PREFIX = "MODELBOT_STARTUP_ERROR:";

interface StartupFailure {
  /** Plain English, one line, names the exact recovery command. Never contains "|". */
  message: string;
  action: RecoveryAction;
  /** EX_CONFIG for configuration/vault faults, 1 for everything else. */
  exitCode: number;
}

/** The line is `cause|action`, so neither field may carry a pipe or a newline. */
function oneLine(text: string): string {
  return text.replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Shell-safe enough to copy and paste; homes really do contain spaces. */
function quotePath(path: string): string {
  return /[^A-Za-z0-9._\/-]/.test(path) ? `"${path}"` : path;
}

/**
 * Vault errors are the ones a user can actually fix, and only with the explicit reset
 * flag — every vault failure mode in src/vault reports itself with a `vault:` prefix.
 */
function isVaultError(message: string): boolean {
  return /(^|\s)vault:/.test(message);
}

/**
 * This home has never been set up (or lost the files that setup writes), so no amount of editing
 * settings helps — only `init` does. Decided from the filesystem, not from error wording, because
 * the wording differs per missing file.
 */
function notInitialised(home: string): boolean {
  return !existsSync(configPath(home)) || !existsSync(tokensPath(home));
}

function isConfigError(message: string): boolean {
  return /modelbot\.yaml|tokens\.json|MCP token|adapter unavailable|schema|invalid config|must not be readable/i.test(
    message,
  );
}

export function classifyStartupError(
  err: unknown,
  homeOpt?: string,
): StartupFailure {
  const raw = err instanceof Error ? err.message : String(err);
  // Vault errors are multi-line by design (they explain themselves to a terminal user);
  // the first line is the cause, and the recovery command is re-stated here anyway.
  const cause = oneLine(raw.split("\n")[0] ?? "");
  const home = modelbotHome(homeOpt);

  if (isVaultError(raw)) {
    return {
      message: oneLine(
        `ModelBot could not unlock the encrypted vault for this home (${cause}). ` +
          `To discard the unreadable vault and start a new, empty one, run: ` +
          `modelbot init --home ${quotePath(home)} --reset-vault-key`,
      ),
      action: "reset_vault_key",
      exitCode: EX_CONFIG,
    };
  }

  if (notInitialised(home)) {
    return {
      message: oneLine(
        `ModelBot is not set up for this home yet (${cause}). ` +
          `To create its settings and keys, run: modelbot init --home ${quotePath(home)}`,
      ),
      action: "init",
      exitCode: EX_CONFIG,
    };
  }

  if (isConfigError(raw)) {
    return {
      message: oneLine(
        `ModelBot could not read its settings for this home (${cause}). ` +
          `Check ${quotePath(configPath(home))}.`,
      ),
      action: "open_settings",
      exitCode: EX_CONFIG,
    };
  }

  return {
    message: oneLine(cause || "ModelBot failed to start."),
    action: "none",
    exitCode: 1,
  };
}

/** `MODELBOT_STARTUP_ERROR: <plain English cause>|<recovery_action_id>` */
export function formatStartupErrorLine(failure: StartupFailure): string {
  return `${STARTUP_ERROR_PREFIX} ${failure.message}|${failure.action}`;
}
