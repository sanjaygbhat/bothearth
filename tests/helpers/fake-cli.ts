import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeCli {
  /** Temp directory used as CODEX_HOME / CLAUDE_CONFIG_DIR and as scratch space. */
  home: string;
  binary: string;
  path(name: string): string;
}

/** A throwaway home holding an executable Node script that stands in for a model CLI. */
export function fakeCli(prefix: string, script: (home: string) => string, name = "cli.mjs"): FakeCli {
  const home = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const binary = join(home, name);
  writeFileSync(binary, `#!/usr/bin/env node\n${script(home)}`, { mode: 0o700 });
  return { home, binary, path: (entry: string) => join(home, entry) };
}
