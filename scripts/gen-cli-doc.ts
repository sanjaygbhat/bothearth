#!/usr/bin/env node
/**
 * WP20 — generate docs/CLI.md from `modelbot --help` output.
 * Usage: node --experimental-strip-types scripts/gen-cli-doc.ts
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "CLI.md");

function main(): void {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(ROOT, "src/cli/index.ts"), "--help"],
    { encoding: "utf8", cwd: ROOT },
  );
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout || "help failed");
    process.exit(r.status ?? 1);
  }
  const help = (r.stdout ?? "").trim();
  if (!help.includes("Commands:") && !help.toLowerCase().includes("usage")) {
    console.error("help output missing expected sections");
    process.exit(1);
  }

  const md = `# BotHearth CLI reference

Generated from \`modelbot --help\`. The \`bothearth\` alias runs the same command. Do not hand-edit; re-run:

\`\`\`bash
node --experimental-strip-types scripts/gen-cli-doc.ts
\`\`\`

## Help output

\`\`\`text
${help}
\`\`\`

## Notes

- Bind defaults to loopback (\`127.0.0.1\`). Public bind requires an explicit unsafe flag.
- Harness mode: \`modelbot connect <codex|claude|gemini|…>\` writes official MCP config; subscriptions stay inside those harnesses.
- Standalone mode: provider keys live in the host vault; never mounted into sandbox containers.
- Remote mode: \`modelbot deploy\` targets a VM you own; never expose the live-view port publicly (use Tailscale / SSH).

## See also

- Quickstart: \`docs/QUICKSTART.md\`
- Config: \`docs/CONFIG.md\`
- Troubleshooting: \`docs/TROUBLESHOOTING.md\`
`;

  writeFileSync(OUT, md);
  console.log(`wrote ${OUT} (${help.split("\n").length} help lines)`);
}

main();
