import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { originMatchesPattern } from "../protocol/origin.ts";

export type TosRiskLevel = "block" | "warn" | "allow";

export interface TosRiskEntry {
  id: string;
  class: string;
  origins: string[];
  risk: TosRiskLevel;
  note?: string;
}

export interface TosRiskFile {
  version: number;
  source?: string;
  entries: TosRiskEntry[];
}

const here = dirname(fileURLToPath(import.meta.url));
const defaultPath = join(here, "../../policy/tos-risk.json");

export function loadTosRisk(path: string = defaultPath): TosRiskFile {
  const raw = JSON.parse(readFileSync(path, "utf8")) as TosRiskFile;
  if (!raw || typeof raw.version !== "number" || !Array.isArray(raw.entries)) {
    throw new Error(`invalid tos-risk file: ${path}`);
  }
  return raw;
}

export function matchTosRisk(
  origin: string,
  tos: TosRiskFile,
): TosRiskEntry | null {
  for (const entry of tos.entries) {
    for (const pat of entry.origins) {
      if (originMatchesPattern(origin, pat)) return entry;
    }
  }
  return null;
}
