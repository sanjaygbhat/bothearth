#!/usr/bin/env node
/**
 * WP21 — memory gate: parse docs/internal/measurements.md vs ARCHITECTURE §12 budgets.
 *
 * Checks:
 *   - Daemon idle RSS present and ≤ 512 MiB (publish gate; no <150MB claim)
 *   - Browser / Chromium idle RSS present and ≤ 2 GiB (cgroup budget)
 *
 * Usage: node --experimental-strip-types scripts/memory-gate.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MEASUREMENTS = join(ROOT, "docs", "internal", "measurements.md");

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Browser cgroup budget (ARCHITECTURE §12). */
const BROWSER_MAX_BYTES = 2 * GIB;
/** Practical daemon idle ceiling for the gate (measure & publish). */
const DAEMON_MAX_BYTES = 512 * MIB;

function parseSizeToBytes(raw: string): number | null {
  const s = raw.replace(/,/g, "").trim();
  const m = s.match(/^([\d.]+)\s*(GiB|MiB|KiB|GB|MB|KB|B|bytes)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? "B").toLowerCase();
  if (unit === "gib" || unit === "gb") return Math.round(n * GIB);
  if (unit === "mib" || unit === "mb") return Math.round(n * MIB);
  if (unit === "kib" || unit === "kb") return Math.round(n * 1024);
  if (unit === "bytes") return Math.round(n);
  return Math.round(n);
}

function findBrowserRss(md: string): { bytes: number; evidence: string } | null {
  // e.g. Idle RSS Chromium `about:blank` | **92.59MiB / 2GiB**
  const re =
    /Idle RSS Chromium[^|\n]*\|\s*\*{0,2}([\d.]+)\s*(MiB|GiB|KiB|MB|GB)\b/i;
  const m = md.match(re);
  if (m) {
    const bytes = parseSizeToBytes(`${m[1]}${m[2]}`);
    if (bytes != null) return { bytes, evidence: m[0].trim() };
  }
  return null;
}

function findDaemonRss(md: string): { bytes: number; evidence: string } | null {
  // Prefer explicit "Daemon idle RSS" row.
  const labeled = md.match(
    /Daemon idle RSS[^|\n]*\|\s*\*{0,2}([\d.]+)\s*(MiB|GiB|KiB|MB|GB|B|bytes)?\b/i,
  );
  if (labeled) {
    const unit = labeled[2] ?? "MiB";
    const bytes = parseSizeToBytes(`${labeled[1]}${unit}`);
    if (bytes != null) return { bytes, evidence: labeled[0].trim() };
  }
  // WP12 table: | `measure-memory_self` | 75726848 | ps rss |
  const self = md.match(
    /`measure-memory_self`\s*\|\s*(\d+)\s*\|\s*([^|\n]+)/i,
  );
  if (self) {
    const bytes = Number(self[1]);
    if (Number.isFinite(bytes)) {
      return {
        bytes,
        evidence: `measure-memory_self ${bytes} (${self[2].trim()})`,
      };
    }
  }
  return null;
}

function main(): number {
  if (!existsSync(MEASUREMENTS)) {
    console.error(`memory-gate FAIL: missing ${MEASUREMENTS}`);
    return 1;
  }
  const md = readFileSync(MEASUREMENTS, "utf8");
  const browser = findBrowserRss(md);
  const daemon = findDaemonRss(md);
  let fail = 0;

  if (!browser) {
    console.error("memory-gate FAIL: browser/Chromium idle RSS not found");
    fail = 1;
  } else if (browser.bytes > BROWSER_MAX_BYTES) {
    console.error(
      `memory-gate FAIL: browser RSS ${browser.bytes} > ${BROWSER_MAX_BYTES} (2 GiB)`,
    );
    console.error(`  evidence: ${browser.evidence}`);
    fail = 1;
  } else {
    console.log(
      `PASS browser RSS ${browser.bytes} ≤ ${BROWSER_MAX_BYTES} (${browser.evidence})`,
    );
  }

  if (!daemon) {
    console.error("memory-gate FAIL: daemon idle RSS not found");
    fail = 1;
  } else if (daemon.bytes > DAEMON_MAX_BYTES) {
    console.error(
      `memory-gate FAIL: daemon RSS ${daemon.bytes} > ${DAEMON_MAX_BYTES} (512 MiB)`,
    );
    console.error(`  evidence: ${daemon.evidence}`);
    fail = 1;
  } else {
    console.log(
      `PASS daemon idle RSS ${daemon.bytes} ≤ ${DAEMON_MAX_BYTES} (${daemon.evidence})`,
    );
  }

  if (fail === 0) console.log("memory-gate OK");
  return fail;
}

process.exit(main());
