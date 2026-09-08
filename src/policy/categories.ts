import { originMatchesPattern } from "../protocol/origin.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ForceHumanCategory {
  id: string;
  label: string;
  example_origins: string[];
}

export interface CategoriesFile {
  version: number;
  force_human: ForceHumanCategory[];
}

const here = dirname(fileURLToPath(import.meta.url));
const defaultPath = join(here, "../../policy/categories.json");

export function loadCategories(path: string = defaultPath): CategoriesFile {
  const raw = JSON.parse(readFileSync(path, "utf8")) as CategoriesFile;
  if (!raw || typeof raw.version !== "number" || !Array.isArray(raw.force_human)) {
    throw new Error(`invalid categories file: ${path}`);
  }
  return raw;
}

export function matchForceHumanCategory(
  origin: string,
  categories: CategoriesFile,
): ForceHumanCategory | null {
  for (const cat of categories.force_human) {
    for (const pat of cat.example_origins) {
      if (originMatchesPattern(origin, pat)) return cat;
    }
  }
  return null;
}
