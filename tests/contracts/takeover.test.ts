import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyTakeoverTransition,
  durableStateAfterRelease,
  isTakeoverBusy,
  TAKEOVER_BUSY_STATES,
  TAKEOVER_TRANSITIONS,
  toWireState,
} from "../../src/protocol/takeover.ts";
import type { TakeoverState } from "../../src/types/contracts.ts";
import { ERROR_CODES } from "../../src/protocol/errors.ts";

describe("takeover FSM", () => {
  it("transition table matches ARCH (incl. TTL→paused)", () => {
    const pairs = TAKEOVER_TRANSITIONS.map((t) => `${t.from}|${t.event}|${t.to}`);
    assert.ok(pairs.includes("agent|request|takeover_requested"));
    assert.ok(pairs.includes("takeover_requested|grant|human"));
    assert.ok(pairs.includes("human|release|resume_validating"));
    assert.ok(pairs.includes("resume_validating|validated|agent"));
    assert.ok(pairs.includes("resume_validating|still_sensitive|human"));
    assert.ok(pairs.includes("human|ttl|paused"));
    assert.ok(pairs.includes("takeover_requested|ttl|paused"));
    assert.ok(pairs.includes("resume_validating|ttl|paused"));
    assert.ok(!pairs.some((p) => p.endsWith("|ttl|agent")));
  });

  it("applyTakeoverTransition walks happy path", () => {
    let s: TakeoverState = "agent";
    s = applyTakeoverTransition(s, "request")!;
    assert.equal(s, "takeover_requested");
    s = applyTakeoverTransition(s, "grant")!;
    assert.equal(s, "human");
    s = applyTakeoverTransition(s, "release")!;
    assert.equal(s, "resume_validating");
    s = applyTakeoverTransition(s, "validated")!;
    assert.equal(s, "agent");
  });

  it("busy states cover TAKEOVER_REQUESTED/HUMAN/RESUME_VALIDATING", () => {
    assert.deepEqual([...TAKEOVER_BUSY_STATES].sort(), [
      "human",
      "paused",
      "resume_validating",
      "takeover_requested",
    ]);
    assert.equal(isTakeoverBusy("agent"), false);
    assert.equal(isTakeoverBusy("paused"), true);
    assert.equal(isTakeoverBusy("human"), true);
    assert.equal(toWireState("takeover_requested"), "requested");
    assert.equal(toWireState("resume_validating"), "validating");
    assert.equal(toWireState("paused"), "paused");
  });

  it("durableStateAfterRelease keeps human/validating; else agent", () => {
    assert.equal(durableStateAfterRelease({ state: "human" }), "human");
    assert.equal(durableStateAfterRelease({ state: "validating" }), "resume_validating");
    assert.equal(durableStateAfterRelease({ state: "agent" }), "agent");
    assert.equal(durableStateAfterRelease({}), "agent");
    assert.equal(durableStateAfterRelease(null), "agent");
  });
});

describe("error codes", () => {
  it("exports ARCH §4 common table", () => {
    assert.deepEqual([...ERROR_CODES], [
      "E_AUTH",
      "E_CAPABILITY",
      "E_SPEND_CAP",
      "E_POLICY",
      "E_POLICY_PENDING",
      "E_STALE_REF",
      "E_TIMEOUT",
      "E_TAKEOVER_BUSY",
      "E_TAKEOVER_EXPIRED",
      "E_SANDBOX_DEAD",
      "E_IO",
      "E_LIMIT",
    ]);
  });
});
