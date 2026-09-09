#!/usr/bin/env node
// Export a reviewed source snapshot; never copy private history or follow symlinks.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const ROOT_FILES = new Set([
  ".dockerignore", ".editorconfig", ".gitignore", "biome.json", "tsconfig.json",
  "package.json", "package-lock.json", "modelbot.schema.json", "docker-compose.yml",
  "docker-compose.egress-test.yml", "Dockerfile.computer", "Dockerfile.shell", "Dockerfile.proxy",
  "README.md", "CHANGELOG.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md",
  "CLA.md", "COMMERCIAL.md", "CONTRIBUTING.md", "PRIVACY.md", "SECURITY.md", "TRADEMARK.md",
  ".github/PULL_REQUEST_TEMPLATE.md", ".github/workflows/ci.yml", ".github/workflows/pages.yml",
  "flavours/claude-modelbot/.mcp.json", "flavours/claude-modelbot/.claude-plugin/plugin.json",
  "flavours/claude-modelbot/.claude-plugin/marketplace.json",
]);
const DIRECTORIES = ["src/", "computer-server/", "tests/", "scripts/", "policy/", "sandbox/",
  "assets/brand/", "assets/screenshots/", "apps/macos/", "mobile/", "flavours/", "website/", "enterprise/"];
const EXCLUDED_PART = /^(?:\..*|node_modules|dist|build|coverage|data|internal|DerivedData|xcuserdata|target|__pycache__)$/;
const EXCLUDED_FILE = /(?:\.(?:log|pid|sqlite3?(?:-(?:wal|shm))?|db|enc|jks|keystore|p12|mobileprovision|tgz|zip)|(?:^|\/)(?:local\.properties|tokens?\.json|credentials?\.json|auth\.json))$/i;
const PRIVATE_SCREENSHOTS = new Set(["assets/screenshots/home.png", "assets/screenshots/driving.png",
  "website/screenshots/home.png", "website/screenshots/home-dark.png", "website/screenshots/driving.png"]);
