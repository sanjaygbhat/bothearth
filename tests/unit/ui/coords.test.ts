import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPointerMessage,
  humanControlBanner,
  mapClientToCssPx,
  shouldRelayInput,
} from "../../../src/ui/live/coords.ts";

describe("ui live coords", () => {
  it("maps client coords to CSS viewport px without multiplying dpr", () => {
    const mapped = mapClientToCssPx(
      100,
      50,
      { left: 0, top: 0, width: 640, height: 360 },
      { w: 1280, h: 720, dpr: 2 },
    );
    assert.equal(mapped.x, 200);
    assert.equal(mapped.y, 100);
  });

  it("clamps to viewport bounds", () => {
    const mapped = mapClientToCssPx(
      9999,
      -10,
      { left: 0, top: 0, width: 100, height: 100 },
      { w: 800, h: 600, dpr: 3 },
    );
    assert.ok(mapped.x < 800);
    assert.equal(mapped.y, 0);
  });

  it("relays input only in HUMAN mode", () => {
    assert.equal(shouldRelayInput("human"), true);
    assert.equal(shouldRelayInput("agent"), false);
    assert.equal(shouldRelayInput("validating"), false);
  });

  it("shows recording-off banner in HUMAN", () => {
    assert.equal(
      humanControlBanner("human"),
      "You have control — your bot is not watching",
    );
    assert.equal(humanControlBanner("agent"), null);
  });

  it("builds pointer control messages in CSS px", () => {
    const msg = buildPointerMessage(3, "down", 12.5, 40, { button: 0 });
    assert.equal(msg.t, "pointer");
    assert.equal(msg.epoch, 3);
    assert.equal(msg.x, 12.5);
    assert.equal(msg.y, 40);
    assert.equal(msg.button, 0);
  });
});
