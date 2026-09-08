import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VERSION } from "../src/index.ts";

describe("smoke", () => {
  it("exports VERSION", () => {
    assert.equal(VERSION, "0.0.1");
  });
});
