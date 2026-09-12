import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateGate } from "../../../src/policy/gate.ts";
import { type EffectSignals, signalsFromObservation } from "../../../src/policy/signals.ts";

function assertNoForcedHold(
  signals: EffectSignals,
  origin = "https://accounts.example/signin",
): void {
  assert.equal(
    evaluateGate({
      call: { tool: "browser_type", args: { ref: "e1", text: "x" } },
      signals,
      origin,
      mode: "supervised",
      origin_sets: {
        readable: ["accounts.example", "chatgpt.com"],
        writable: ["accounts.example", "chatgpt.com"],
      },
      enabled_gates: [],
    }).decision,
    "allow",
  );
}

test("chatgpt composer descriptor is not a hold without a header", () => {
  const yaml = [
    'modelbot_sensitive_detail: [{"tag":"div","name":"Chat with ChatGPT","branch":"header","rect":{"x":433,"y":319,"w":535,"h":42},"inViewport":true,"connected":true,"visible":true,"sized":true,"intersects":true,"pointer":true}]',
    '- textbox "Chat with ChatGPT" [ref=e1]',
  ].join("\n");
  const signals = signalsFromObservation({
    data: { url: "https://chatgpt.com/", yaml },
  });
  assert.equal(signals.password_field, false);
  assert.equal(signals.otp_field, false);
  assert.equal(signals.secret_evidence, undefined);
});

test("a snapshot with no kinds and no markers is not a password field", () => {
  const yaml = [
    '- textbox "Ask anything" [ref=e1]',
    '- button "Search" [ref=e2]',
    '- link "New chat" [ref=e3]',
  ].join("\n");
  const signals = signalsFromObservation({
    ok: true,
    data: { url: "https://chatgpt.com/", yaml },
  });
  assert.equal(signals.password_field, false);
  assert.equal(signals.secret_evidence, undefined);
});

test("header branch: a reported password kind is still a password field", () => {
  const yaml = [
    "modelbot_sensitive_fields: 1 password",
    'modelbot_sensitive_detail: [{"tag":"input","type":"password","name":"password","rect":{"x":8,"y":12,"w":240,"h":32},"inViewport":true,"connected":true,"visible":true,"sized":true,"intersects":true,"pointer":true}]',
    '- textbox "Email or phone" [ref=e1]',
  ].join("\n");
  const signals = signalsFromObservation({ data: { yaml } });
  assert.equal(signals.password_field, true);
  assert.equal(signals.secret_evidence?.[0]?.branch, "header");
  assert.equal(signals.secret_evidence?.[0]?.tag, "input");
  assert.equal(signals.secret_evidence?.[0]?.type, "password");
  assert.equal(signals.secret_evidence?.[0]?.name, "password");
  assert.deepEqual(signals.secret_evidence?.[0]?.rect, { x: 8, y: 12, w: 240, h: 32 });
  assert.equal(signals.secret_evidence?.[0]?.inViewport, true);
  assert.equal(JSON.stringify(signals.secret_evidence).length <= 400, true);
  assertNoForcedHold(signals);
});

test("marker branch: a stale data-modelbot-secret line is a password field", () => {
  const yaml = 'data-modelbot-secret\n- textbox "Ask ChatGPT" [ref=e1]';
  const signals = signalsFromObservation({ data: { yaml } });
  assert.equal(signals.password_field, true);
  assert.equal(signals.secret_evidence?.[0]?.branch, "marker");
  assertNoForcedHold(signals);
});

test("name branch: an unfocused Password textbox is a hint, not a hold", () => {
  const yaml = [
    '- textbox "Ask ChatGPT" [ref=e1]',
    '- textbox "Password" [ref=e2]',
    '- button "New chat" [ref=e3]',
  ].join("\n");
  const signals = signalsFromObservation({
    data: { url: "https://chatgpt.com/", yaml },
  });
  assert.equal(signals.password_field, false);
  assert.equal(signals.secret_evidence, undefined);
});

test("name branch: a focused Password textbox reaches observation without a hold", () => {
  const yaml = '- textbox "Password" [active] [ref=e1]';
  const signals = signalsFromObservation({ data: { yaml } });
  assert.equal(signals.password_field, true);
  assert.equal(signals.secret_evidence?.[0]?.branch, "name");
  assert.equal(signals.secret_evidence?.[0]?.name, "Password");
  assert.equal(signals.secret_evidence?.[0]?.role, "textbox");
  assertNoForcedHold(signals);
});

test("name branch: an unfocused Password textbox with a marked field still reaches observation", () => {
  const yaml = 'modelbot_sensitive_fields: 1 password\n- textbox "Password" [ref=e1]';
  const signals = signalsFromObservation({ data: { yaml } });
  assert.equal(signals.password_field, true);
  assert.equal(signals.secret_evidence?.[0]?.branch, "header");
  assertNoForcedHold(signals);
});

test("name branch: an unfocused Password textbox next to Sign in is a hint", () => {
  const yaml = ['- textbox "Password" [ref=e1]', '- button "Sign in" [ref=e2]'].join("\n");
  const signals = signalsFromObservation({ data: { yaml } });
  assert.equal(signals.password_field, false);
  assert.equal(signals.secret_evidence, undefined);
});

test("name branch: Change password on a signed-in settings page is not a hold", () => {
  const yaml = [
    '- heading "Settings" [ref=e1]',
    '- button "Change password" [ref=e2]',
    '- button "Log out" [ref=e3]',
  ].join("\n");
  const signals = signalsFromObservation({
    data: { url: "https://chatgpt.com/#settings", yaml },
  });
  assert.equal(signals.password_field, false);
  assert.equal(signals.secret_evidence, undefined);
});

test("marked detail keeps allowlisted keys and drops value", () => {
  const yaml = [
    "modelbot_sensitive_fields: 1 password",
    'modelbot_sensitive_detail: [{"tag":"input","type":"password","name":"password","value":"hunter2","evil":true,"kind":"password","flags":{"inViewport":true,"value":"nope"},"rect":{"x":8,"y":12,"w":240,"h":32,"z":9}}]',
  ].join("\n");
  const signals = signalsFromObservation({ data: { yaml } });
  const row = signals.secret_evidence?.[0];
  assert.equal(signals.password_field, true);
  assert.equal(row?.tag, "input");
  assert.equal(row?.type, "password");
  assert.equal(row?.name, "password");
  assert.equal(row?.kind, "password");
  assert.equal(row?.inViewport, true);
  assert.deepEqual(row?.rect, { x: 8, y: 12, w: 240, h: 32 });
  assert.equal("value" in (row ?? {}), false);
  assert.equal("evil" in (row ?? {}), false);
  assert.equal("flags" in (row ?? {}), false);
  assert.equal(JSON.stringify(signals.secret_evidence).includes("hunter2"), false);
  assertNoForcedHold(signals);
});
