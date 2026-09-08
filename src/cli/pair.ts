/** Host-owned recovery: one-use enrollment without restarting the daemon or browser. */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { configPath, expandHome, modelbotHome, parseFlags } from "./paths.ts";
import {
  loadModelbotSchema,
  loadModelbotYamlFile,
  validateModelbotConfig,
} from "../config/load.ts";
import { canonicalHttpsOrigin, deviceId } from "../daemon/auth.ts";
import { Store } from "../daemon/store.ts";

export function runPairCli(argv: string[]): void {
  const home = modelbotHome(parseFlags(argv).flags.home);
  const path = process.env.MODELBOT_CONFIG ?? configPath(home);
  if ((statSync(path).mode & 0o077) !== 0) throw new Error("ModelBot config must be private (mode 0600)");
  const config = validateModelbotConfig(loadModelbotYamlFile(path), loadModelbotSchema());
  const db = process.env.MODELBOT_SQLITE_PATH ?? join(expandHome(process.env.MODELBOT_DATA_DIR ?? config.data_dir), "modelbot.sqlite");
  if (!existsSync(db)) throw new Error("Start this ModelBot instance once before pairing a device");
  const remote = process.env.MODELBOT_PUBLIC_ORIGIN ?? config.remote.public_origin;
  const origin = remote ? canonicalHttpsOrigin(remote) : `http://127.0.0.1:${Number(process.env.MODELBOT_PORT ?? config.port)}`;
  const store = new Store(db);
  try {
    const revoke = argv.indexOf("--revoke");
    if (revoke >= 0) {
      const id = argv[revoke + 1];
      if (!id || !/^[a-f0-9]{32}$/.test(id)) throw new Error("Use a device ID from modelbot pair --list");
      const session = store.listSessions().find((entry) => deviceId(entry.id) === id);
      if (session) store.deleteSession(session.id);
      console.log("Device session revoked. Browser profiles and human control are preserved.");
    } else if (argv.includes("--list")) {
      for (const session of store.listSessions()) console.log(JSON.stringify({ id: deviceId(session.id), label: session.label, expires_at: session.expires_at }));
    } else {
      const pairing = store.createPairing(origin);
      if (!pairing) throw new Error("Too many unused pairing links; wait ten minutes");
      console.log(`Pair this device within ten minutes. Anyone holding this link gains full operator access.\n${pairing.url}`);
    }
  } finally { store.close(); }
}
