#!/usr/bin/env node
/**
 * WP12 — sample daemon + container RSS during/after mcp-smoke into docs/internal/measurements.md.
 *
 * Usage:
 *   node --experimental-strip-types scripts/measure-memory.ts
 *   (optionally set MODELBOT_TEST_MEASURE_FROM_SMOKE=1 to invoke mcp-smoke first)
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withDockerLock } from "../tests/docker-int/lock.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MEASUREMENTS = join(ROOT, "docs", "internal", "measurements.md");

type Sample = {
  label: string;
  rss_bytes: number | null;
  source: string;
};

function dockerStatsRss(namePattern: string): Sample[] {
  const r = spawnSync(
    "docker",
    ["stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return [];
  const out: Sample[] = [];
  for (const line of (r.stdout ?? "").split("\n")) {
    if (!line.trim() || !line.includes(namePattern)) continue;
    const [name, usage] = line.split("\t");
    if (!name || !usage) continue;
    const m = usage.match(/^([\d.]+)(MiB|GiB|KiB|B)/);
    let bytes: number | null = null;
    if (m) {
      const n = Number(m[1]);
      const unit = m[2];
      bytes =
        unit === "GiB"
          ? Math.round(n * 1024 * 1024 * 1024)
          : unit === "MiB"
            ? Math.round(n * 1024 * 1024)
            : unit === "KiB"
              ? Math.round(n * 1024)
              : Math.round(n);
    }
    out.push({ label: name, rss_bytes: bytes, source: "docker stats" });
  }
  return out;
}

function processRssBytes(pid: number): number | null {
  try {
    // macOS: `ps -o rss=` returns KiB
    const r = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], {
      encoding: "utf8",
    });
    if (r.status !== 0) return null;
    const kib = Number((r.stdout ?? "").trim());
    if (!Number.isFinite(kib)) return null;
    return Math.round(kib * 1024);
  } catch {
    return null;
  }
}

function upsertSection(md: string, sectionTitle: string, body: string): string {
  const header = `## ${sectionTitle}`;
  const idx = md.indexOf(header);
  if (idx === -1) {
    return `${md.trimEnd()}\n\n${header}\n\n${body.trim()}\n`;
  }
  const after = md.indexOf("\n## ", idx + header.length);
  const end = after === -1 ? md.length : after;
  return md.slice(0, idx) + `${header}\n\n${body.trim()}\n` + md.slice(end);
}

async function main(): Promise<number> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(
      "Usage: measure-memory.ts [--from-smoke]\nRecords daemon/container RSS into docs/internal/measurements.md\n",
    );
    return 0;
  }

  return await withDockerLock(async () => {
    if (
      process.argv.includes("--from-smoke") ||
      process.env.MODELBOT_TEST_MEASURE_FROM_SMOKE === "1"
    ) {
      const smoke = spawnSync(
        process.execPath,
        ["--experimental-strip-types", join(ROOT, "scripts", "mcp-smoke.ts")],
        { cwd: ROOT, encoding: "utf8", env: process.env },
      );
      process.stdout.write(smoke.stdout ?? "");
      process.stderr.write(smoke.stderr ?? "");
      if (smoke.status !== 0) return smoke.status ?? 1;
    }

    const samples: Sample[] = [];
    samples.push({
      label: "measure-memory_self",
      rss_bytes: processRssBytes(process.pid),
      source: "ps rss",
    });
    samples.push(...dockerStatsRss("modelbot-"));

    const receiptPath = join(ROOT, "docs", "internal", "build", "mcp-smoke-last.json");
    let smokeMs: number | null = null;
    if (existsSync(receiptPath)) {
      try {
        const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
          total_ms?: number;
        };
        smokeMs = receipt.total_ms ?? null;
      } catch {
        /* ignore */
      }
    }

    const now = new Date().toISOString();
    const lines = [
      `Captured: ${now}`,
      "",
      "| Label | RSS bytes | Source |",
      "|---|---:|---|",
      ...samples.map(
        (s) =>
          `| \`${s.label}\` | ${s.rss_bytes ?? "n/a"} | ${s.source} |`,
      ),
      "",
      smokeMs != null
        ? `Last mcp-smoke wall time: **${smokeMs} ms** (from docs/internal/build/mcp-smoke-last.json).`
        : "Last mcp-smoke wall time: _not recorded yet_.",
      "",
      "Notes: container RSS from `docker stats --no-stream`; daemon RSS sampled via `ps` when the smoke leaves containers running, otherwise self-process RSS is recorded as a floor. Re-run with `--from-smoke` for a paired sample.",
    ];

    const prev = existsSync(MEASUREMENTS)
      ? readFileSync(MEASUREMENTS, "utf8")
      : "# ModelBot measurements\n";
    const next = upsertSection(prev, "WP12 mcp-smoke memory", lines.join("\n"));
    writeFileSync(MEASUREMENTS, next);
    console.log(`updated ${MEASUREMENTS} (${samples.length} samples)`);
    return 0;
  });
}

process.exit(await main());
