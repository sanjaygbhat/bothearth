import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, it } from "node:test";
import { createJsonRpcClient } from "../../../src/sandbox/client.ts";

describe("sandbox exec transport failures", () => {
  it("rejects a pending request when the child emits error", async () => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const client = createJsonRpcClient(
      new PassThrough(),
      stdout,
      child,
    );
    const failure = new Error("spawn docker ENOENT");
    const rejected = assert.rejects(client.request("ping"), (err) => err === failure);

    child.emit("error", failure);
    stdout.end();

    await rejected;
    await client.close();
  });
  it("rejects queued requests when close runs before their writes", async () => {
    let writes = 0;
    const stdout = new PassThrough();
    const stdin = new Writable({ write(_chunk, _encoding, callback) { writes++; callback(); } });
    const client = createJsonRpcClient(stdin, stdout);
    const rejected = assert.rejects(client.request("screencast.unsubscribe"), /client closed/);
    stdout.end();
    await client.close();
    await rejected;
    assert.equal(writes, 0);
  });

  it("handles writable stream errors and rejects the pending response", async () => {
    const stdout = new PassThrough();
    const stdin = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("broken pipe")); } });
    const client = createJsonRpcClient(stdin, stdout);
    await assert.rejects(client.request("screencast.unsubscribe"), /broken pipe/);
    stdout.end();
    await client.close();
  });
});
