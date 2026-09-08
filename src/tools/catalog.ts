import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOOL_NAMES,
  type JsonSchema,
  type SideEffect,
  type ToolCatalogueEntry,
  type ToolDriver,
  type ToolName,
} from "../types/contracts.ts";

const here = dirname(fileURLToPath(import.meta.url));
const schemasDir = join(here, "schemas");

/** Canonical sideEffect/driver, using the ARCH §4 names only. */
export const TOOL_META: Record<
  ToolName,
  { sideEffect: SideEffect; driver: ToolDriver }
> = {
  browser_navigate: { sideEffect: "act", driver: "a11y" },
  browser_snapshot: { sideEffect: "read", driver: "a11y" },
  browser_click: { sideEffect: "act", driver: "a11y" },
  browser_type: { sideEffect: "act", driver: "a11y" },
  browser_press: { sideEffect: "act", driver: "a11y" },
  browser_scroll: { sideEffect: "act", driver: "a11y" },
  browser_select: { sideEffect: "act", driver: "a11y" },
  browser_upload: { sideEffect: "gated", driver: "a11y" },
  browser_tabs: { sideEffect: "act", driver: "a11y" },
  browser_screenshot: { sideEffect: "read", driver: "vision" },
  browser_wait: { sideEffect: "read", driver: "a11y" },
  computer_mouse: { sideEffect: "act", driver: "vision" },
  computer_key: { sideEffect: "act", driver: "vision" },
  computer_type: { sideEffect: "act", driver: "vision" },
  shell_exec: { sideEffect: "gated", driver: "system" },
  files_list: { sideEffect: "read", driver: "system" },
  files_read: { sideEffect: "read", driver: "system" },
  files_write: { sideEffect: "act", driver: "system" },
  files_delete: { sideEffect: "gated", driver: "system" },
  write_file: { sideEffect: "act", driver: "system" },
  request_takeover: { sideEffect: "gated", driver: "system" },
  takeover_status: { sideEffect: "read", driver: "system" },
  connector_call: { sideEffect: "gated", driver: "system" },
  done: { sideEffect: "act", driver: "system" },
};

function loadSchema(name: ToolName): JsonSchema {
  const raw = readFileSync(join(schemasDir, `${name}.json`), "utf8");
  return JSON.parse(raw) as JsonSchema;
}

export const TOOL_CATALOGUE: readonly ToolCatalogueEntry[] = TOOL_NAMES.map(
  (name) => {
    const schema = loadSchema(name);
    const meta = TOOL_META[name];
    return {
      name,
      description: String(schema.description ?? name),
      inputSchema: schema,
      sideEffect: meta.sideEffect,
      driver: meta.driver,
    };
  },
);
