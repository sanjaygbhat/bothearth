#!/usr/bin/env node
/**
 * modelbot CLI entry: parse the command, dispatch, exit.
 */
import { resolve } from "node:path";
import { VERSION } from "../index.ts";
import { verifyAuditFile } from "../audit/verify.ts";
import { AUDIT_VERIFY_KEY_HELP, resolveAuditVerifyKey } from "./audit-key.ts";
import { configPath, expandHome, modelbotHome, parseFlags } from "./paths.ts";

async function auditVerify(argv: string[]): Promise<void> {
  const { flags } = parseFlags(argv);
  let configuredPath = "audit.jsonl";
  if (!flags.path) {
    const { loadConfigDoc } = await import("../config/load.ts");
    const config = loadConfigDoc(
      flags.config ?? process.env.MODELBOT_CONFIG ?? configPath(modelbotHome(flags.home)),
    ) as { audit: { path: string } };
    configuredPath = expandHome(config.audit.path);
  }
  const path = resolve(flags.path ?? configuredPath);
  const key = await resolveAuditVerifyKey(flags);
  const result = verifyAuditFile(key, path);
  if (result.ok) {
    console.log(`OK ${result.records} records`);
    process.exit(0);
  }
  console.error(`FAIL seq=${result.seq ?? "?"} reason=${result.reason}`);
  process.exit(1);
}

function printHelp(): void {
  console.log(`BotHearth ${VERSION}`);
  console.log(`
Usage: modelbot <command> [flags]
Alias: bothearth <command> [flags] (same command; existing modelbot paths are retained)

Commands:
  init [--home DIR] [--data-dir DIR] [--bind ADDR] [--port N]
       [--force] [--skip-detect] [--skip-images] [--quiet]
       [--keychain auto] [--reset-vault-key]
  start [--port N] [--host ADDR] [--home DIR] [--daemon] [--no-open]
        [--allow-public-bind] [--ready-json]
  stop [--home DIR]
  pair [--home DIR] [--list | --revoke DEVICE_ID]
       Print a fresh sign-in link when the last one expired
  doctor [--home DIR] [--config PATH] [--json]
  security audit
  image pull|build
  mcp-stdio
  audit verify [--path FILE] [--key-file FILE] [--home DIR] [--config PATH]
       ${AUDIT_VERIFY_KEY_HELP}
  vault set|get|rm|ls|rotate [--path P] [--value-file F]
  connect <codex|claude|gemini|cursor|opencode|copilot>
          [--print] [--remove] [--config PATH] [--home DIR]
          [--codex-home DIR]
  status [--watch] [--json] [--pid] [--daemon] [--home DIR]
  computer create|destroy <name> [--compose] [--workspace-root DIR]
             [--wipe-profile]
  routine add --name N --cron EXPR --computer NAME --goal TEXT
          [--notify URI] [--origin URL] [--shell] [--disabled] [--db PATH]
  routine ls|run|rm [id-or-name] [--db PATH]
  deploy [ssh|hetzner] [--name N] [--host H] [--user U] [--ssh-key PATH]
         [--tarball PATH] [--tailscale-authkey-file FILE]
         [--tailscale-serve] [--public-origin https://HOST]
         [--systemd-credential /REMOTE/PATH.cred]
         [--token-env E] [--region R] [--arch amd64|arm64]
         [--server-type T] [--image I] [--ipv4] [--dry-run] [--yes]
         [--suggest-signup]
  deploy destroy <name> [--yes] [--dry-run] [--token T] [--token-env E]
  version | --version | -V

Global:
  --help | -h     Show this help
  --version | -V  Print version

Docs: docs/CLI.md (generated), docs/QUICKSTART.md, docs/CONFIG.md
`.trim());
}

async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    printHelp();
    return;
  }

  if (cmd === "mcp-stdio") {
    const { runMcpStdioBridge } = await import("../mcp/stdio-bridge.ts");
    await runMcpStdioBridge();
    return;
  }

  if (cmd === "audit" && args[1] === "verify") {
    await auditVerify(args.slice(2));
    return;
  }

  if (cmd === "pair") {
    const { runPairCli } = await import("./pair.ts");
    runPairCli(args.slice(1));
    return;
  }

  if (cmd === "init") {
    const { runInit } = await import("./init.ts");
    await runInit(args.slice(1));
    return;
  }

  if (cmd === "start") {
    const { flags } = parseFlags(args.slice(1));
    const open = !args.includes("--no-open");
    if (args.includes("--daemon")) {
      const { spawnDaemon } = await import("./daemon-ctl.ts");
      const { announceBootstrapUrl } = await import("./start.ts");
      const { pid, bootstrapUrl } = await spawnDaemon(args.slice(1), flags.home);
      console.log(`daemon started pid=${pid}`);
      announceBootstrapUrl(bootstrapUrl, { open });
      return;
    }
    const { runStart, reportStartupFailure } = await import("./start.ts");
    try {
      await runStart({
        port: flags.port ? Number(flags.port) : undefined,
        host: flags.host,
        home: flags.home,
        allowPublicBind: args.includes("--allow-public-bind"),
        readyJson: args.includes("--ready-json"),
        open,
      });
    } catch (err) {
      // Never falls through to the generic handler below: a GUI parent needs the
      // machine-readable cause and the EX_CONFIG/1 split.
      reportStartupFailure(err, flags.home);
    }
    return;
  }

  if (cmd === "stop") {
    const { runStop } = await import("./daemon-ctl.ts");
    await runStop(args.slice(1));
    return;
  }

  if (cmd === "doctor") {
    const { runDoctorCli } = await import("./doctor.ts");
    const code = await runDoctorCli(args.slice(1));
    process.exit(code);
  }

  if (cmd === "security" && args[1] === "audit") {
    const { runDoctorCli } = await import("./doctor.ts");
    process.exit(await runDoctorCli(args.slice(2)));
  }

  if (cmd === "image") {
    const { runImageCli } = await import("./image.ts");
    await runImageCli(args.slice(1));
    return;
  }

  if (cmd === "deploy") {
    const { runDeploy } = await import("./deploy.ts");
    await runDeploy(args.slice(1));
    return;
  }

  if (cmd === "vault") {
    const { runVaultCli } = await import("./vault.ts");
    await runVaultCli(args.slice(1));
    return;
  }

  if (cmd === "connect") {
    const { runConnect } = await import("./connect.ts");
    runConnect(args.slice(1));
    return;
  }

  if (cmd === "status") {
    if (args.includes("--pid") || args.includes("--daemon")) {
      const { runStatus } = await import("./daemon-ctl.ts");
      await runStatus(args.slice(1));
      return;
    }
    const { runStatus } = await import("./status.ts");
    await runStatus(args.slice(1));
    return;
  }

  if (cmd === "computer") {
    const { runComputerCli } = await import("./computer.ts");
    await runComputerCli(args.slice(1));
    return;
  }

  if (cmd === "routine") {
    const { runRoutineCli } = await import("./routine.ts");
    await runRoutineCli(args.slice(1));
    return;
  }

  if (cmd === "version" || cmd === "--version" || cmd === "-V") {
    console.log(VERSION);
    return;
  }

  printHelp();
}

main(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
