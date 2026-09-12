/**
 * First run at the CLI seam: the link `start` prints, the command `init` ends
 * on, and what `image build|pull` do. Nothing here binds a port or runs docker.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { announceBootstrapUrl } from "../../../src/cli/start.ts";
import { runImageCli } from "../../../src/cli/image.ts";
import { runInit } from "../../../src/cli/init.ts";
import { BUILD_SPECS, buildArgs } from "../../../src/daemon/runtime.ts";
import { loadConfigDoc } from "../../../src/config/load.ts";
import { createOpenAICompatibleAdapter, openAICompatibleOptionsFromConfig } from "../../../src/adapters/openai-compatible.ts";
import type { ModelbotConfig } from "../../../src/types/contracts.ts";

const URL_ = "http://127.0.0.1:7777/#bootstrap=one-time-secret";

function capture(run: (log: (line: string) => void) => void): string[] {
  const lines: string[] = [];
  run((line) => lines.push(line));
  return lines;
}

/** `console.log` is the CLI's only output channel; swap it for the duration. */
async function captureConsole(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  console.error = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    await run();
  } finally {
    console.log = log;
    console.error = error;
  }
  return lines;
}

describe("modelbot start first-run link", () => {
  it("prints the link and the pair hint, and opens it on macOS", () => {
    const opened: string[] = [];
    const lines = capture((log) =>
      announceBootstrapUrl(URL_, { open: true, interactive: true, platform: "darwin", log, openUrl: (u) => opened.push(u) }),
    );
    assert.deepEqual(lines, [
      `Open ${URL_}`,
      "This link works for 10 minutes. Lost it? Run: bothearth pair",
    ]);
    assert.deepEqual(opened, [URL_]);
  });

  it("--no-open still prints both lines and opens nothing", () => {
    const opened: string[] = [];
    const lines = capture((log) =>
      announceBootstrapUrl(URL_, { open: false, interactive: true, platform: "darwin", log, openUrl: (u) => opened.push(u) }),
    );
    assert.equal(lines.length, 2);
    assert.equal(lines[0], `Open ${URL_}`);
    assert.deepEqual(opened, []);
  });

  it("prints without opening on Linux", () => {
    const opened: string[] = [];
    const lines = capture((log) =>
      announceBootstrapUrl(URL_, { open: true, interactive: true, platform: "linux", log, openUrl: (u) => opened.push(u) }),
    );
    assert.equal(lines.length, 2);
    assert.deepEqual(opened, []);
  });

  // Tests, packaging runs, `--daemon` children and the Mac shell's daemon all
  // reach this with no terminal on stdout. Each one used to pop a browser window
  // onto the owner's screen at a link that died with the process.
  it("opens nothing when stdout is not a terminal, or under CI / MODELBOT_NO_OPEN", () => {
    const savedTty = process.stdout.isTTY;
    const savedCi = process.env.CI;
    const savedNoOpen = process.env.MODELBOT_NO_OPEN;
    const cases: Array<[string, boolean, string | undefined, string | undefined, number]> = [
      ["no terminal", false, undefined, undefined, 0],
      ["CI", true, "1", undefined, 0],
      ["MODELBOT_NO_OPEN", true, undefined, "1", 0],
      ["a person at a terminal", true, undefined, undefined, 1],
    ];
    try {
      for (const [name, tty, ci, noOpen, expected] of cases) {
        process.stdout.isTTY = tty;
        if (ci === undefined) delete process.env.CI;
        else process.env.CI = ci;
        if (noOpen === undefined) delete process.env.MODELBOT_NO_OPEN;
        else process.env.MODELBOT_NO_OPEN = noOpen;
        const opened: string[] = [];
        const lines = capture((log) =>
          announceBootstrapUrl(URL_, {
            open: true,
            platform: "darwin",
            log,
            openUrl: (u) => opened.push(u),
          }),
        );
        assert.equal(lines.length, 2, `${name} still prints the link`);
        assert.equal(opened.length, expected, `${name} opener calls`);
      }
    } finally {
      process.stdout.isTTY = savedTty;
      if (savedCi === undefined) delete process.env.CI;
      else process.env.CI = savedCi;
      if (savedNoOpen === undefined) delete process.env.MODELBOT_NO_OPEN;
      else process.env.MODELBOT_NO_OPEN = savedNoOpen;
    }
  });
});

describe("modelbot init", () => {
  it("ends on the next command, never a link", async () => {
    const home = mkdtempSync(join(tmpdir(), "mb-first-run-"));
    const saved = process.env.MODELBOT_VAULT_KEY_HEX;
    process.env.MODELBOT_VAULT_KEY_HEX = Buffer.alloc(32, 7).toString("hex");
    let lines: string[];
    try {
      lines = await captureConsole(() =>
        runInit(["--home", home, "--data-dir", join(home, "data"), "--skip-detect", "--skip-images", "--force"]),
      );
    } finally {
      if (saved === undefined) delete process.env.MODELBOT_VAULT_KEY_HEX;
      else process.env.MODELBOT_VAULT_KEY_HEX = saved;
    }
    assert.equal(lines.at(-1), "Next: modelbot start");
    assert.equal(lines.some((l) => l.includes("http://") || l.includes("bootstrap")), false);
    const config = loadConfigDoc(join(home, "modelbot.yaml")) as unknown as ModelbotConfig;
    assert.doesNotThrow(() => createOpenAICompatibleAdapter(openAICompatibleOptionsFromConfig(config.adapters.openai_compat)));
  });
});

describe("modelbot image", () => {
  it("build runs the three stamped builds with the daemon's own argv", async () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const exitCode = process.exitCode;
    const lines = await captureConsole(async () => {
      await runImageCli(["build"], async (args, cwd) => {
        calls.push({ args, cwd });
        return 0;
      });
    });
    process.exitCode = exitCode;
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map((c) => c.args),
      BUILD_SPECS.map((spec) => buildArgs(spec)),
    );
    assert.ok(existsSync(join(calls[0]!.cwd, "Dockerfile.computer")), "builds run from the package root");
    for (const call of calls) {
      assert.equal(call.args.at(-1), ".");
      assert.equal(call.args.filter((a) => a.startsWith("org.modelbot.build-stamp=")).length, 1);
    }
    assert.equal(lines.at(-1), "Workspaces built. Restart the daemon to apply, or run: modelbot start");
  });

  it("build stops on the first failure and exits non-zero", async () => {
    const exitCode = process.exitCode;
    let ran = 0;
    const lines = await captureConsole(async () => {
      await runImageCli(["build"], async () => {
        ran += 1;
        return 2;
      });
    });
    const observed = process.exitCode;
    process.exitCode = exitCode;
    assert.equal(ran, 1);
    assert.equal(observed, 1);
    assert.ok(lines.some((l) => l.includes("docker build failed for Dockerfile.computer (exit 2)")));
  });

  it("pull says no images are published and points at build", async () => {
    const exitCode = process.exitCode;
    const lines = await captureConsole(async () => {
      await runImageCli(["pull"], async () => 0);
    });
    const observed = process.exitCode;
    process.exitCode = exitCode;
    assert.equal(observed, 1);
    assert.deepEqual(lines, [
      "No prebuilt ModelBot images are published yet. Build them here: modelbot image build",
    ]);
  });
});
