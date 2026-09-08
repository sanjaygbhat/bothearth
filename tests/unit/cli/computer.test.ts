/**
 * CLI parse tests for `modelbot computer`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseComputerArgs } from "../../../src/cli/computer.ts";

describe("computer CLI parse", () => {
  it("parses create --compose", () => {
    const p = parseComputerArgs(["create", "demo", "--compose"]);
    assert.equal(p.action, "create");
    assert.equal(p.name, "demo");
    assert.equal(p.compose, true);
  });

  it("parses destroy with workspace-root", () => {
    const p = parseComputerArgs([
      "destroy",
      "demo",
      "--compose",
      "--workspace-root",
      "/tmp/ws",
      "--wipe-profile",
    ]);
    assert.equal(p.action, "destroy");
    assert.equal(p.compose, true);
    assert.equal(p.workspaceRoot, "/tmp/ws");
    assert.equal(p.wipeProfile, true);
  });

  it("create without --compose defaults compose false", () => {
    const p = parseComputerArgs(["create", "x"]);
    assert.equal(p.compose, false);
  });
});
