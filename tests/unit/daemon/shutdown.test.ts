/**
 * A graceful close takes seconds — closing browsers, draining runs, flushing the
 * audit tail. The listening socket has to go first: while it is up, a restart
 * reads the daemon as serving, refuses to start, and leaves nothing listening
 * once the shutdown finishes.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startDaemon } from "../../../src/daemon/server.ts";

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(2_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

test("close() stops listening before it drains, not after", async () => {
  const daemon = await startDaemon({
    port: 0,
    host: "127.0.0.1",
    mcpToken: "shutdown-mcp",
    bootstrapToken: "shutdown-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-shutdown-")),
  });
  assert.equal(await accepts(daemon.port), true);

  // Synchronous: `close()` runs to its first await before yielding, so this is
  // the state every probe during the drain would see.
  const closing = daemon.close();
  assert.equal(daemon.server.listening, false, "still listening after close() was called");

  await closing;
  assert.equal(await accepts(daemon.port), false);
});
