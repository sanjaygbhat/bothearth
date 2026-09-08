/**
 * The same UI ships to the Mac shell and to a plain browser. Anything that
 * tells a person to reopen an app, press a key macOS keeps for itself, or
 * assumes the daemon is on a Mac has to say something else in the browser.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { blockerCard } from "../../../src/ui/home.ts";
import { shortcutReaches } from "../../../src/ui/palette.ts";
import type { RuntimeStatus } from "../../../src/ui/runtime.ts";
import { PAIR_AGAIN } from "../../../src/ui/session.ts";

const UI = join(dirname(fileURLToPath(import.meta.url)), "../../../src/ui");
const source = (name: string): string => readFileSync(join(UI, name), "utf8");

const IMAGE = { present: true, created_at: "2026-09-01T00:00:00Z", stale: false };

function runtime(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    node: { ok: true, version: "22.18.0" },
    docker: { installed: true, running: true, engine: "orbstack", version: "1.0" },
    images: {
      computer: { ...IMAGE },
      shell: { ...IMAGE },
      proxy: { ...IMAGE },
      prepare: { state: "idle", step: "", percent: null, log_tail: [], error: null },
    },
    ai: { provider: "claude", cli_found: true, cli_path_kind: "path", logged_in: true, detail: "" },
    task_start_available: true,
    blockers: [],
    ...overrides,
  };
}

/** Runs `fn` with the WKWebView bridge the Mac shell installs. */
function asNativeShell<T>(fn: () => T): T {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = { window: globals.window, webkit: globals.webkit };
  globals.window = globalThis;
  globals.webkit = { messageHandlers: { modelbot: { postMessage() {} } } };
  try {
    return fn();
  } finally {
    Object.assign(globals, saved);
  }
}

describe("a lost session in a plain browser", () => {
  it("names the command that mints a new link", () => {
    assert.match(PAIR_AGAIN, /Your sign-in link expired\./);
    assert.match(PAIR_AGAIN, /modelbot pair/);
    assert.doesNotMatch(PAIR_AGAIN, /Applications/);
  });

  it("keeps the Applications-folder wording for the shell only", () => {
    for (const file of ["home.ts", "main.ts"]) {
      const text = source(file);
      assert.match(text, /PAIR_AGAIN/, `${file} offers the browser a way back`);
      assert.match(
        text,
        /modelbotNative\.isNative[\s\S]{0,200}Applications folder again/,
        `${file} gates the Applications-folder line on the native shell`,
      );
    }
  });
});

describe("blocker cards a browser can act on", () => {
  it("tells a browser to restart the daemon, not to reopen an app", () => {
    const old = runtime({
      node: { ok: false, version: "18.0.0" },
      task_start_available: false,
      blockers: [
        {
          id: "node_version",
          title: "Update Node",
          detail: "…open ModelBot again.",
          action: { kind: "open_url", url: "https://nodejs.org/" },
        },
      ],
    });
    const card = blockerCard(old)!;
    assert.equal(card.key, "node_version");
    assert.match(card.body, /modelbot start/);
    assert.match(card.body, /18\.0\.0/, "it names the version it found");
    assert.doesNotMatch(card.body, /this Mac/);
    // The Mac shell keeps the daemon's own wording, which fits it.
    assert.equal(asNativeShell(() => blockerCard(old)!.body), old.blockers[0]!.detail);
  });

  it("does not call the machine a Mac when it may not be one", () => {
    const missing = runtime({
      task_start_available: false,
      docker: { installed: false, running: false, engine: "unknown", version: "" },
      blockers: [
        { id: "docker_missing", title: "", detail: "", action: { kind: "open_url", url: "u" } },
      ],
    });
    assert.match(blockerCard(missing)!.body, /on this computer/);
    assert.match(asNativeShell(() => blockerCard(missing)!.body), /on this Mac/);
  });

  it("asks a signed-in CLI to be connected, not to sign in again", () => {
    const signedIn = runtime({
      task_start_available: false,
      ai: { provider: "claude", cli_found: true, cli_path_kind: "path", logged_in: true, detail: "" },
      blockers: [
        { id: "ai_not_connected", title: "Sign in to Claude Code", detail: "…", action: { kind: "open_settings" } },
      ],
    });
    const card = blockerCard(signedIn)!;
    assert.equal(card.heading, "Connect Claude Code");
    assert.equal(card.actions[0]?.label, "Connect Claude Code");
    assert.doesNotMatch(card.heading, /sign in/i);
    assert.doesNotMatch(card.body, /not signed in/i);

    // Actually signed out still gets the sign-in card.
    signedIn.ai.logged_in = false;
    assert.equal(blockerCard(signedIn)!.key, "ai_signed_out");
  });

  it("says what the one-time build really costs", () => {
    const building = runtime({ task_start_available: false });
    building.images.prepare = {
      state: "running",
      step: "Building the browser workspace (1 of 3)",
      percent: 33,
      log_tail: [],
      error: null,
    };
    const card = blockerCard(building)!;
    assert.doesNotMatch(card.body, /two minutes/);
    assert.match(card.body, /once/);
    assert.match(card.body, /several minutes/);
    assert.equal(card.progress?.step, "Building the browser workspace (1 of 3)");
  });
});

describe("shortcuts the browser keeps for itself", () => {
  it("stops advertising ⌘N and ⌘, outside the Mac shell", () => {
    assert.equal(shortcutReaches(["⌘", "N"]), false);
    assert.equal(shortcutReaches(["⌘", ","]), false);
    assert.equal(shortcutReaches(["⌘", "K"]), true);
    assert.equal(shortcutReaches(["⌘", "⇧", "T"]), true);
    assert.deepEqual(
      asNativeShell(() => [shortcutReaches(["⌘", "N"]), shortcutReaches(["⌘", ","])]),
      [true, true],
    );
  });
});
