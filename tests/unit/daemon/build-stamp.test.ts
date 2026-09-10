/**
 * Staleness used to be judged by the Dockerfile's mtime, and
 * `write_file` shipped by adding a source file the Dockerfile copies in
 * without touching the Dockerfile itself. So the app went on reporting a
 * current image while the computer inside it could not run the tool the daemon
 * was offering. The stamp has to move when any build input moves.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStamp, clearBuildStampCache, STAMP_INPUTS } from "../../../src/daemon/build-stamp.ts";

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), "stamp-"));
  mkdirSync(join(root, "computer-server", "src"), { recursive: true });
  mkdirSync(join(root, "src", "protocol"), { recursive: true });
  mkdirSync(join(root, "src", "types"), { recursive: true });
  mkdirSync(join(root, "src", "tools"), { recursive: true });
  writeFileSync(join(root, "Dockerfile.computer"), "FROM debian\n");
  writeFileSync(join(root, "computer-server", "src", "dispatch.ts"), "export const a = 1;\n");
  return root;
}

test("a new computer-server source file moves the stamp", () => {
  const root = tree();
  try {
    clearBuildStampCache();
    const before = buildStamp("computer", root);
    // Exactly that change: a new file, no Dockerfile edit.
    writeFileSync(join(root, "computer-server", "src", "out-files.ts"), "export const writeFile = 1;\n");
    clearBuildStampCache();
    assert.notEqual(buildStamp("computer", root), before, "adding a tool must make the built image stale");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("editing a copied source file moves the stamp", () => {
  const root = tree();
  try {
    clearBuildStampCache();
    const before = buildStamp("computer", root);
    writeFileSync(join(root, "computer-server", "src", "dispatch.ts"), "export const a = 2;\n");
    clearBuildStampCache();
    assert.notEqual(buildStamp("computer", root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an untouched tree stamps identically, so readiness does not flap", () => {
  const root = tree();
  try {
    clearBuildStampCache();
    const a = buildStamp("computer", root);
    clearBuildStampCache();
    assert.equal(buildStamp("computer", root), a);
    assert.match(a, /^[0-9a-f]{16}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed dependencies are not part of the stamp", () => {
  const root = tree();
  try {
    clearBuildStampCache();
    const before = buildStamp("computer", root);
    mkdirSync(join(root, "computer-server", "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(root, "computer-server", "node_modules", "left-pad", "index.js"), "x\n");
    clearBuildStampCache();
    assert.equal(buildStamp("computer", root), before, "node_modules is installed at build time, not copied");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the proxy stamp does not move when the browser computer changes", () => {
  const root = tree();
  try {
    mkdirSync(join(root, "src", "proxy"), { recursive: true });
    writeFileSync(join(root, "Dockerfile.proxy"), "FROM node\n");
    writeFileSync(join(root, "package.json"), "{}\n");
    clearBuildStampCache();
    const proxy = buildStamp("proxy", root);
    writeFileSync(join(root, "computer-server", "src", "new.ts"), "1\n");
    clearBuildStampCache();
    assert.equal(buildStamp("proxy", root), proxy, "only the image that changed needs rebuilding");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("UI and model-runner edits do not require rebuilding any computer image", () => {
  const root = tree();
  try {
    const images = ["computer", "shell", "proxy"] as const;
    clearBuildStampCache();
    const before = images.map((image) => buildStamp(image, root));
    for (const part of ["ui", "daemon"]) {
      mkdirSync(join(root, "src", part));
      writeFileSync(join(root, "src", part, "changed.ts"), "export const updated = true;\n");
    }
    clearBuildStampCache();
    assert.deepEqual(images.map((image) => buildStamp(image, root)), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the stamped inputs match what the Dockerfiles copy in", () => {
  // A widened COPY line with no matching entry here is how the original bug
  // slipped through; this is the guard that would have caught it.
  for (const image of ["computer", "shell", "proxy"] as const) {
    assert.ok(STAMP_INPUTS[image].includes(`Dockerfile.${image}`), `${image} does not stamp its own Dockerfile`);
    for (const notice of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) {
      assert.ok(STAMP_INPUTS[image].includes(notice), `${image} must rebuild when ${notice} changes`);
    }
  }
  assert.ok(STAMP_INPUTS.computer.includes("computer-server"));
  assert.ok(STAMP_INPUTS.shell.includes("computer-server"));
});
