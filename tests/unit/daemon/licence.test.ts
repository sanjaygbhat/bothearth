import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startDaemon } from "../../../src/daemon/server.ts";
import { licenceState, readLicencePolicy, type LicencePolicy } from "../../../src/daemon/licence.ts";
import { Store } from "../../../src/daemon/store.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const policy: LicencePolicy = { coveredRelease: "test-release", required: true,
  publicKeys: { test: publicKey.export({ type: "spki", format: "pem" }).toString() },
  accountUrl: "https://accounts.example.com/account" };
function certificate(tier: "noncommercial" | "commercial", release = policy.coveredRelease) {
  const header = Buffer.from(JSON.stringify({ alg: "Ed25519", typ: "bothearth-license+jws", kid: "test" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ schema: 1, issuer: "bothearth", product: "bothearth-daemon",
    licence_id: `test-${tier}`, holder_ref: "opaque-profile-id", tier, covered_release: release,
    issued_at: new Date().toISOString(), terms_id: "test-terms", terms_sha256: "a".repeat(64),
    ...(tier === "commercial" ? { concurrent_daemons: 1 } : {}) })).toString("base64url");
  return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString("base64url")}`;
}

test("activation is authenticated, offline, durable and preserves a working key after invalid input", async () => {
  const root = mkdtempSync(join(tmpdir(), "bothearth-licence-"));
  const dbPath = join(root, "daemon.sqlite");
  const daemon = await startDaemon({ host: "127.0.0.1", port: 0, mcpToken: "test-mcp", bootstrapToken: "test-boot",
    workspaceRoot: root, sqlitePath: dbPath, licencePolicy: policy });
  try {
    const url = `${daemon.baseUrl}/api/v1/licence`;
    assert.equal((await fetch(url)).status, 401);
    const { headers, cookie } = await bootstrapSession(daemon, "test-boot");
    const post = (body: string) => fetch(`${url}/activate`, { method: "POST", headers, body });
    assert.equal((await fetch(`${url}/activate`, { method: "POST", headers: { origin: daemon.baseUrl, cookie }, body: "{}" })).status, 403);
    assert.equal((await (await fetch(url, { headers })).json()).status, "unlicensed");
    const blocked = await fetch(`${daemon.baseUrl}/api/v1/tasks`, { method: "POST", headers, body: "{}" });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error, "E_LICENCE_REQUIRED");

    const free = certificate("noncommercial");
    const activated = await post(JSON.stringify({ certificate: free }));
    assert.equal(activated.status, 200);
    assert.equal(activated.headers.get("cache-control"), "no-store");
    const text = await activated.text();
    assert.equal(JSON.parse(text).label, "Non-commercial");
    assert.ok(!text.includes(free));
    assert.ok(!text.includes("opaque-profile-id"));
    for (const value of ["broken", free.slice(0, -10), certificate("commercial", "other-release")]) {
      assert.equal((await post(JSON.stringify({ certificate: value }))).status, 400);
      assert.equal((await (await fetch(url, { headers })).json()).tier, "noncommercial");
    }
    const malformed = await post("not-json-private-input");
    assert.equal(malformed.status, 400);
    assert.ok(!(await malformed.text()).includes("not-json-private-input"));
    assert.equal((await post(JSON.stringify({ certificate: certificate("commercial") }))).status, 200);
    const state = await (await fetch(url, { headers })).json();
    assert.equal(state.label, "Commercial");
    // An activated installation reaches ordinary request validation, without an account request.
    assert.equal((await fetch(`${daemon.baseUrl}/api/v1/tasks`, { method: "POST", headers, body: "{}" })).status, 400);
    const audit = daemon.store.db.prepare("SELECT body_json FROM audit_refs").all();
    assert.ok(!JSON.stringify(audit).includes(free));
  } finally { await daemon.close(); }
  const reopened = new Store(dbPath);
  try { assert.equal(licenceState(reopened, policy).tier, "commercial"); }
  finally { reopened.close(); }
});

test("licensing is explicit per release and refuses private keys or unsafe account URLs", () => {
  const store = new Store();
  try { assert.deepEqual(licenceState(store), { status: "legacy", required: false, label: "Existing release terms" }); }
  finally { store.close(); }
  assert.equal(readLicencePolicy(), undefined);
  const path = join(mkdtempSync(join(tmpdir(), "bothearth-licence-policy-")), "policy.json");
  writeFileSync(path, JSON.stringify(policy));
  assert.deepEqual(readLicencePolicy(path), policy);
  for (const change of [
    { accountUrl: "http://example.com/account" },
    { accountUrl: "https://example.com/account?key=private" },
    { accountUrl: "https://user:password@example.com/account" },
    { publicKeys: { test: privateKey.export({ type: "pkcs8", format: "pem" }).toString() } },
    { publicKeys: {} }, { required: "yes" },
  ]) {
    writeFileSync(path, JSON.stringify({ ...policy, ...change }));
    assert.throws(() => readLicencePolicy(path));
  }
});
