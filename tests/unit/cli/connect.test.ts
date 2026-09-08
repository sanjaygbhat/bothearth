/**
 * modelbot connect writers + flavour launchers.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  applyConnect,
  HARNESSES,
  renderHarnessFragment,
  type Harness,
} from "../../../src/cli/connect-writers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const fixtures = join(root, "tests/fixtures/connect");
const cli = join(root, "src/cli/index.ts");

const FIXTURE_MAP: Record<Harness, string> = {
  codex: "codex-config.toml",
  claude: "claude.mcp.json",
  gemini: "gemini-settings.json",
  cursor: "cursor-mcp.json",
  opencode: "opencode.json",
  copilot: "copilot-mcp-config.json",
};

function unsetHarnessEnv(): () => void {
  const keys = ["CODEX_HOME", "GEMINI_CONFIG_DIR", "COPILOT_HOME"] as const;
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) {
    prev[k] = process.env[k];
    delete process.env[k];
  }
  return () => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  };
}

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

describe("connect writers", () => {
  it("golden: renderHarnessFragment matches fixtures byte-exact", () => {
    for (const h of HARNESSES) {
      const got = renderHarnessFragment(h);
      const exp = readFileSync(join(fixtures, FIXTURE_MAP[h]), "utf8");
      assert.equal(got, exp, h);
    }
  });

  it("write → idempotent unchanged → remove", () => {
    const restore = unsetHarnessEnv();
    try {
      const home = mkdtempSync(join(tmpdir(), "mb-connect-"));
      const work = mkdtempSync(join(tmpdir(), "mb-connect-cwd-"));
      for (const h of HARNESSES) {
        const r1 = applyConnect(h, { home, cwd: work });
        assert.equal(r1.action, "wrote", h);
        assert.equal(
          r1.content,
          renderHarnessFragment(h),
          `${h} content vs golden`,
        );
        assert.ok(existsSync(r1.path), h);

        const r2 = applyConnect(h, { home, cwd: work });
        assert.equal(r2.action, "unchanged", h);

        const r3 = applyConnect(h, { home, cwd: work, remove: true });
        assert.equal(r3.action, "removed", h);
        assert.ok(r3.backupPath && existsSync(r3.backupPath), `${h} bak`);
        assert.ok(
          !r3.content.includes(`[mcp_servers.modelbot]`) &&
            !/"modelbot"\s*:/.test(r3.content),
          `${h} modelbot entry gone: ${JSON.stringify(r3.content.slice(0, 120))}`,
        );
      }
    } finally {
      restore();
    }
  });

  it("preserves sibling servers on merge/remove", () => {
    const restore = unsetHarnessEnv();
    try {
      const home = mkdtempSync(join(tmpdir(), "mb-connect-merge-"));
      const work = mkdtempSync(join(tmpdir(), "mb-connect-merge-cwd-"));
      const cursorPath = join(home, ".cursor", "mcp.json");
      mkdirSync(dirname(cursorPath), { recursive: true });
      writeFileSync(
        cursorPath,
        JSON.stringify(
          {
            mcpServers: {
              other: { url: "http://127.0.0.1:9/mcp" },
            },
          },
          null,
          2,
        ) + "\n",
      );
      const wrote = applyConnect("cursor", { home, cwd: work });
      assert.equal(wrote.action, "wrote");
      const doc = JSON.parse(readFileSync(cursorPath, "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      assert.ok(doc.mcpServers.other);
      assert.ok(doc.mcpServers.modelbot);
      applyConnect("cursor", { home, cwd: work, remove: true });
      const after = JSON.parse(readFileSync(cursorPath, "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      assert.ok(after.mcpServers.other);
      assert.equal(after.mcpServers.modelbot, undefined);
    } finally {
      restore();
    }
  });

  it("dry-run --print emits bearer fields for every harness", () => {
    for (const h of HARNESSES) {
      const home = mkdtempSync(join(tmpdir(), "mb-print-"));
      const env = { ...process.env };
      delete env.CODEX_HOME;
      delete env.GEMINI_CONFIG_DIR;
      delete env.COPILOT_HOME;
      const r = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          cli,
          "connect",
          h,
          "--print",
          "--home",
          home,
        ],
        { encoding: "utf8", env },
      );
      assert.equal(r.status, 0, `${h}: ${r.stderr}`);
      assert.match(r.stdout, /MODELBOT_TOKEN/);
    }
  });

  it("isolated-home: writes stay under TMPDIR home/cwd", () => {
    const restore = unsetHarnessEnv();
    try {
      const home = mkdtempSync(join(tmpdir(), "mb-iso-home-"));
      const work = mkdtempSync(join(tmpdir(), "mb-iso-cwd-"));
      for (const h of HARNESSES) {
        applyConnect(h, { home, cwd: work });
      }
      for (const p of walkFiles(home)) {
        assert.ok(p.startsWith(home), p);
      }
      for (const p of walkFiles(work)) {
        assert.ok(p.startsWith(work), p);
      }
    } finally {
      restore();
    }
  });

  it("flavour bins invoke modelbot connect", () => {
    const codexBin = readFileSync(
      join(root, "flavours/codex-modelbot/bin/codex-modelbot"),
      "utf8",
    );
    const claudeBin = readFileSync(
      join(root, "flavours/claude-modelbot/bin/claude-modelbot"),
      "utf8",
    );
    assert.match(codexBin, /connect codex/);
    assert.match(claudeBin, /connect claude/);
    assert.match(codexBin, /CODEX_HOME/);
    assert.match(claudeBin, /--plugin-dir/);
    assert.ok(
      existsSync(
        join(root, "flavours/claude-modelbot/.claude-plugin/plugin.json"),
      ),
    );
    assert.ok(
      existsSync(
        join(root, "flavours/claude-modelbot/.claude-plugin/marketplace.json"),
      ),
    );
    assert.ok(
      existsSync(
        join(
          root,
          "flavours/codex-modelbot/skills/modelbot-computer/SKILL.md",
        ),
      ),
    );
    assert.ok(
      existsSync(join(root, "flavours/codex-modelbot/AGENTS.md")),
    );
  });
});
