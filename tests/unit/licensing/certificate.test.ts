import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { verifyLicenceCertificate } from "../../../src/licensing/certificate.ts";

const keys = generateKeyPairSync("ed25519");
const header = { alg: "Ed25519", typ: "bothearth-license+jws", kid: "test-signer-1" };
const claims = { schema: 1, issuer: "bothearth", product: "bothearth-daemon", licence_id: "BH-synthetic", holder_ref: "holder-synthetic",
  tier: "noncommercial", covered_release: "synthetic-release-1", issued_at: "2020-01-01T00:00:00.000Z", terms_id: "synthetic-terms-1", terms_sha256: "a".repeat(64) };
const token = (payload = claims, protectedHeader: any = header) => {
  const input = [protectedHeader, payload].map((value) => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
  return `${input}.${sign(null, Buffer.from(input), keys.privateKey).toString("base64url")}`;
};
const options = { publicKeys: { "test-signer-1": keys.publicKey }, coveredRelease: "synthetic-release-1" };

test("a portable certificate verifies offline without renewal or a noncommercial daemon cap", () => {
  assert.deepEqual(verifyLicenceCertificate(`\n${token()}\n`, options), claims);
  const commercial = { ...claims, tier: "commercial", concurrent_daemons: 1 };
  assert.deepEqual(verifyLicenceCertificate(token(commercial), options), commercial);
});

test("a licence cannot substitute another algorithm, key source, issuer, product or release", () => {
  for (const badHeader of [{ ...header, alg: "none" }, { ...header, alg: "EdDSA" }, { ...header, kid: "unknown" },
    { ...header, jku: "https://attacker.invalid/keys" }, { ...header, typ: "JWT" }, { ...header, crit: [] }]) {
    assert.throws(() => verifyLicenceCertificate(token(claims, badHeader), options));
  }
  for (const badClaims of [{ ...claims, issuer: "attacker" }, { ...claims, product: "another-product" }, { ...claims, exp: 9999999999 },
    { ...claims, email: "not-in-a-licence@example.test" }, { ...claims, tier: "commercial", concurrent_daemons: 50 },
    { ...claims, concurrent_daemons: 1 }, { ...claims, issued_at: "invalid" }]) {
    assert.throws(() => verifyLicenceCertificate(token(badClaims), options));
  }
  assert.throws(() => verifyLicenceCertificate(token(), { ...options, coveredRelease: "synthetic-release-2" }), /covers synthetic-release-1, not synthetic-release-2/);
});

test("tampering, untrusted signers, malformed and oversized certificates fail", () => {
  const valid = token();
  const parts = valid.split(".");
  parts[1] = Buffer.from(JSON.stringify({ ...claims, tier: "commercial", concurrent_daemons: 1 })).toString("base64url");
  assert.throws(() => verifyLicenceCertificate(parts.join("."), options));
  assert.throws(() => verifyLicenceCertificate(valid, { ...options, publicKeys: { "test-signer-1": generateKeyPairSync("ed25519").publicKey } }));
  for (const bad of ["", "null.a.a", "a.a.a", "a".repeat(8193), `${valid}=`, ` ${valid}garbage`]) assert.throws(() => verifyLicenceCertificate(bad, options));
});
