#!/usr/bin/env node
/**
 * Guard known copy regressions across every configured website page.
 * This is a drift check, not proof that arbitrary prose is true.
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
  "website/site.json",
  ...JSON.parse(readFileSync(join(ROOT, "website/site.json"), "utf8")).pages
    .map((page: { file: string }) => `website/${page.file}`),
];

const PATTERNS: Array<{ name: string; re: RegExp; allow?: RegExp[] }> = [
  { name: "unlimited", re: /\bunlimited\b/i },
  { name: "any subscription", re: /\bany subscription\b/i },
  { name: "already pay for", re: /\balready pay for\b/i },
  { name: "any model or subscription", re: /\bany model or subscription\b/i },
  { name: "obsolete budget input", re: /Budget for one task|ceiling[^.]*configurable under Settings/i },
  { name: "unqualified screenshot claim", re: /\bunretouched\b/i },
  { name: "retired featured screenshot", re: /screenshots\/reading-(?:completed|summary)/i },
  {
    name: "open source",
    re: /\bopen source\b/i,
    allow: [/\bnot (?:OSI )?open source\b/gi, /\bisn't open source\b/gi],
  },
  { name: "entirely local", re: /\bentirely local\b/i },
  {
    name: "guaranteed",
    re: /\bguaranteed\b/i,
    allow: [
      /\bno guaranteed \S+/gi,
      /\bnever guaranteed\b/gi,
      /\bnot guaranteed\b/gi,
      /\bwithout guaranteed\b/gi,
      /\bno security certification or guaranteed \S+/gi,
    ],
  },
  { name: "immune", re: /\bimmune\b/i },
];

function main(): void {
  const extra = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  const files = extra.length > 0 ? extra : TARGETS;
  const hits: string[] = [];
  for (const rel of files) {
    const path = join(ROOT, rel);
    if (!existsSync(path)) {
      hits.push(`MISSING ${rel}`);
      continue;
    }
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const p of PATTERNS) {
        let text = line.replaceAll(/\*{1,2}/g, "");
        for (const allow of p.allow ?? []) {
          text = text.replace(new RegExp(allow.source, `${allow.flags.replaceAll("g", "")}g`), "");
        }
        const global = new RegExp(p.re.source, `${p.re.flags.replaceAll("g", "")}g`);
        for (const m of text.matchAll(global)) {
          const at = m.index ?? 0;
          const after = text.slice(at + m[0].length, at + m[0].length + 16);
          if (/^(?:\s|<\/?[a-zA-Z][^>]*>)*\?/.test(after)) continue;
          hits.push(`${rel}:${i + 1}: ${p.name}: ${line.trim()}`);
          break;
        }
      }
    });
  }

  if (hits.length) {
    console.error("claim-scan FAIL");
    for (const h of hits) console.error(`  ${h}`);
    process.exit(1);
  }
  console.log(`claim-scan OK (${files.length} files)`);
}

main();
