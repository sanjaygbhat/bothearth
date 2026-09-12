import assert from "node:assert/strict";
import { test } from "node:test";
import { containerRunState } from "../../../src/sandbox/lifecycle.ts";

test("container inspect maps running, paused, exited and missing to list statuses", () => {
  assert.equal(containerRunState(null), "stopped");
  assert.equal(containerRunState({}), "stopped");
  assert.equal(containerRunState({ State: { Status: "running", Running: true, Paused: false } }), "running");
  assert.equal(containerRunState({ State: { Status: "paused", Running: true, Paused: true } }), "paused");
  assert.equal(containerRunState({ State: { Status: "exited", Running: false, Paused: false } }), "stopped");
  assert.equal(containerRunState({ State: { Status: "dead", Running: false } }), "stopped");
});
