import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { verifyLicenceCertificate } from "../licensing/certificate.ts";
import type { Store } from "./store.ts";

export interface LicencePolicy {
  coveredRelease: string;
  publicKeys: Record<string, string>;
  accountUrl: string;
  required: boolean;
}

/** An explicit release configuration enables activation; existing releases stay unchanged. */
export function readLicencePolicy(path?: string): LicencePolicy | undefined {
  if (!path) return;
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.required !== "boolean" || typeof value.coveredRelease !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,159}$/.test(value.coveredRelease)
    || !value.publicKeys || typeof value.publicKeys !== "object" || Array.isArray(value.publicKeys)
    || !Object.keys(value.publicKeys).length || typeof value.accountUrl !== "string")
    throw new Error("The licence release configuration is incomplete.");
  const url = new URL(value.accountUrl);
  if (url.username || url.password || url.hash || url.search || (url.protocol !== "https:"
    && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
    throw new Error("The licence account URL must use HTTPS.");
  for (const [id, pem] of Object.entries(value.publicKeys)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,159}$/.test(id) || typeof pem !== "string"
      || !pem.startsWith("-----BEGIN PUBLIC KEY-----") || createPublicKey(pem).asymmetricKeyType !== "ed25519")
      throw new Error("Configure only public Ed25519 licence verification keys.");
  }
  return value as LicencePolicy;
}

export function licenceState(store: Store, policy?: LicencePolicy) {
  if (!policy) return { status: "legacy" as const, required: false, label: "Existing release terms" };
  const base = { required: policy.required, account_url: policy.accountUrl, covered_release: policy.coveredRelease };
  const saved = store.db.prepare("SELECT certificate FROM installation_licence WHERE id=1").get() as { certificate: string } | undefined;
  if (saved) {
    try {
      const claims = verifyLicenceCertificate(saved.certificate, policy);
      return { ...base, status: "active" as const, tier: claims.tier,
        label: claims.tier === "commercial" ? "Commercial" : "Non-commercial", licence_id: claims.licence_id };
    } catch { /* Keep the old key for recovery; it may cover another release. */ }
  }
  return { ...base, status: "unlicensed" as const, label: "Add your licence key" };
}

export function activateLicence(store: Store, policy: LicencePolicy, certificate: string) {
  verifyLicenceCertificate(certificate, policy);
  // Validation precedes replacement: a bad paste must not remove a working key.
  store.db.prepare("INSERT INTO installation_licence(id,certificate) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET certificate=excluded.certificate")
    .run(certificate.trim());
  return licenceState(store, policy);
}
