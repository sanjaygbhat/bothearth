#!/usr/bin/env node
/**
 * WP20 — fail on banned marketing claims in launch surfaces.
 * Patterns: unlimited | any subscription | already pay for
 * Also flags: any model or subscription
 *
 * Usage: node --experimental-strip-types scripts/claim-scan.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = [
  "README.md",
  "docs/QUICKSTART.md",
  "website/index.html",
];

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "unlimited", re: /\bunlimited\b/i },
  { name: "any subscription", re: /\bany subscription\b/i },
  { name: "already pay for", re: /\balready pay for\b/i },
  { name: "any model or subscription", re: /\bany model or subscription\b/i },
];

function main(): void {
  const hits: string[] = [];
  for (const rel of TARGETS) {
    const path = join(ROOT, rel);
    if (!existsSync(path)) {
      hits.push(`MISSING ${rel}`);
      continue;
    }
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const p of PATTERNS) {
        if (p.re.test(line)) {
          hits.push(`${rel}:${i + 1}: ${p.name}: ${line.trim()}`);
        }
      }
    });
  }

  if (hits.length) {
    console.error("claim-scan FAIL");
    for (const h of hits) console.error(`  ${h}`);
    process.exit(1);
  }
  console.log(`claim-scan OK (${TARGETS.length} files)`);
}

main();
