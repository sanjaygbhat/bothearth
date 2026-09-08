import assert from "node:assert/strict";
import { test } from "node:test";
import { hasCaptchaSignal, signalsFromObservation } from "../../../src/policy/signals.ts";
import { evaluateGate } from "../../../src/policy/gate.ts";

const mailUrl = "https://mail.example/inbox#search/payment+confirm";
const observation = (yaml: string, url = mailUrl) => ({ ok: true, data: { url, yaml } });

test("mail prose, message controls and field values do not describe payment controls", () => {
  const signals = signalsFromObservation(observation([
    '- row "Example Vendor, Invoice Payment Confirmation" [ref=e1]',
    '- checkbox "Invoice Payment Confirmation" [ref=e2]',
    '- link "Read payment confirmation email" [ref=e3]',
    '- button "Invoice Payment Confirmation" [ref=e4]',
    '- button "Payment confirmation email" [ref=e6]',
    '- link "Payment confirmation receipt" [ref=e7]',
    '- paragraph: Your article mentions card details and card number.',
    '- paragraph: https://shop.example/checkout',
    '- textbox "Search mail" [ref=e5]: card details',
  ].join("\n")));
  assert.equal(signals.payment_field, false);
  assert.equal(signals.checkout_path, false);
  for (const call of [
    { tool: "browser_click", args: { ref: "e1" } },
    { tool: "browser_navigate", args: { url: mailUrl } },
  ]) assert.equal(evaluateGate({ call, signals, origin: mailUrl, mode: "supervised",
    origin_sets: { readable: ["mail.example"], writable: ["mail.example"] },
  }).decision, "allow");
});

test("named card entry and explicit payment confirmation controls retain the payment gate", () => {
  for (const yaml of [
    '- textbox "Card number" [ref=e1]',
    '- textbox "Card details" [ref=e1]',
    '- spinbutton "Credit card number" [ref=e1]',
    '- button "Confirm payment" [ref=e1]',
    '- button "Payment confirmation" [ref=e1]',
    '- button "Payment confirm" [ref=e1]',
    '- link "Confirm payment" [ref=e1]',
    '- button "Payment confirm $20" [ref=e1]',
    '- button "Confirm payment ($20)" [ref=e1]',
    '- button "Confirm payment ₹20" [ref=e1]',
  ]) {
    const signals = signalsFromObservation(observation(yaml));
    assert.equal(signals.payment_field, true, yaml);
    const result = evaluateGate({ call: { tool: "browser_click", args: { ref: "e1" } },
      signals, origin: mailUrl, mode: "supervised",
      origin_sets: { readable: ["mail.example"], writable: ["mail.example"] } });
    assert.equal(result.decision, "require_approval", yaml);
    assert.equal(result.reason, "payment_field", yaml);
  }
});

test("checkout signals use the observed pathname or an explicit hash route", () => {
  for (const url of ["https://shop.example/pay", "https://shop.example/checkout/shipping",
    "https://shop.example/#/pay", "https://shop.example/#!/checkout?step=2"])
    assert.equal(signalsFromObservation(observation("", url)).checkout_path, true, url);
  for (const url of [mailUrl, "https://mail.example/#search/https://shop.example/pay",
    "https://mail.example/?next=/checkout", "https://shop.example/payment-history"])
    assert.equal(signalsFromObservation(observation("", url)).checkout_path, false, url);
});

test("one observation yields the secret, payment, checkout and captcha signals", () => {
  const signals = signalsFromObservation({
    data: { url: "https://example.com/pay", yaml: 'data-modelbot-secret\n- textbox "Card details" [ref=e1]\nhttps://client.arkoselabs.com/challenge' },
  });
  assert.equal(signals.password_field, true);
  assert.equal(signals.payment_field, true);
  assert.equal(signals.checkout_path, true);
  assert.equal(hasCaptchaSignal(signals), true);
  assert.deepEqual(signalsFromObservation(undefined).captcha_iframes, []);
});
