/**
 * `modelbot deploy` / `modelbot deploy destroy`.
 */

import {
  deploy,
  destroy,
  type DeployOptions,
  type DeployProviderName,
} from "../deploy/index.ts";
import { readFileSync, statSync } from "node:fs";
import { parseFlags } from "./paths.ts";

/** "true" is the parser's marker for a flag given without a value, never a real value here. */
function flagStr(
  flags: Record<string, string>,
  key: string,
): string | undefined {
  const v = flags[key];
  return v === "true" ? undefined : v;
}

function printSteps(
  title: string,
  steps: Array<{ id: string; summary: string; command: string }>,
): void {
  console.log(title);
  for (const s of steps) {
    console.log(`  [${s.id}] ${s.summary}`);
    console.log(`    ${s.command}`);
  }
}

export async function runDeploy(argv: string[]): Promise<void> {
  const { flags, positionals } = parseFlags(argv);

  if (positionals[0] === "destroy") {
    const name = positionals[1] ?? flagStr(flags, "name");
    if (!name) {
      console.error("usage: modelbot deploy destroy <name> [--yes] [--dry-run]");
      process.exit(2);
    }
    if (!flags.yes && !flags["dry-run"]) {
      console.error("refusing destroy without --yes (typed confirm deferred)");
      process.exit(2);
    }
    const result = await destroy({
      name,
      yes: flags.yes === "true",
      dryRun: flags["dry-run"] === "true",
      token: flagStr(flags, "token"),
      tokenEnv: flagStr(flags, "token-env"),
    });
    printSteps(
      result.dryRun ? "destroy dry-run steps:" : "destroy steps:",
      result.steps,
    );
    console.log(result.deleted ? `deleted ${name}` : `destroy incomplete for ${name}`);
    return;
  }

  const provider = (positionals[0] ?? "ssh") as DeployProviderName;
  if (provider !== "ssh" && provider !== "hetzner") {
    console.error(`unsupported provider: ${provider} (mvp: ssh|hetzner)`);
    process.exit(2);
  }

  const name = flagStr(flags, "name") ?? "modelbot";
  const tailscaleFile = flagStr(flags, "tailscale-authkey-file");
  if (flagStr(flags, "token") || flagStr(flags, "tailscale-authkey")) {
    throw new Error("deploy: secret-bearing --token/--tailscale-authkey arguments are forbidden");
  }
  if (tailscaleFile && (statSync(tailscaleFile).mode & 0o077) !== 0) {
    throw new Error("deploy: tailscale auth-key file must be mode 0600");
  }
  const opts: DeployOptions = {
    name,
    provider,
    host: flagStr(flags, "host"),
    user: flagStr(flags, "user"),
    sshKeyPath: flagStr(flags, "ssh-key"),
    tarballPath: flagStr(flags, "tarball"),
    tailscaleAuthkey: tailscaleFile ? readFileSync(tailscaleFile, "utf8").trim() : undefined,
    tailscaleServe: flags["tailscale-serve"] === "true",
    publicOrigin: flagStr(flags, "public-origin"),
    systemdCredential: flagStr(flags, "systemd-credential"),
    tokenEnv: flagStr(flags, "token-env"),
    region: flagStr(flags, "region"),
    arch: flagStr(flags, "arch") as "amd64" | "arm64" | undefined,
    serverType: flagStr(flags, "server-type"),
    image: flagStr(flags, "image"),
    ipv4: flags.ipv4 === "true",
    dryRun: flags["dry-run"] === "true",
    yes: flags.yes === "true",
    suggestSignup: flags["suggest-signup"] === "true" || provider === "hetzner",
  };

  if (provider === "ssh" && !opts.host && !opts.dryRun) {
    console.error("ssh deploy requires --host user-target hostname");
    process.exit(2);
  }
  if (provider === "ssh" && !opts.host) {
    opts.host = "example.invalid";
  }

  const { result, signupLines } = await deploy(opts);
  for (const line of signupLines) console.log(line);
  printSteps(
    result.dryRun
      ? `deploy ${provider} dry-run steps:`
      : result.skippedCreate
        ? `deploy ${provider} (idempotent skip create):`
        : `deploy ${provider} steps:`,
    result.steps,
  );
  console.log(`access: ${result.accessHint}`);
  if (result.serverId) console.log(`server_id: ${result.serverId}`);
}
