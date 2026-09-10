import { createPublicKey, KeyObject, verify } from "node:crypto";

export interface LicenceClaims {
  schema: 1;
  issuer: "bothearth";
  product: "bothearth-daemon";
  licence_id: string;
  holder_ref: string;
  tier: "noncommercial" | "commercial";
  covered_release: string;
  issued_at: string;
  terms_id: string;
  terms_sha256: string;
  concurrent_daemons?: 1;
}

const invalid = (): never => { throw new Error("We could not verify this licence key."); };
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,159}$/.test(value);
const decode = (value: string): unknown => {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) invalid();
  try { return JSON.parse(bytes.toString("utf8")); } catch { return invalid(); }
};

/** Offline authenticity and exact-release coverage only; never an account or operator credential. */
export function verifyLicenceCertificate(token: string, options: {
  publicKeys: Readonly<Record<string, string | KeyObject>>;
  coveredRelease: string;
}): LicenceClaims {
  if (typeof token !== "string" || token.length > 8192) invalid();
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) invalid();
  const header = decode(parts[0]!) as Record<string, unknown>;
  if (!header || typeof header !== "object" || Array.isArray(header)
    || Object.keys(header).sort().join(",") !== "alg,kid,typ"
    || header.alg !== "Ed25519" || header.typ !== "bothearth-license+jws" || !identifier(header.kid)
    || !Object.hasOwn(options.publicKeys, header.kid)) invalid();
  try {
    const configured = options.publicKeys[header.kid as string]!;
    const key = configured instanceof KeyObject ? configured : createPublicKey(configured);
    const signature = Buffer.from(parts[2]!, "base64url");
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519" || signature.length !== 64
      || signature.toString("base64url") !== parts[2]
      || !verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, signature)) invalid();
  } catch { invalid(); }
  const claims = decode(parts[1]!) as Record<string, unknown>;
  const fields = ["schema", "issuer", "product", "licence_id", "holder_ref", "tier", "covered_release", "issued_at", "terms_id", "terms_sha256"];
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) invalid();
  if (claims.tier === "commercial") fields.push("concurrent_daemons");
  if (Object.keys(claims).sort().join(",") !== fields.sort().join(",") || claims.schema !== 1
    || claims.issuer !== "bothearth" || claims.product !== "bothearth-daemon"
    || !identifier(claims.licence_id) || !identifier(claims.holder_ref) || !identifier(claims.covered_release)
    || !identifier(claims.terms_id) || !["noncommercial", "commercial"].includes(String(claims.tier))
    || (claims.tier === "commercial" && claims.concurrent_daemons !== 1)
    || typeof claims.terms_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(claims.terms_sha256)
    || typeof claims.issued_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(claims.issued_at)
    || !Number.isFinite(Date.parse(claims.issued_at))) invalid();
  if (claims.covered_release !== options.coveredRelease) {
    throw new Error(`This key covers ${claims.covered_release}, not ${options.coveredRelease}.`);
  }
  return claims as unknown as LicenceClaims;
}
