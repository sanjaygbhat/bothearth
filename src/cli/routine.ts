/**
 * `modelbot routine add|ls|run|rm`.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfigDoc } from "../config/load.ts";
import { RoutinesStore } from "../scheduler/index.ts";
import type { ComputerCapability } from "../types/contracts.ts";
import { configPath, defaultDataDir, expandHome, modelbotHome, parseFlags } from "./paths.ts";

function dbPath(flags: Record<string, string>): string {
  const explicitPath = flags.db ?? process.env.MODELBOT_SQLITE_PATH ?? process.env.MODELBOT_SQLITE;
  if (explicitPath) return resolve(expandHome(explicitPath));
  const cfgPath = flags.config ?? process.env.MODELBOT_CONFIG ?? configPath(modelbotHome(flags.home));
  const configured = existsSync(cfgPath) ? loadConfigDoc(cfgPath).data_dir as string : undefined;
  const dataDir = process.env.MODELBOT_DATA_DIR ?? configured ?? defaultDataDir();
  return resolve(expandHome(join(dataDir, "modelbot.sqlite")));
}

export async function runRoutineCli(argv: string[]): Promise<void> {
  const { flags, positionals } = parseFlags(argv);
  const sub = positionals[0];
  if (!sub || sub === "help" || flags.help === "true") {
    console.log("modelbot routine add|ls|run|rm");
    console.log(
      "  add --name N --cron '0 9 * * 1' --computer NAME --goal TEXT [--notify URI] [--origin URL]",
    );
    console.log("  ls [--db PATH]");
    console.log("  run <id-or-name> [--db PATH]");
    console.log("  rm <id-or-name> [--db PATH]");
    return;
  }

  const store = new RoutinesStore(dbPath(flags));
  try {
    if (sub === "ls") {
      for (const r of store.list()) {
        const pub = store.toPublic(r);
        console.log(
          `${pub.id}\t${pub.name}\t${pub.cron}\t${pub.computer_name}\tenabled=${pub.enabled}\tnext=${pub.next_run_at ?? "-"}`,
        );
      }
      return;
    }

    if (sub === "add") {
      const name = flags.name ?? positionals[1];
      const cron = flags.cron;
      const computer = flags.computer ?? flags["computer-name"];
      const goal = flags.goal;
      if (!name || !cron || !computer || !goal) {
        console.error("routine add requires --name --cron --computer --goal");
        process.exit(2);
      }
      const caps: ComputerCapability[] = flags.shell
        ? ["browser", "shell"]
        : ["browser"];
      const created = store.create({
        name,
        cron,
        computer_name: computer,
        task: {
          goal,
          capabilities: caps,
          origins: flags.origin ? [flags.origin] : undefined,
        },
        notify: flags.notify ? [flags.notify] : [],
        notify_on: ["fail"],
        enabled: flags.disabled !== "true",
      });
      console.log(created.id);
      return;
    }

    if (sub === "run") {
      const idOrName = flags.id ?? positionals[1];
      if (!idOrName) {
        console.error("routine run requires <id-or-name>");
        process.exit(2);
      }
      const r = store.get(idOrName) ?? store.getByName(idOrName);
      if (!r) {
        console.error(`routine not found: ${idOrName}`);
        process.exit(1);
      }
      store.setNextRun(r.id, new Date().toISOString());
      const hist = store.insertHistory({
        routine_id: r.id,
        status: "skipped",
        error: "queued for daemon tick (CLI run)",
        started_at: new Date(),
      });
      console.log(`${r.id}\tqueued\thistory=${hist.id}`);
      return;
    }

    if (sub === "rm") {
      const idOrName = flags.id ?? positionals[1];
      if (!idOrName) {
        console.error("routine rm requires <id-or-name>");
        process.exit(2);
      }
      const r = store.get(idOrName) ?? store.getByName(idOrName);
      if (!r || !store.remove(r.id)) {
        console.error(`routine not found: ${idOrName}`);
        process.exit(1);
      }
      console.log(`removed ${r.id}`);
      return;
    }

    console.error(`unknown routine subcommand: ${sub}`);
    process.exit(2);
  } finally {
    store.close();
  }
}
