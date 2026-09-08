#!/usr/bin/env node
/**
 * ARCH §5 entry: `node computer-server/stdio.js --role browser|shell`
 * Re-exec with type stripping so .ts sources run on Node 22 (container) and 24 (host).
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "stdio.ts");
const child = spawn(
  process.execPath,
  ["--experimental-strip-types", entry, ...process.argv.slice(2)],
  { stdio: "inherit", env: process.env },
);
// The child owns the browser, so it — not this wrapper — must see the signal
// and close Chromium; dying here would orphan it and leave the profile locked.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  // Re-raising below only kills this process once our own handlers are gone.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.removeAllListeners(signal);
  }
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