const SCAN_RULES = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g],
  ["github-token", /\b(?:gh[opusr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ["provider-key", /\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{32,}\b/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["operator-home", /\/Users\/sanjaybhat\b/g],
];
// Reviewed fixed canaries used by local tests, not live credentials. Exact value + path only.
const TEST_CANARIES = new Map([
  ["tests/unit/computer-server/shell.test.ts", "1a5d44a2dca19669d72edf4c4f1c27c4c1ca4b4408fbb17f6ce4ad452d78ddb3"],
  ["tests/unit/daemon/security-limits.test.ts", "c9ac2880625d42dda06ee3918b6588dad9e38e457e171cd327faa297c5876db8"],
  ["tests/unit/vault/vault.test.ts", "9f4763b404f151bfb350aac911faf9ab8cf5fd7d0abd495a9ede83c204843b71"],
]);
const PUBLIC_IGNORE = `.DS_Store\n.env\n.env.*\n!.env.example\nnode_modules/\ndist/\nbuild/\ncoverage/\n*.log\n*.pid\n*.tsbuildinfo\n*.sqlite*\n*.db\n*.enc\n*.tgz\n*.zip\n.local/\n.claude/\n.cursor/\n.playwright-mcp/\n.modelbot-workspaces/\n.site-build/\nsite-dist/\nwebsite/dist/\ndocs/internal/\ndata/\n__pycache__/\n`;

export function isPublicPath(path) {
  if (!path || path.includes("\\") || path.startsWith("/") || path.split("/").some(p => p === ".." || !p)) return false;
  if (PRIVATE_SCREENSHOTS.has(path)) return false;
  if (ROOT_FILES.has(path)) return true;
  if (EXCLUDED_FILE.test(path) || path.split("/").some(p => EXCLUDED_PART.test(p))) return false;
  return /^docs\/[^/]+\.md$/.test(path) || DIRECTORIES.some(prefix => path.startsWith(prefix));
}

export function scanText(path, text) {
  const findings = [];
  for (const [rule, pattern] of SCAN_RULES) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (TEST_CANARIES.get(path) === sha256(match[0])) continue;
      findings.push({ path, line: text.slice(0, match.index).split("\n").length, rule });
    }
  }
  return findings;
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function exportSource(out, repository) {
  assert.match(repository, /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/, "Use OWNER/REPO");
  assert(!existsSync(out), "Output must not exist; choose a new directory");
  const destination = join(realpathSync(dirname(out)), basename(out));
  const rel = relative(ROOT, destination);
  assert(rel.startsWith(`..${sep}`) || rel === "..", "Output must be outside the source checkout");
  const names = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 }).toString().split("\0").filter(Boolean);
  const files = [], findings = [];
  for (const name of [...new Set(names)].sort().filter(isPublicPath)) {
    let cursor = ROOT;
    for (const part of name.split("/")) {
      cursor = join(cursor, part);
      assert(!lstatSync(cursor).isSymbolicLink(), `Symlink refused: ${name}`);
    }
    const stat = lstatSync(cursor);
    assert(stat.isFile(), `Non-file refused: ${name}`);
    let bytes = readFileSync(cursor);
    if (name === ".gitignore") bytes = Buffer.from(PUBLIC_IGNORE);
    if (!bytes.includes(0)) {
      let text = bytes.toString("utf8");
      if (name !== "LICENSE") text = text.replace(/https:\/\/github\.com\/sanjaygbhat\/(?:modelbot|bothearth)(?=[/#.\s)"']|$)/g, `https://github.com/${repository}`);
      findings.push(...scanText(name, text));
      bytes = Buffer.from(text);
    }
    files.push({ path: name, bytes, executable: Boolean(stat.mode & 0o111) });
  }
  for (const required of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "README.md", "package.json", "package-lock.json", "src/cli/index.ts", "website/index.html", "sandbox/Moby-LICENSE.txt", "sandbox/Moby-NOTICE.txt"]) {
    assert(files.some(f => f.path === required), `Required file missing: ${required}`);
  }
  if (findings.length) {
    console.error(JSON.stringify({ status: "blocked", findings }, null, 2));
    process.exitCode = 1;
    return;
  }
  mkdirSync(destination, { mode: 0o700 });
  const manifestFiles = [];
  for (const file of files) {
    const target = join(destination, file.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    writeFileSync(target, file.bytes, { flag: "wx", mode: file.executable ? 0o755 : 0o644 });
    chmodSync(target, file.executable ? 0o755 : 0o644);
    manifestFiles.push({ path: file.path, bytes: file.bytes.length, mode: file.executable ? "755" : "644", sha256: sha256(file.bytes) });
  }
  const treeHash = sha256(JSON.stringify(manifestFiles));
  writeFileSync(join(destination, "PUBLIC_EXPORT.json"), JSON.stringify({ format: 1, repository,
    tree_sha256: treeHash, files: manifestFiles,
    scan: { status: "passed", rules: SCAN_RULES.map(([name]) => name), findings: [],
      reviewed_test_canaries: Object.fromEntries(TEST_CANARIES),
      limitations: "Targeted credential/path scan only. Review provenance, text context and image pixels before publishing." },
  }, null, 2) + "\n", { flag: "wx", mode: 0o644 });
  console.log(JSON.stringify({ destination, files: files.length, tree_sha256: treeHash, scan: "passed" }));
}

function selfTest() {
  for (const path of PRIVATE_SCREENSHOTS) assert(!isPublicPath(path), path);
  for (const path of ["src/cli/index.ts", "enterprise/server.mjs", "enterprise/README.md", "LICENSE", "docs/QUICKSTART.md", ".github/workflows/pages.yml", "tests/fixtures/jcs/input/values.json"]) assert(isPublicPath(path), path);
  for (const path of [".claude/secret", "docs/internal/review.md", "data/tasks.sqlite", "enterprise/licences.sqlite-wal", "enterprise/licences.sqlite-shm", "enterprise/.env", "enterprise/data/licences.sqlite", "website/.env", "src/.env.local", "mobile/android/local.properties", "website/dist/private.html", "src/../private", ".github/workflows/verify.yml"]) assert(!isPublicPath(path), path);
  assert.equal(scanText("sample", "safe documentation").length, 0);
  const secret = "ghp_" + "a".repeat(36);
  const found = scanText("sample", "first line\n" + secret);
  assert.deepEqual(found, [{ path: "sample", line: 2, rule: "github-token" }]);
  assert.equal(scanText("tests/unit/vault/vault.test.ts", secret).length, 1);
  assert(!JSON.stringify(found).includes(secret));
  console.log("export-public self-test passed");
}

if (process.argv[2] === "--self-test") selfTest();
else {
  const [out, repository = "sanjaygbhat/bothearth", ...extra] = process.argv.slice(2);
  assert(out && extra.length === 0, "Usage: node scripts/export-public.mjs NEW_OUTPUT_DIRECTORY [OWNER/REPO]");
  exportSource(resolve(out), repository);
}
