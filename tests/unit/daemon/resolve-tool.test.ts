/**
 * A `.app`-launched daemon inherits launchd's PATH, so every
 * spawn of claude/codex/docker must resolve through system dirs → PATH →
 * user-writable dirs. A user-writable dir is reached only when
 * nothing else resolved, relative entries never resolve, and a candidate that
 * this user does not own or that group/other can write is refused.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  newestNodeVersionDir,
  resolveTool,
  toolPath,
  toolSearchDirs,
} from "../../../src/daemon/resolve-tool.ts";

const HOME = "/Users/tester";
const UID = 501;
/** launchd's PATH — what a double-clicked .app actually gets. */
const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** Default for every present file: root-owned, 0755. The safe case. */
function deps(
  files: string[],
  env: NodeJS.ProcessEnv = {},
  nvm: string[] = [],
  stats: Record<string, { uid: number; mode: number }> = {},
) {
  const present = new Set(files);
  return {
    home: HOME,
    uid: UID,
    env: { PATH: LAUNCHD_PATH, ...env },
    isExecutable: (p: string) => present.has(p),
    listDir: (p: string) => (p === `${HOME}/.nvm/versions/node` ? nvm : []),
    statPath: (p: string) => (present.has(p) ? (stats[p] ?? { uid: 0, mode: 0o100755 }) : null),
  };
}

describe("resolve-tool", () => {
  it("prefers a system dir over PATH and over $HOME", () => {
    const found = resolveTool(
      "docker",
      deps(["/usr/bin/docker", "/usr/local/bin/docker", `${HOME}/.local/bin/docker`]),
    );
    assert.deepEqual(found, { name: "docker", path: "/usr/local/bin/docker", source: "system" });
  });

  it("falls back to a user-writable dir only when nothing else resolved", () => {
    const found = resolveTool("claude", deps([`${HOME}/.local/bin/claude`]));
    assert.equal(found?.path, `${HOME}/.local/bin/claude`);
    assert.equal(found?.source, "well-known");
  });

  it("MODELBOT_TOOL_PATH still outranks everything", () => {
    const found = resolveTool(
      "codex",
      deps(["/usr/bin/codex", "/opt/custom/codex"], { MODELBOT_TOOL_PATH: "/opt/custom" }),
    );
    assert.deepEqual(found, { name: "codex", path: "/opt/custom/codex", source: "override" });
  });

  it("covers every documented dir and emits no $HOME dir before a system dir", () => {
    const dirs = toolSearchDirs(deps([], {}, ["v22.18.0"])).map((d) => d.dir);
    for (const expected of [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/Applications/Docker.app/Contents/Resources/bin",
      `${HOME}/.local/bin`,
      `${HOME}/.npm-global/bin`,
      `${HOME}/.volta/bin`,
      `${HOME}/.nvm/versions/node/v22.18.0/bin`,
      `${HOME}/.bun/bin`,
    ]) {
      assert.ok(dirs.includes(expected), `missing ${expected}`);
    }
    // System before PATH before anything under $HOME.
    const firstHome = dirs.findIndex((d) => d.startsWith(`${HOME}/`));
    assert.ok(dirs.indexOf("/opt/homebrew/bin") < dirs.indexOf("/usr/sbin"));
    assert.ok(dirs.indexOf("/usr/sbin") < firstHome);
    for (const dir of dirs.slice(0, firstHome)) assert.ok(!dir.startsWith(`${HOME}/`), dir);
  });

  it("demotes a $HOME PATH entry to last, behind every system dir", () => {
    const dirs = toolSearchDirs(deps([], { PATH: `${HOME}/.local/bin:${LAUNCHD_PATH}` })).map((d) => d.dir);
    assert.ok(dirs.indexOf("/usr/bin") < dirs.indexOf(`${HOME}/.local/bin`));
    // A planted ~/.local/bin/claude cannot displace the Homebrew install.
    const found = resolveTool(
      "claude",
      deps(["/opt/homebrew/bin/claude", `${HOME}/.local/bin/claude`], {
        PATH: `${HOME}/.local/bin:${LAUNCHD_PATH}`,
      }),
    );
    assert.equal(found?.path, "/opt/homebrew/bin/claude");
  });

  it("never resolves a relative PATH entry against the daemon's CWD", () => {
    const d = deps(["./claude", "bin/claude"], { PATH: ".:bin:/usr/bin" });
    assert.equal(resolveTool("claude", d), null);
    assert.ok(!toolSearchDirs(d).some((e) => e.dir === "." || e.dir === "bin"));
  });

  it("refuses a candidate that group or other can write", () => {
    const found = resolveTool(
      "docker",
      deps(["/usr/local/bin/docker", "/usr/bin/docker"], {}, [], {
        "/usr/local/bin/docker": { uid: 0, mode: 0o100777 },
      }),
    );
    assert.equal(found?.path, "/usr/bin/docker");
  });

  it("refuses a candidate owned by neither this user nor root", () => {
    const d = deps(["/usr/local/bin/claude"], {}, [], {
      "/usr/local/bin/claude": { uid: 999, mode: 0o100755 },
    });
    assert.equal(resolveTool("claude", d), null);
  });

  it("accepts a candidate owned by this user with safe permissions", () => {
    const d = deps(["/opt/homebrew/bin/claude"], {}, [], {
      "/opt/homebrew/bin/claude": { uid: UID, mode: 0o100755 },
    });
    assert.equal(resolveTool("claude", d)?.path, "/opt/homebrew/bin/claude");
  });

  it("picks the newest nvm node version, not the lexically largest", () => {
    assert.equal(newestNodeVersionDir(["v20.11.1", "v22.9.1", "v22.18.0"]), "v22.18.0");
    assert.equal(newestNodeVersionDir(["not-a-version"]), undefined);
    const found = resolveTool(
      "claude",
      deps([`${HOME}/.nvm/versions/node/v22.18.0/bin/claude`], {}, ["v20.11.1", "v22.18.0"]),
    );
    assert.equal(found?.path, `${HOME}/.nvm/versions/node/v22.18.0/bin/claude`);
  });

  it("returns null — never a wrong path — when the tool is nowhere, and toolPath falls back to the bare name", () => {
    const d = deps([]);
    assert.equal(resolveTool("codex", d), null);
    assert.equal(toolPath("codex", d), "codex");
  });
});
