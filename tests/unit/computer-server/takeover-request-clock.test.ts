/**
 * A takeover the bot asked for and nobody has answered has no deadline. The
 * status payload used to fill the empty field with `new Date()`, which the
 * daemon stored as the lease deadline — a question that expired the instant it
 * was asked.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createTakeoverSession,
  statusPayload,
  transition,
} from "../../../computer-server/src/takeover-gate.ts";

const TTL_MS = 600_000;

test("the status of an unanswered request carries no expiry", () => {
  const session = createTakeoverSession();
  assert.equal(statusPayload(session).expires_at, null, "an idle session invented a deadline");

  transition(session, "request");
  const asked = statusPayload(session);
  assert.equal(asked.state, "requested");
  assert.equal(asked.expires_at, null, "asking for help started the human's clock");
  assert.match(asked.takeover_id, /^tk_/);
});

test("the grant starts the clock at now + TTL", () => {
  const session = createTakeoverSession();
  transition(session, "request");
  const before = Date.now();
  transition(session, "grant");
  const granted = statusPayload(session);
  assert.equal(granted.state, "human");
  const deadline = Date.parse(granted.expires_at ?? "");
  assert.ok(
    deadline >= before + TTL_MS && deadline <= Date.now() + TTL_MS,
    `the lease deadline ${granted.expires_at} is not one TTL from the grant`,
  );
});

test("releasing clears the deadline again", () => {
  const session = createTakeoverSession();
  transition(session, "request");
  transition(session, "grant");
  transition(session, "release");
  transition(session, "validated");
  assert.equal(statusPayload(session).expires_at, null, "a released lease kept a deadline");
});
