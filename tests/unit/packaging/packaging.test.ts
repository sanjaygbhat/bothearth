import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { STAMP_INPUTS } from "../../../src/daemon/build-stamp.ts";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");

function run(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(command, args, {
    cwd: opts.cwd ?? ROOT,
    encoding: "utf8",
    env: opts.env ?? process.env,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function packPaths(): string[] {
  const r = run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return (JSON.parse(r.stdout)[0].files as { path: string }[]).map((file) => file.path);
}

test("claim-scan exits 0 on launch surfaces", () => {
  const r = run(process.execPath, [
    "--experimental-strip-types",
    "scripts/claim-scan.ts",
  ]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /claim-scan OK/);
});

test("gen-config-doc writes CONFIG.md with schema fields", () => {
  const r = run(process.execPath, [
    "--experimental-strip-types",
    "scripts/gen-config-doc.ts",
  ]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const md = readFileSync(join(ROOT, "docs/CONFIG.md"), "utf8");
  assert.match(md, /modelbot\.schema\.json/);
  assert.match(md, /\| `bind`/);
  assert.match(md, /\| `port`/);
});

test("gen-cli-doc writes CLI.md from help", () => {
  const r = run(process.execPath, [
    "--experimental-strip-types",
    "scripts/gen-cli-doc.ts",
  ]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const md = readFileSync(join(ROOT, "docs/CLI.md"), "utf8");
  assert.match(md, /Usage: modelbot/);
  assert.match(md, /connect/);
  assert.match(md, /init/);
});

test("README stays under 1800 words and avoids banned claims", () => {
  const text = readFileSync(join(ROOT, "README.md"), "utf8");
  const words = text.trim().split(/\s+/).length;
  assert.ok(words <= 1800, `README words=${words}`);
  assert.doesNotMatch(text, /\bunlimited\b/i);
  assert.doesNotMatch(text, /\bany subscription\b/i);
  assert.doesNotMatch(text, /\balready pay for\b/i);
  assert.doesNotMatch(text, /\bany model or subscription\b/i);
});

test("npm pack dry-run only ships allowlisted paths", () => {
  const paths = packPaths();
  assert.ok(paths.length > 0, "expected pack file list");
  const banned = paths.filter(
    (p) =>
      (p.startsWith("src/") && !/^src\/(protocol|types|tools|proxy)\//.test(p)) ||
      p.startsWith("tests/") ||
      p.startsWith("docs/") ||
      /(^|\/)node_modules\//.test(p) ||
      p.startsWith(".claude/") ||
      p.startsWith("data/") ||
      p === "tsconfig.json",
  );
  assert.deepEqual(banned, [], `unexpected pack paths: ${banned.join(", ")}`);
  assert.ok(
    paths.some((p) => p === "dist" || p.startsWith("dist/")),
    "dist missing from pack",
  );
  assert.ok(
    paths.some((p) => p.includes("Dockerfile")),
    "Dockerfiles missing from pack",
  );
  for (const input of new Set(Object.values(STAMP_INPUTS).flat())) {
    assert.ok(paths.some((path) => path === input || path.startsWith(`${input}/`)), `missing Docker build input: ${input}`);
  }
  assert.ok(paths.includes(".dockerignore"), "installed packages must retain Docker's context exclusions");
});

test("packed tarball initializes and serves a healthy daemon with the complete UI", () => {
  const build = run("npm", ["run", "build"]);
  assert.equal(build.status, 0, build.stderr || build.stdout);

  const packDir = mkdtempSync(join(tmpdir(), "modelbot-pack-out-"));
  const extractDir = mkdtempSync(join(tmpdir(), "modelbot-pack-x-"));
  try {
    const pack = run("npm", ["pack", "--ignore-scripts", "--pack-destination", packDir]);
    assert.equal(pack.status, 0, pack.stderr || pack.stdout);
    const tgz = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
    assert.ok(tgz, "tgz missing");
    const tgzPath = join(packDir, tgz!);
    assert.ok(existsSync(tgzPath));

    const prefix = join(extractDir, "installed");
    const installed = run("npm", ["install", "--global", "--prefix", prefix, "--ignore-scripts", tgzPath]);
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    for (const alias of ["bothearth", "modelbot"]) {
      const version = run(join(prefix, "bin", alias), ["--version"]);
      assert.equal(version.status, 0, version.stderr || version.stdout);
      assert.equal(version.stdout.trim(), JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
    }

    const extract = run("tar", ["-xzf", tgzPath, "-C", extractDir]);
    assert.equal(extract.status, 0, extract.stderr);
    const pkgDir = join(extractDir, "package");
    const bin = join(pkgDir, "dist/cli/index.js");
    assert.ok(existsSync(bin), `missing ${bin}`);
    const install = run("npm", ["install", "--omit=dev", "--ignore-scripts"], {
      cwd: pkgDir,
    });
    assert.equal(install.status, 0, install.stderr || install.stdout);
    const help = run(process.execPath, [bin, "--help"], {
      cwd: pkgDir,
    });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /Usage: modelbot/);
    assert.ok(existsSync(join(pkgDir, "NOTICE")), "third-party license notice missing");
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MODELBOT_"))),
      MODELBOT_VAULT_KEY_HEX: "17".repeat(32),
      MODELBOT_HOME: join(extractDir, "home"),
    };
    const init = run(process.execPath, [bin, "init", "--data-dir", join(extractDir, "data"), "--skip-detect", "--skip-images", "--quiet"], { cwd: pkgDir, env });
    assert.equal(init.status, 0, init.stderr);
    const smoke = run(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { spawnSync } from 'node:child_process';
      import { statSync } from 'node:fs';
      import { join } from 'node:path';
      import { buildProductionComposition } from './dist/cli/start.js';
      import { startDaemon } from './dist/daemon/server.js';
      const composition = await buildProductionComposition({ port: 0 });
      const server = await startDaemon(composition.daemon);
      try {
        const paths = new Set(['/healthz', '/', '/main.js',
          '/tokens.css', '/base.css', '/shell.css', '/home.css', '/task.css', '/settings.css']);
        for (const path of paths) {
          const response = await fetch(server.baseUrl + path, { headers: { connection: 'close' } });
          assert.equal(response.status, 200, path);
          const text = await response.text();
          if (path.endsWith('.js')) {
            // Comments carry example imports; a module graph does not.
            const code = text.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '').replace(/^\\s*\\/\\/.*$/gm, '');
            for (const match of [...code.matchAll(/\\bfrom\\s*["']([^"']+)["']/g),
                                 ...code.matchAll(/\\bimport\\s*\\(?\\s*["']([^"']+)["']/g)]) {
              paths.add(new URL(match[1], server.baseUrl + path).pathname);
            }
          }
        }
        assert.ok(paths.has('/protocol/live.js'));
        assert.ok(paths.has('/live/session.js'), 'the packed graph reaches the live view');
        assert.equal((await fetch(server.baseUrl + '/api/v1/computers')).status, 401);
      } finally { await server.close(); }
      const port = new URL(server.baseUrl).port;
      const cli = (...args) => spawnSync(process.execPath, ['./dist/cli/index.js', ...args], { encoding: 'utf8' });
      const started = cli('start', '--daemon', '--port', port);
      try {
        assert.equal(started.status, 0, started.stderr);
        assert.match(started.stdout, /daemon started pid=/);
        assert.equal((await fetch(server.baseUrl + '/healthz', { headers: { connection: 'close' } })).status, 200);
        assert.equal(statSync(join(process.env.MODELBOT_HOME, 'daemon.log')).mode & 0o777, 0o600);
        const status = cli('status', '--daemon');
        assert.equal(status.status, 0, status.stderr || status.stdout);
      } finally {
        const stopped = cli('stop');
        assert.equal(stopped.status, 0, stopped.stderr);
      }
      for (let attempt = 0; attempt < 100; attempt++) {
        try { await fetch(server.baseUrl + '/healthz', { headers: { connection: 'close' } }); }
        catch { break; }
        assert.ok(attempt < 99, 'daemon remained reachable after stop');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    `], { cwd: pkgDir, env });
    assert.equal(smoke.status, 0, smoke.stderr || smoke.stdout);
  } finally {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(extractDir, { recursive: true, force: true });
  }
});
