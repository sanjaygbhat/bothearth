/**
 * Docker-int placeholder for the daemon suite.
 * Daemon itself is host-process; this suite only proves lock acquisition
 * (the shared lock contract) so later docker-backed computer wiring can serialize.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acquireDockerLock } from "../lock.ts";

describe("daemon docker-int lock", () => {
  it("acquires and releases docker-int lock", async () => {
    const lock = await acquireDockerLock();
    try {
      assert.ok(lock);
    } finally {
      lock.release();
    }
  });
});
