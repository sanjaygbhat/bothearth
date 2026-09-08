/**
 * `write_file` path policy and caps.
 *
 * The tool is the only writer a browser-only computer has, so its confinement to
 * `<workspace>/out` is a trust boundary, not a convenience: every escape shape the
 * jail is meant to stop is asserted here (`..`, absolute path outside, symlinked
 * intermediate directory, symlinked final component), plus the two caps.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { writeFile } from "../../../computer-server/src/out-files.ts";
import { createState, dispatch } from "../../../computer-server/src/dispatch.ts";

let workspace: string;
let outside: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved.workspace = process.env.MODELBOT_WORKSPACE;
  saved.maxBytes = process.env.MODELBOT_WRITE_FILE_MAX_BYTES;
  saved.maxFiles = process.env.MODELBOT_WRITE_FILE_MAX_FILES;
  workspace = mkdtempSync(join(tmpdir(), "mb-write-ws-"));
  outside = mkdtempSync(join(tmpdir(), "mb-write-out-"));
  process.env.MODELBOT_WORKSPACE = workspace;
});

afterEach(() => {
  for (const [key, name] of [
    ["workspace", "MODELBOT_WORKSPACE"],
    ["maxBytes", "MODELBOT_WRITE_FILE_MAX_BYTES"],
    ["maxFiles", "MODELBOT_WRITE_FILE_MAX_FILES"],
  ] as const) {
    if (saved[key] === undefined) delete process.env[name];
    else process.env[name] = saved[key]!;
  }
});

function ok(result: ReturnType<typeof writeFile>): Record<string, unknown> {
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as { ok: true; data: Record<string, unknown> }).data;
}

function errorCode(result: ReturnType<typeof writeFile>): string {
  assert.equal(result.ok, false, JSON.stringify(result));
  return (result as { ok: false; error: { code: string } }).error.code;
}

describe("write_file happy path", () => {
  it("writes into out/, returns a workspace-relative path, bytes and sha256", () => {
    const content = "date,amount\n2026-08-01,12.00\n";
    const data = ok(writeFile({ path: "invoices.csv", content }));
    assert.equal(data.path, join("out", "invoices.csv"));
    assert.equal(data.bytes, Buffer.byteLength(content));
    assert.equal(
      data.sha256,
      createHash("sha256").update(content).digest("hex"),
    );
    assert.equal(readFileSync(join(workspace, "out", "invoices.csv"), "utf8"), content);
  });

  it("creates nested directories under out/", () => {
    const data = ok(writeFile({ path: "report/q3/summary.md", content: "# hi\n" }));
    assert.equal(data.path, join("out", "report", "q3", "summary.md"));
  });

  it("accepts an absolute path that is already inside out/", () => {
    const data = ok(
      writeFile({ path: join(workspace, "out", "a.txt"), content: "a" }),
    );
    assert.equal(data.path, join("out", "a.txt"));
  });

  it("decodes base64 content", () => {
    const data = ok(
      writeFile({ path: "b.bin", content: Buffer.from([0, 1, 2, 250]).toString("base64"), encoding: "base64" }),
    );
    assert.equal(data.bytes, 4);
    assert.deepEqual([...readFileSync(join(workspace, "out", "b.bin"))], [0, 1, 2, 250]);
  });

  it("rejects content that is not valid base64 rather than truncating it", () => {
    assert.equal(errorCode(writeFile({ path: "c.bin", content: "not!base64!", encoding: "base64" })), "E_POLICY");
  });
});

describe("write_file modes", () => {
  it("overwrite replaces, append extends, create refuses an existing file", () => {
    ok(writeFile({ path: "m.txt", content: "one" }));
    assert.equal(ok(writeFile({ path: "m.txt", content: "two" })).bytes, 3);
    assert.equal(readFileSync(join(workspace, "out", "m.txt"), "utf8"), "two");

    assert.equal(ok(writeFile({ path: "m.txt", content: "three", mode: "append" })).bytes, 8);
    assert.equal(readFileSync(join(workspace, "out", "m.txt"), "utf8"), "twothree");

    assert.equal(errorCode(writeFile({ path: "m.txt", content: "x", mode: "create" })), "E_POLICY");
    assert.equal(ok(writeFile({ path: "fresh.txt", content: "x", mode: "create" })).bytes, 1);
  });

  it("rejects an unknown mode or encoding", () => {
    assert.equal(errorCode(writeFile({ path: "m.txt", content: "x", mode: "delete" as never })), "E_POLICY");
    assert.equal(errorCode(writeFile({ path: "m.txt", content: "x", encoding: "rot13" as never })), "E_POLICY");
  });
});

describe("write_file path policy", () => {
  it("refuses '..' in any position", () => {
    for (const path of ["../escape.txt", "a/../../escape.txt", "..", "a/.."]) {
      assert.equal(errorCode(writeFile({ path, content: "x" })), "E_POLICY", path);
    }
    assert.equal(existsSync(join(workspace, "escape.txt")), false);
  });

  it("refuses an absolute path outside out/", () => {
    for (const path of [
      join(outside, "escape.txt"),
      "/etc/passwd",
      join(workspace, "escape.txt"),
      join(workspace, "downloads", "escape.txt"),
    ]) {
      assert.equal(errorCode(writeFile({ path, content: "x" })), "E_POLICY", path);
    }
    assert.equal(existsSync(join(workspace, "escape.txt")), false);
    assert.equal(existsSync(join(outside, "escape.txt")), false);
  });

  it("refuses out/ itself and an empty or NUL path", () => {
    assert.equal(errorCode(writeFile({ path: join(workspace, "out"), content: "x" })), "E_POLICY");
    assert.equal(errorCode(writeFile({ path: "", content: "x" })), "E_POLICY");
    assert.equal(errorCode(writeFile({ path: "a\0b", content: "x" })), "E_POLICY");
  });

  it("refuses a symlinked intermediate directory pointing outside", () => {
    mkdirSync(join(workspace, "out"), { recursive: true });
    symlinkSync(outside, join(workspace, "out", "link"));
    assert.equal(errorCode(writeFile({ path: "link/escape.txt", content: "x" })), "E_POLICY");
    assert.equal(existsSync(join(outside, "escape.txt")), false);
  });

  it("refuses a symlinked final component pointing outside", () => {
    mkdirSync(join(workspace, "out"), { recursive: true });
    const victim = join(outside, "victim.txt");
    writeFileSync(victim, "original");
    symlinkSync(victim, join(workspace, "out", "alias.txt"));
    assert.notEqual(errorCode(writeFile({ path: "alias.txt", content: "pwned" })), "");
    assert.equal(readFileSync(victim, "utf8"), "original");
  });

  it("refuses when out/ itself is a symlink out of the workspace", () => {
    symlinkSync(outside, join(workspace, "out"));
    assert.equal(errorCode(writeFile({ path: "escape.txt", content: "x" })), "E_POLICY");
    assert.equal(existsSync(join(outside, "escape.txt")), false);
  });
});

describe("write_file caps", () => {
  it("refuses content over the byte cap, including via append", () => {
    process.env.MODELBOT_WRITE_FILE_MAX_BYTES = "16";
    assert.equal(errorCode(writeFile({ path: "big.txt", content: "x".repeat(17) })), "E_LIMIT");
    assert.equal(existsSync(join(workspace, "out", "big.txt")), false);

    ok(writeFile({ path: "big.txt", content: "x".repeat(10) }));
    assert.equal(errorCode(writeFile({ path: "big.txt", content: "y".repeat(10), mode: "append" })), "E_LIMIT");
    assert.equal(readFileSync(join(workspace, "out", "big.txt"), "utf8"), "x".repeat(10));
  });

  it("refuses a new file past the file-count cap but still updates existing ones", () => {
    process.env.MODELBOT_WRITE_FILE_MAX_FILES = "3";
    for (const name of ["a.txt", "nested/b.txt", "c.txt"]) ok(writeFile({ path: name, content: "x" }));
    assert.equal(errorCode(writeFile({ path: "d.txt", content: "x" })), "E_LIMIT");
    assert.equal(existsSync(join(workspace, "out", "d.txt")), false);
    // An existing file is not a new inode, so it stays writable at the cap.
    assert.equal(ok(writeFile({ path: "a.txt", content: "yy" })).bytes, 2);
  });

  it("falls back to the 10 MB / 200 file defaults when the env vars are junk", () => {
    process.env.MODELBOT_WRITE_FILE_MAX_BYTES = "not-a-number";
    process.env.MODELBOT_WRITE_FILE_MAX_FILES = "0";
    assert.equal(ok(writeFile({ path: "ok.txt", content: "x".repeat(1000) })).bytes, 1000);
  });
});

describe("write_file over RPC", () => {
  it("is served by the browser role, unlike the shell-only files_* family", async () => {
    const state = createState("browser");
    const result = await dispatch(state, {
      jsonrpc: "2.0",
      id: 1,
      method: "write_file",
      params: { path: "rpc.csv", content: "a,b\n1,2\n", encoding: null, mode: null },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(
      readFileSync(join(workspace, "out", "rpc.csv"), "utf8"),
      "a,b\n1,2\n",
    );

    const shellOnly = await dispatch(state, {
      jsonrpc: "2.0",
      id: 2,
      method: "shell_exec",
      params: { command: "true" },
    });
    assert.equal(shellOnly.ok, false);
  });
});
