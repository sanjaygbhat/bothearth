/**
 * `modelbot computer create|destroy` — sandbox lifecycle CLI.
 */
import { mkdir } from "node:fs/promises";
import {
  createComputer,
  createComputerCompose,
  defaultWorkspaceRoot,
  destroyComputer,
  destroyComputerCompose,
  ensureWorkspaceBrowserWritable,
  workspaceHostPath,
} from "../sandbox/index.ts";

interface ComputerCliResult {
  action: "create" | "destroy";
  name: string;
  compose: boolean;
  workspace: string;
}

function usage(): never {
  console.error(
    "usage: modelbot computer create <name> [--compose] [--workspace-root <dir>]\n" +
      "       modelbot computer destroy <name> [--compose] [--workspace-root <dir>] [--wipe-profile]",
  );
  process.exit(2);
}

export function parseComputerArgs(argv: string[]): {
  action: "create" | "destroy";
  name: string;
  compose: boolean;
  workspaceRoot?: string;
  wipeProfile: boolean;
} {
  if (argv.length === 0) usage();
  const action = argv[0];
  if (action !== "create" && action !== "destroy") usage();
  const name = argv[1];
  if (!name || name.startsWith("--")) usage();

  let compose = false;
  let workspaceRoot: string | undefined;
  let wipeProfile = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--compose") {
      compose = true;
    } else if (a === "--wipe-profile") {
      wipeProfile = true;
    } else if (a === "--workspace-root") {
      const next = argv[++i];
      if (!next) usage();
      workspaceRoot = next;
    } else if (a === "--help" || a === "-h") {
      usage();
    } else {
      console.error(`unknown flag: ${a}`);
      usage();
    }
  }
  return { action, name, compose, workspaceRoot, wipeProfile };
}

export async function runComputerCli(argv: string[]): Promise<ComputerCliResult> {
  const parsed = parseComputerArgs(argv);
  const workspaceRoot = parsed.workspaceRoot ?? defaultWorkspaceRoot();
  const workspace = workspaceHostPath(parsed.name, workspaceRoot);
  await mkdir(workspace, { recursive: true, mode: 0o700 });

  if (parsed.action === "create") {
    ensureWorkspaceBrowserWritable(workspace);
    if (parsed.compose) {
      await createComputerCompose(
        parsed.name,
        { capabilities: ["browser", "shell"] },
        { workspaceRoot },
      );
    } else {
      await createComputer(
        parsed.name,
        { capabilities: ["browser", "shell"] },
        { workspaceRoot },
      );
    }
    console.log(
      JSON.stringify({
        ok: true,
        action: "create",
        name: parsed.name,
        compose: parsed.compose,
        workspace,
      }),
    );
    return {
      action: "create",
      name: parsed.name,
      compose: parsed.compose,
      workspace,
    };
  }

  if (parsed.compose) {
    await destroyComputerCompose(parsed.name, {
      workspaceRoot,
      keepProfile: !parsed.wipeProfile,
    });
  } else {
    await destroyComputer(
      parsed.name,
      { keepProfile: !parsed.wipeProfile },
      { workspaceRoot },
    );
  }
  console.log(
    JSON.stringify({
      ok: true,
      action: "destroy",
      name: parsed.name,
      compose: parsed.compose,
      workspace,
    }),
  );
  return {
    action: "destroy",
    name: parsed.name,
    compose: parsed.compose,
    workspace,
  };
}
