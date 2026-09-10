import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SignJWT } from "jose";
import { createEnterpriseServer } from "../../../enterprise/server.mjs";
import { ACCOUNT_MODEL, NEWSLETTER_CONSENT, accountConfigFromEnv, newsletterRecipients } from "../../../enterprise/accounts.mjs";
import { verifyLicenceCertificate } from "../../../src/licensing/certificate.ts";

const googleKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherGoogleKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const googleJwk = { ...googleKeys.publicKey.export({ format: "jwk" }), kid: "synthetic-google", alg: "RS256", use: "sig" };

test("account config is explicit and signing files must remain private regular files", () => {
  assert.equal(accountConfigFromEnv({}), undefined);
  const dir = mkdtempSync(join(tmpdir(), "bothearth-signing-config-test-"));
  try {
    const key = join(dir, "issuer.pem"); const linked = join(dir, "linked.pem"); const configPath = join(dir, "account.json");
    writeFileSync(key, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    writeFileSync(join(dir, "terms.txt"), "Synthetic terms file for testing external configuration only.");
    writeFileSync(configPath, JSON.stringify({ model: ACCOUNT_MODEL, coveredRelease: "synthetic-release-1", keyId: "test-key",
      terms: Object.fromEntries(["account", "noncommercial", "privacy"].map((kind) => [kind, { id: `test-${kind}`, file: "terms.txt" }])) }));
    const env = { ENTERPRISE_ACCOUNT_CONFIG: configPath, ENTERPRISE_LICENCE_KEY_FILE: key,
      ENTERPRISE_ACCOUNT_DATA_KEY: randomBytes(32).toString("base64"), GOOGLE_CLIENT_ID: "synthetic-client", GOOGLE_CLIENT_SECRET: "synthetic-secret" };
    assert.match(accountConfigFromEnv(env).terms.noncommercial.text, /Synthetic terms file/);
    chmodSync(key, 0o644); assert.throws(() => accountConfigFromEnv(env), /private, owned regular file/);
    chmodSync(key, 0o600); symlinkSync(key, linked);
    assert.throws(() => accountConfigFromEnv({ ...env, ENTERPRISE_LICENCE_KEY_FILE: linked }), /ELOOP|too many|symbolic/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bothearth-account-test-"));
  const signer = generateKeyPairSync("ed25519");
  let timestamp = Date.now(); let failMail = false; let failGoogle = false;
  const mails: any[] = []; const requests: string[] = []; const codes = new Map<string, any>();
  const fetcher = async (input: any, init: any) => {
    const url = String(input); requests.push(url);
    if (failGoogle) throw new Error("Synthetic provider outage");
    if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [googleJwk] });
    assert.equal(url, "https://oauth2.googleapis.com/token", "tests never contact a real provider");
    const body = new URLSearchParams(init.body);
    assert.equal(body.get("client_id"), "synthetic-client.apps.googleusercontent.com");
    assert.equal(body.get("client_secret"), "synthetic-client-secret");
    assert.equal(body.get("redirect_uri"), "http://127.0.0.1/account/auth/google/callback");
    assert.equal(body.get("grant_type"), "authorization_code");
    const attempt = codes.get(body.get("code")!); assert(attempt, "authorization code issued only by synthetic provider"); codes.delete(body.get("code")!);
    assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), attempt.challenge);
    const iat = Math.floor(timestamp / 1000);
    const claims = { iss: "https://accounts.google.com", aud: "synthetic-client.apps.googleusercontent.com", sub: attempt.subject,
      email: attempt.email, email_verified: true, nonce: attempt.nonce, iat, exp: iat + 3600,
      name: "UNNEEDED_GOOGLE_NAME", picture: "https://unused.invalid/avatar.png", ...attempt.claims };
    const token = await new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "synthetic-google" }).sign(attempt.wrongSigner ? otherGoogleKeys.privateKey : googleKeys.privateKey);
    return Response.json({ id_token: token, access_token: "DO_NOT_STORE_ACCESS_TOKEN", refresh_token: "DO_NOT_STORE_REFRESH_TOKEN" });
  };
  const accounts = { model: ACCOUNT_MODEL, coveredRelease: "synthetic-release-1", keyId: "synthetic-issuer-1",
    privateKey: signer.privateKey.export({ type: "pkcs8", format: "pem" }), dataKey: randomBytes(32).toString("base64"),
    google: { clientId: "synthetic-client.apps.googleusercontent.com", clientSecret: "synthetic-client-secret", fetcher },
    terms: {
      account: { id: "synthetic-account-1", text: "Synthetic account terms for isolated automated testing only. No real account is created." },
      noncommercial: { id: "synthetic-noncommercial-1", text: "Synthetic noncommercial terms for isolated automated testing only. No real legal permission is issued." },
      privacy: { id: "synthetic-privacy-1", text: "Synthetic privacy notice for isolated automated testing only. Test addresses and profiles are fictional." },
    },
  };
  const options: any = { database: join(dir, "accounts.sqlite"), origin: "http://127.0.0.1", secret: "synthetic-stable-service-secret-with-more-than-32-characters",
    from: "BotHearth <sender@example.test>", contact: "private@example.test", accounts, now: () => timestamp,
    sendMail: async (payload: any, key: string) => { mails.push({ payload, key }); if (failMail) throw new Error("Synthetic mail failure"); } };
  let server: any; let base = "";
  const start = async () => { server = createEnterpriseServer(options); server.listen(0, "127.0.0.1"); await once(server, "listening"); base = `http://127.0.0.1:${server.address().port}`; };
  const stop = async () => { if (server?.listening) { server.close(); await once(server, "close"); } };
  const client = () => {
    let csrf = ""; const cookies = new Map<string, string>();
    return async (path = "/account", data?: Record<string, string>, extras: Record<string, string> = {}) => {
      const response = await fetch(`${base}${path}`, { method: data ? "POST" : "GET", redirect: "manual",
        headers: { cookie: [...cookies.values()].join("; "), ...(data ? { origin: options.origin, "content-type": "application/x-www-form-urlencoded" } : {}), ...extras },
        body: data ? new URLSearchParams({ csrf, ...data }) : undefined });
      for (const value of response.headers.getSetCookie()) cookies.set(value.split("=")[0]!, value.split(";")[0]!);
      const text = await response.text(); csrf = text.match(/name="csrf" value="([^"]+)"/)?.[1] || csrf;
      return { status: response.status, text, headers: response.headers, json: () => JSON.parse(text) };
    };
  };
  const begin = async (browser: ReturnType<typeof client>) => {
    await browser(); const response = await browser("/account/auth/google/start", {}); assert.equal(response.status, 303);
    const url = new URL(response.headers.get("location")!);
    assert.equal(url.origin, "https://accounts.google.com"); assert.equal(url.searchParams.get("scope"), "openid email");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256"); assert.equal(url.searchParams.has("access_type"), false);
    return url;
  };
  const finish = async (browser: ReturnType<typeof client>, url: URL, subject = "google-subject-1", email = "first@example.test", extra: any = {}) => {
    const code = randomBytes(12).toString("hex");
    codes.set(code, { nonce: url.searchParams.get("nonce"), challenge: url.searchParams.get("code_challenge"), subject, email, ...extra });
    const path = `/account/auth/google/callback?state=${url.searchParams.get("state")}&code=${code}&iss=https%3A%2F%2Faccounts.google.com`;
    return { response: await browser(path), path };
  };
  const login = async (browser: ReturnType<typeof client>, subject?: string, email?: string) => {
    const result = await finish(browser, await begin(browser), subject, email); assert.equal(result.response.status, 303);
    await browser(); return result;
  };
  const create = async (browser: ReturnType<typeof client>) => {
    const response = await browser("/account/create", { account_terms: accounts.terms.account.id, licence_terms: accounts.terms.noncommercial.id });
    assert.equal(response.status, 303, response.text); await browser();
    return (await browser("/account/me")).json().licences.find((licence: any) => licence.covered_release === accounts.coveredRelease);
  };
  await start();
  return { options, accounts, signer, mails, requests, client, begin, finish, login, create,
    db: () => new DatabaseSync(options.database), advance: (ms: number) => { timestamp += ms; },
    setMailFailure: (value: boolean) => { failMail = value; }, setGoogleFailure: (value: boolean) => { failGoogle = value; },
    restart: async () => { await stop(); await start(); }, stop,
    close: async () => { await stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("Google signup creates one encrypted, revealable portable licence and preserves it across restarts", async () => {
  const f = await fixture();
  try {
    const a = f.client(); const landing = await a();
    assert.match(landing.text, /Continue with Google/); assert.match(landing.text, /Existing grants still apply/);
    assert.doesNotMatch(landing.text, /private@example.test/);
    assert.equal((await a("/account/auth/google/start", {}, { origin: "https://attacker.invalid" })).status, 403);
    const { path } = await f.login(a); assert.equal((await a(path)).status, 400, "callback is single-use");
    assert.equal((await a("/account/create", {})).status, 400, "explicit version acceptance is required");
    const licence = await f.create(a); const second = await f.create(a); assert.equal(second.id, licence.id);
    const home = await a(); assert.match(home.text, /Non-commercial/); assert.doesNotMatch(home.text, /name="subscribe"[^>]*checked/);
    assert.equal(f.mails.length, 0, "signup is not marketing permission");
    const revealed = await a(`/account/licences/${licence.id}/reveal`, {}, { accept: "application/json" });
    assert.equal(revealed.status, 200); assert.equal(revealed.headers.get("cache-control"), "no-store");
    const key = revealed.json().key;
    const verified = verifyLicenceCertificate(key, { publicKeys: { "synthetic-issuer-1": f.signer.publicKey }, coveredRelease: f.accounts.coveredRelease });
    assert.equal(verified.tier, "noncommercial"); assert.equal(verified.concurrent_daemons, undefined);
    assert.doesNotMatch(Buffer.from(key.split(".")[1], "base64url").toString(), /example.test|google-subject/);
    assert(!home.text.includes(key)); assert.equal((await a(`/account/licences/${licence.id}/download`)).text.trim(), key);
    const exported = (await a("/account/export")).json(); assert.equal(exported.licences[0].key, key); assert.equal(exported.terms[0].text, f.accounts.terms.noncommercial.text);
    assert.match((await a(`/account/licences/${licence.id}/reveal`, {})).text, /Copy key/);
    const db = f.db();
    try {
      const stored = db.prepare("SELECT token,claims FROM licensing_certificates").get()!;
      assert.notEqual(stored.token, key); assert.doesNotMatch(String(stored.token), /first@example|google-subject/);
      assert.equal(db.prepare("SELECT count(*) AS n FROM licensing_accounts").get()!.n, 1);
      assert.equal(db.prepare("SELECT count(*) AS n FROM licensing_certificates").get()!.n, 1);
      assert.equal(db.prepare("SELECT count(*) AS n FROM licensing_acceptances").get()!.n, 2);
      const session = JSON.stringify(db.prepare("SELECT * FROM licensing_sessions").all());
      assert.doesNotMatch(session, /UNNEEDED_GOOGLE_NAME|avatar.png|DO_NOT_STORE/);
    } finally { db.close(); }
    await f.restart(); assert.equal((await a(`/account/licences/${licence.id}/download`)).text.trim(), key);
    f.advance(16 * 60000);
    const stale = await a(`/account/licences/${licence.id}/reveal`, {}); assert.equal(stale.status, 401); assert.match(stale.text, /Sign in again with Google/);
    assert.equal((await a("/account/me")).status, 200, "ordinary account summary lasts 24 hours");
    await f.login(a); assert.equal((await a(`/account/licences/${licence.id}/download`)).text.trim(), key);
    assert.equal((await a("/account/sign-out", {})).status, 303);
    assert.equal((await a(`/account/licences/${licence.id}/download`)).status, 401);
    f.setGoogleFailure(true);
    assert.deepEqual(verifyLicenceCertificate(key, { publicKeys: { "synthetic-issuer-1": f.signer.publicKey }, coveredRelease: f.accounts.coveredRelease }), verified, "provider outage does not invalidate exported keys");
  } finally { await f.close(); }
});

test("Google subjects remain separate when emails match or change; foreign accounts cannot reveal keys", async () => {
  const f = await fixture();
  try {
    const a = f.client(); const b = f.client();
    await f.login(a); const first = await f.create(a);
    await f.login(b, "google-subject-2", "first@example.test"); const second = await f.create(b); assert.notEqual(first.id, second.id);
    assert.equal((await b(`/account/licences/${first.id}/reveal`, {})).status, 404);
    assert.equal((await b(`/account/licences/${first.id}/download`)).status, 404);
    await f.login(a, "google-subject-1", "changed@example.test");
    const me = (await a("/account/me")).json(); assert.equal(me.email, "changed@example.test"); assert.equal(me.licences[0].id, first.id);
    const db = f.db(); try { assert.equal(db.prepare("SELECT count(*) AS n FROM licensing_accounts").get()!.n, 2); } finally { db.close(); }
  } finally { await f.close(); }
});

test("state, nonce, signature, audience, issuer, verification and token expiry are enforced", async () => {
  const f = await fixture();
  try {
    const a = f.client(); const b = f.client(); const url = await f.begin(a); await b();
    assert.equal((await f.finish(b, url)).response.status, 400, "another browser cannot use the state");
    assert.equal((await f.finish(a, url)).response.status, 303);
    const bad = [ { claims: { nonce: "wrong" } }, { claims: { aud: "attacker-client" } }, { claims: { iss: "https://attacker.invalid" } },
      { claims: { email_verified: false } }, { claims: { exp: 1 } }, { wrongSigner: true }, { claims: { azp: "attacker-client" } } ];
    for (const value of bad) {
      const browser = f.client(); assert.equal((await f.finish(browser, await f.begin(browser), undefined, undefined, value)).response.status, 401);
      assert.equal((await browser("/account/me")).status, 401);
    }
    const expired = f.client(); const pending = await f.begin(expired); f.advance(600001);
    assert.equal((await f.finish(expired, pending)).response.status, 400);
    const db = f.db(); try { assert.equal(db.prepare("SELECT count(*) AS n FROM licensing_accounts").get()!.n, 0); } finally { db.close(); }
  } finally { await f.close(); }
});

test("newsletter is separate, confirmed explicitly, and suppressed without login even after restart", async () => {
  const f = await fixture();
  try {
    const a = f.client(); await f.login(a); const licence = await f.create(a);
    await a("/account/newsletter/subscribe", { email: "first@example.test" }); assert.equal(f.mails.length, 0);
    assert.equal((await a("/account/newsletter/subscribe", { subscribe: "yes", email: "newsletter@example.test" })).status, 303);
    const mail = f.mails.at(-1).payload; assert.deepEqual(mail.to, ["newsletter@example.test"]);
    const confirm = new URL(mail.text.match(/http[^\s]+\/confirm\?token=[^\s]+/)[0]);
    const unsubscribe = new URL(mail.text.match(/http[^\s]+\/unsubscribe\?token=[^\s]+/)[0]);
    const anonymous = f.client();
    assert.equal((await anonymous(confirm.pathname + confirm.search)).status, 200);
    const db = f.db();
    try {
      assert.equal(newsletterRecipients(db).length, 0, "email-scanner GET does not opt in");
      assert.equal((await anonymous(confirm.pathname, { token: confirm.searchParams.get("token")! }, { origin: "" })).status, 200);
      assert.deepEqual(newsletterRecipients(db).map((row: any) => row.email), ["newsletter@example.test"]);
      assert.equal((await anonymous(confirm.pathname, { token: confirm.searchParams.get("token")! })).status, 400, "confirmation is single-use");
      const events = db.prepare("SELECT * FROM licensing_consent_events ORDER BY id").all();
      assert.equal(events.length, 2); assert.equal(events[0]!.text, NEWSLETTER_CONSENT.text); assert.equal(events[0]!.version, NEWSLETTER_CONSENT.id); assert(events[0]!.created);
      await anonymous(unsubscribe.pathname + unsubscribe.search); assert.equal(newsletterRecipients(db).length, 1, "GET cannot unsubscribe");
      const withoutCookie = f.client();
      assert.equal((await withoutCookie(unsubscribe.pathname + unsubscribe.search, { "List-Unsubscribe": "One-Click" }, { origin: "" })).status, 200);
      assert.equal(newsletterRecipients(db).length, 0, "withdrawal suppresses send-time recipients immediately");
    } finally { db.close(); }
    await f.restart();
    await f.login(a, "google-subject-1", "changed@example.test");
    const home = (await a()).text; assert.match(home, /newsletter@example.test: Unsubscribed/);
    assert.doesNotMatch(home, /name="subscribe"[^>]*checked/);
    assert.equal((await a("/account/me")).json().licences[0].id, licence.id);
    const restored = f.db(); try { assert.equal(newsletterRecipients(restored).length, 0); } finally { restored.close(); }
    f.advance(60001); f.setMailFailure(true);
    assert.equal((await a("/account/newsletter/subscribe", { subscribe: "yes", email: "changed@example.test" })).status, 503);
    assert.equal((await a("/account/me")).json().licences[0].id, licence.id, "mail failure does not affect licensing");
  } finally { await f.close(); }
});

test("commercial quantities and proposed prices are honest while payment remains disabled", async () => {
  const f = await fixture();
  try {
    const a = f.client(); await f.login(a); await f.create(a);
    const status = (await a("/account/status")).json(); assert.equal(status.commercial.checkout_available, false);
    assert.equal(status.commercial.unit_amount, 6000); assert.equal(status.commercial.planned_unit_amount, 19900);
    const commercial = await a("/account/commercial?quantity=50"); assert.match(commercial.text, /US\$3000/); assert.match(commercial.text, /disabled>Checkout unavailable/); assert.doesNotMatch(commercial.text, /<del>|save 70%/i);
    for (const quantity of ["0", "51", "1.5", "1e1", "99999"]) assert.equal((await a("/account/orders", { quantity })).status, 400);
    assert.equal((await a("/account/orders", { quantity: "2", payment_status: "paid" })).status, 503);
    assert.equal((await a("/account/me")).json().licences.length, 1, "client-reported payment creates no entitlement");
  } finally { await f.close(); }
});

test("versioned configuration preserves old certificates and rejects silent key or terms replacement", async () => {
  const f = await fixture();
  try {
    const a = f.client(); await f.login(a); const licence = await f.create(a);
    const original = (await a(`/account/licences/${licence.id}/download`)).text;
    await f.stop();
    assert.throws(() => createEnterpriseServer({ ...f.options, accounts: { ...f.accounts, coveredRelease: "" } }), /exact coveredRelease/);
    assert.throws(() => createEnterpriseServer({ ...f.options, accounts: { ...f.accounts, coveredRelease: "EXACT_OWNER_SELECTED_RELEASE_OR_COMMIT" } }), /exact coveredRelease/);
    assert.throws(() => createEnterpriseServer({ ...f.options, accounts: { ...f.accounts, dataKey: randomBytes(32).toString("base64") } }), /cannot decrypt existing/);
    assert.throws(() => createEnterpriseServer({ ...f.options, accounts: { ...f.accounts, privateKey: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) } }), /new keyId/);
    assert.throws(() => createEnterpriseServer({ ...f.options, accounts: { ...f.accounts, terms: { ...f.accounts.terms, account: { ...f.accounts.terms.account, text: `${f.accounts.terms.account.text} Changed.` } } } }), /immutable/);
    f.accounts.coveredRelease = "synthetic-release-2"; f.accounts.keyId = "synthetic-issuer-2";
    f.accounts.privateKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
    await f.restart();
    assert.equal((await a(`/account/licences/${licence.id}/download`)).text, original, "rotation and new release preserve exact historic certificate");
    const next = await f.create(a); assert.notEqual(next.id, licence.id);
    assert.equal((await a("/account/me")).json().licences.length, 2);
    await f.stop(); f.options.accounts = undefined; await f.restart();
    assert.deepEqual((await a("/account/status")).json(), { enabled: false, checkout_available: false });
    assert.equal((await a()).status, 404); assert.match((await a("/")).text, /One free perpetual business bot/);
  } finally { await f.close(); }
});

test("recovery requires a fresh Google identity and one-use code; closure preserves offline grants", async () => {
  const f = await fixture();
  try {
    const original = f.client();
    await f.login(original); const licence = await f.create(original);
    const exported = (await original(`/account/licences/${licence.id}/download`)).text;
    const issueCode = async () => {
      const page = await original('/account/recovery-code', {});
      assert.equal(page.status, 200);
      return page.text.match(/id="licence-key"[^>]*>([A-Za-z0-9_-]{43})</)![1]!;
    };
    const obsolete = await issueCode(), code = await issueCode();
    const other = f.client();
    assert.equal((await other('/account/recover', { recovery_code: code })).status, 403);
    await f.login(other, 'replacement-subject', 'new@example.test');
    assert.equal((await other('/account/recover', { recovery_code: obsolete })).status, 400);
    const db = f.db();
    try {
      assert.notEqual((db.prepare('SELECT code_hash FROM licensing_recovery').get() as any).code_hash, code);
    } finally { db.close(); }
    await f.restart();
    assert.equal((await other('/account/recover', { recovery_code: code })).status, 303);
    await other();
    assert.equal((await original('/account/me')).status, 401, 'old sessions are revoked');
    assert.equal((await other(`/account/licences/${licence.id}/download`)).text, exported);
    const third = f.client(); await f.login(third, 'third-subject', 'third@example.test');
    assert.equal((await third('/account/recover', { recovery_code: code })).status, 400, 'code is single use');
    assert.equal((await other('/account/close', {})).status, 400, 'closure requires explicit confirmation');
    f.advance(16 * 60000);
    assert.equal((await other('/account/close', { confirm: 'close' })).status, 401, 'closure requires fresh sign-in');
    await f.login(other, 'replacement-subject', 'new@example.test');
    const closed = await other('/account/close', { confirm: 'close' });
    assert.equal(closed.status, 200); assert.match(closed.text, /Account closed/);
    assert.equal((await other('/account/me')).status, 401);
    const records = f.db();
    try {
      const retained = records.prepare('SELECT * FROM licensing_accounts').get() as any;
      assert.equal(retained.email, ''); assert.match(retained.google_sub, /^closed:/);
      assert.equal(records.prepare('SELECT * FROM licensing_recovery').all().length, 0);
      assert.equal(records.prepare('SELECT * FROM licensing_certificates').all().length, 1);
    } finally { records.close(); }
    assert.equal(verifyLicenceCertificate(exported.trim(), { publicKeys: { [f.accounts.keyId]: f.signer.publicKey }, coveredRelease: f.accounts.coveredRelease }).tier, 'noncommercial');
  } finally { await f.close(); }
});
