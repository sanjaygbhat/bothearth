import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createGoogleLogin } from "./google.mjs";
import { verifyLicenceCertificate } from "../src/licensing/certificate.ts";

export const ACCOUNT_MODEL = "google-offline-v1";
export const NEWSLETTER_CONSENT = {
  id: "newsletter-2026-09-09.1",
  text: "Email me BotHearth releases, practical tips and occasional offers. Optional; unsubscribe anytime.",
};
export const COMMERCIAL_OFFER = Object.freeze({
  currency: "USD", unit_amount: 6000, planned_unit_amount: 19900, min_quantity: 1, max_quantity: 50,
  checkout_available: false, reason: "Payment collection is not open yet.", contact_url: "https://bothearth.com/contact/",
});
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,159}$/.test(value);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const emailAddress = (value) => {
  if (typeof value !== "string" || value.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)) fail(400, "Enter a valid newsletter email address.");
  return value.toLowerCase();
};

/** No defaults identify a newly licensed release or adopt new legal terms. */
export function accountConfigFromEnv(env) {
  if (!env.ENTERPRISE_ACCOUNT_CONFIG) return undefined;
  const filename = resolve(env.ENTERPRISE_ACCOUNT_CONFIG);
  const config = JSON.parse(readFileSync(filename, "utf8"));
  const fd = openSync(env.ENTERPRISE_LICENCE_KEY_FILE || "", constants.O_RDONLY | constants.O_NOFOLLOW);
  let privateKey;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && ![0, process.getuid()].includes(info.uid))) throw new Error("The licence signing key must be a private, owned regular file (0600).");
    privateKey = readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
  const terms = {};
  for (const kind of ["account", "noncommercial", "privacy"]) {
    terms[kind] = { id: config.terms?.[kind]?.id, text: readFileSync(resolve(dirname(filename), config.terms?.[kind]?.file || ""), "utf8") };
  }
  return { ...config, terms, privateKey, dataKey: env.ENTERPRISE_ACCOUNT_DATA_KEY,
    google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } };
}

export function newsletterRecipients(db) {
  // Check immediately before every marketing send, including a retry; this service sends no campaigns.
  return db.prepare(`SELECT s.email FROM licensing_subscriptions s
    WHERE s.status='confirmed' AND NOT EXISTS (SELECT 1 FROM licensing_suppressions x WHERE x.email=s.email) GROUP BY s.email`).all();
}

export function cleanupAccountChallenges(db, timestamp) {
  for (const table of ["licensing_sessions", "licensing_auth"]) db.prepare(`DELETE FROM ${table} WHERE expires<=?`).run(timestamp);
  db.prepare("UPDATE licensing_subscriptions SET confirm_hash=NULL, confirm_expires=NULL WHERE confirm_expires<=?").run(timestamp);
}

export function createAccounts({ db, config, origin, hash, now, limit, from, sendMail }) {
  if (!config) return async ({ req, res, path }) => {
    if (req.method === "GET" && path === "/account/status") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ enabled: false, checkout_available: false })); return;
    }
    fail(404, "Account signup for the new licensing model is not open yet.");
  };
  if (config.model !== ACCOUNT_MODEL || !identifier(config.coveredRelease) || /^(EXACT_|OWNER_|APPROVED_|REPLACE_|CHOOSE_|TODO)/i.test(config.coveredRelease) || !identifier(config.keyId)) throw new Error("Configure google-offline-v1, an exact coveredRelease, and a signing keyId.");
  const privateKey = createPrivateKey(config.privateKey);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Use an Ed25519 licence signing key.");
  const publicKey = createPublicKey(privateKey);
  const dataKey = Buffer.from(config.dataKey || "", "base64");
  if (dataKey.length !== 32 || dataKey.toString("base64") !== config.dataKey) throw new Error("Configure ENTERPRISE_ACCOUNT_DATA_KEY as a stable base64-encoded 32-byte encryption key.");
  const seal = (text, context) => {
    const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((value) => value.toString("base64url")).join(".");
  };
  const unseal = (text, context) => {
    const [iv, tag, encrypted] = text.split(".").map((part) => Buffer.from(part, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", dataKey, iv);
    decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  };
  const google = createGoogleLogin({ ...config.google, origin, now });
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS licensing_terms (id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, sha256 TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS licensing_signers (kid TEXT PRIMARY KEY, public_key TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS licensing_accounts (id TEXT PRIMARY KEY, google_sub TEXT UNIQUE NOT NULL, email TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS licensing_recovery (account_id TEXT PRIMARY KEY REFERENCES licensing_accounts(id), code_hash TEXT UNIQUE NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS licensing_acceptances (account_id TEXT NOT NULL REFERENCES licensing_accounts(id), terms_id TEXT NOT NULL REFERENCES licensing_terms(id), accepted INTEGER NOT NULL, PRIMARY KEY(account_id, terms_id));
    CREATE TABLE IF NOT EXISTS licensing_sessions (id TEXT PRIMARY KEY, subject TEXT NOT NULL, email TEXT NOT NULL, authenticated INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS licensing_auth (id TEXT PRIMARY KEY, state TEXT NOT NULL, nonce TEXT NOT NULL, verifier TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS licensing_certificates (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES licensing_accounts(id), tier TEXT NOT NULL CHECK(tier='noncommercial'), covered_release TEXT NOT NULL, terms_id TEXT NOT NULL REFERENCES licensing_terms(id), kid TEXT NOT NULL, claims TEXT NOT NULL, token TEXT NOT NULL, issued INTEGER NOT NULL, UNIQUE(account_id, tier, covered_release, terms_id));
    CREATE TABLE IF NOT EXISTS licensing_subscriptions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES licensing_accounts(id), email TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','confirmed','unsubscribed')), confirm_hash TEXT, confirm_expires INTEGER, unsubscribe_hash TEXT UNIQUE NOT NULL, unsubscribe_token TEXT NOT NULL, updated INTEGER NOT NULL, UNIQUE(account_id, email));
    CREATE TABLE IF NOT EXISTS licensing_consent_events (id INTEGER PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES licensing_subscriptions(id), email TEXT NOT NULL, action TEXT NOT NULL, version TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS licensing_suppressions (email TEXT PRIMARY KEY, withdrawn INTEGER NOT NULL);`);
  const publicPem = publicKey.export({ type: "spki", format: "pem" });
  const knownSigner = db.prepare("SELECT public_key FROM licensing_signers WHERE kid=?").get(config.keyId);
  if (knownSigner && knownSigner.public_key !== publicPem) throw new Error("Use a new keyId when rotating the licence signer; preserve old public keys.");
  db.prepare("INSERT OR IGNORE INTO licensing_signers VALUES (?,?)").run(config.keyId, publicPem);
  const saved = db.prepare("SELECT id,token FROM licensing_certificates LIMIT 1").get();
  if (saved) { try { unseal(saved.token, saved.id); } catch { throw new Error("The account data key cannot decrypt existing certificates. Restore the original key."); } }
  for (const kind of ["account", "noncommercial", "privacy"]) {
    const value = config.terms?.[kind];
    if (!value || !identifier(value.id) || typeof value.text !== "string" || value.text.trim().length < 40 || value.text.length > 200000) throw new Error(`Configure the approved ${kind} terms ID and complete text.`);
    const previous = db.prepare("SELECT * FROM licensing_terms WHERE id=?").get(value.id);
    if (previous && (previous.kind !== kind || previous.text !== value.text)) throw new Error("Terms IDs are immutable. Use a new ID for changed text.");
    db.prepare("INSERT OR IGNORE INTO licensing_terms VALUES (?, ?, ?, ?)").run(value.id, kind, value.text, digest(value.text));
  }
  const transaction = (work) => {
    db.exec("BEGIN IMMEDIATE");
    try { const value = work(); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const event = (row, action, source, timestamp) => db.prepare("INSERT INTO licensing_consent_events (subscription_id,email,action,version,text,source,created) VALUES (?,?,?,?,?,?,?)")
    .run(row.id, row.email, action, NEWSLETTER_CONSENT.id, NEWSLETTER_CONSENT.text, source, timestamp);
  const withdraw = (row, timestamp) => transaction(() => {
    db.prepare("INSERT INTO licensing_suppressions VALUES (?,?) ON CONFLICT(email) DO UPDATE SET withdrawn=excluded.withdrawn").run(row.email, timestamp);
    db.prepare("UPDATE licensing_subscriptions SET status='unsubscribed', confirm_hash=NULL, confirm_expires=NULL, updated=? WHERE email=?").run(timestamp, row.email);
    event(row, "withdrawn", "newsletter/unsubscribe", timestamp);
  });
  const issue = (account, timestamp) => {
    const term = config.terms.noncommercial;
    let existing = db.prepare("SELECT * FROM licensing_certificates WHERE account_id=? AND tier='noncommercial' AND covered_release=? AND terms_id=?").get(account.id, config.coveredRelease, term.id);
    if (existing) return existing;
    const id = `BH-${randomUUID()}`;
    const claims = { schema: 1, issuer: "bothearth", product: "bothearth-daemon", licence_id: id, holder_ref: account.id,
      tier: "noncommercial", covered_release: config.coveredRelease, issued_at: new Date(timestamp).toISOString(), terms_id: term.id, terms_sha256: digest(term.text) };
    const encoded = [JSON.stringify({ alg: "Ed25519", typ: "bothearth-license+jws", kid: config.keyId }), JSON.stringify(claims)].map((part) => Buffer.from(part).toString("base64url")).join(".");
    const token = `${encoded}.${sign(null, Buffer.from(encoded), privateKey).toString("base64url")}`;
    verifyLicenceCertificate(token, { publicKeys: { [config.keyId]: publicKey }, coveredRelease: config.coveredRelease });
    db.prepare("INSERT INTO licensing_certificates VALUES (?,?,?,?,?,?,?,?,?)").run(id, account.id, "noncommercial", config.coveredRelease, term.id, config.keyId, JSON.stringify(claims), seal(token, id), timestamp);
    return db.prepare("SELECT * FROM licensing_certificates WHERE id=?").get(id);
  };
  const plainTerms = (kind) => `<pre class="account-terms">${escape(config.terms[kind].text)}</pre>`;
  const summary = (row) => ({ id: row.id, tier: row.tier, covered_release: row.covered_release, terms_id: row.terms_id, issued_at: new Date(row.issued).toISOString() });
  return async ({ req, res, path, query, id, body, timestamp, setCookie, form, page, redirect }) => {
    const json = (value) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
    cleanupAccountChallenges(db, timestamp);
    if (req.method === "GET" && path === "/account/status") {
      json({ enabled: true, model: ACCOUNT_MODEL, covered_release: config.coveredRelease, signup_url: `${origin}/account`, commercial: COMMERCIAL_OFFER }); return;
    }
    if (req.method === "GET" && path === "/account/key.js") { res.setHeader("content-type", "text/javascript"); res.end(readFileSync(new URL("./key.js", import.meta.url))); return; }
    if (req.method === "GET" && path === "/account/style.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync(new URL("./account.css", import.meta.url))); return; }
    if (req.method === "GET" && ["/account/terms", "/account/noncommercial", "/account/privacy"].includes(path)) {
      const kind = path.endsWith("/terms") ? "account" : path.endsWith("/privacy") ? "privacy" : "noncommercial";
      res.end(page(kind === "account" ? "Account terms" : kind === "privacy" ? "Account privacy" : "Noncommercial licence", plainTerms(kind))); return;
    }
    if (req.method === "POST" && path === "/account/auth/google/start") {
      limit(`google:${id}`, 10, 60000);
      const pending = google.start();
      db.prepare("INSERT OR REPLACE INTO licensing_auth VALUES (?,?,?,?,?)").run(hash(id), hash(pending.state), pending.nonce, seal(pending.verifier, `pkce:${hash(id)}`), timestamp + 600000);
      redirect(pending.destination); return;
    }
    if (req.method === "GET" && path === "/account/auth/google/callback") {
      const pending = db.prepare("SELECT * FROM licensing_auth WHERE id=? AND state=? AND expires>?").get(hash(id), hash(query.get("state") || ""), timestamp);
      if (!pending) fail(400, "Google sign-in expired. Start again from your account page.");
      db.prepare("DELETE FROM licensing_auth WHERE id=?").run(hash(id));
      if (query.has("error")) { redirect("/account"); return; }
      if (query.has("iss") && query.get("iss") !== "https://accounts.google.com") fail(400, "Google sign-in could not be verified.");
      let identity;
      try { identity = await google.finish(query.get("code"), { nonce: pending.nonce, verifier: unseal(pending.verifier, `pkce:${hash(id)}`) }); }
      catch { fail(401, "Google sign-in could not be verified. Please try again."); }
      const authenticated = now(); const next = `${authenticated}_${randomBytes(24).toString("hex")}`;
      transaction(() => {
        db.prepare("DELETE FROM licensing_sessions WHERE id=?").run(hash(id));
        db.prepare("INSERT INTO licensing_sessions VALUES (?,?,?,?,?)").run(hash(next), identity.subject, identity.email, authenticated, authenticated + 86400000);
        db.prepare("UPDATE licensing_accounts SET email=? WHERE google_sub=?").run(identity.email, identity.subject);
      });
      setCookie(next); redirect("/account"); return;
    }
    if (["/account/newsletter/confirm", "/account/newsletter/unsubscribe"].includes(path)) {
      const confirming = path.endsWith("/confirm");
      const token = body?.get("token") || query.get("token") || "";
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail(400, "This email link is invalid. Contact us if you need help.");
      const row = db.prepare(`SELECT * FROM licensing_subscriptions WHERE ${confirming ? "confirm_hash" : "unsubscribe_hash"}=?`).get(hash(token));
      if (!row || (confirming && (!row.confirm_expires || row.confirm_expires <= timestamp))) fail(400, "This email link expired or was already used.");
      if (req.method === "POST") {
        if (confirming) transaction(() => {
          db.prepare("UPDATE licensing_subscriptions SET status='confirmed', confirm_hash=NULL, confirm_expires=NULL, updated=? WHERE id=?").run(timestamp, row.id);
          db.prepare("DELETE FROM licensing_suppressions WHERE email=?").run(row.email);
          event(row, "confirmed", "newsletter/confirm", timestamp);
        }); else withdraw(row, timestamp);
        res.end(page(confirming ? "You’re subscribed" : "You are unsubscribed", `<p>${confirming ? "We’ll email you BotHearth releases, practical tips and occasional offers." : "Your account and licences are unchanged."}</p>`)); return;
      }
      // GET shows a form only, so email link scanners never change subscription state.
      res.end(page(confirming ? "Confirm your newsletter" : "Unsubscribe", `<p>${confirming ? "Confirm email updates for" : "Stop all BotHearth marketing email to"} ${escape(row.email)}.</p><form method="post" action="${path}"><input type="hidden" name="token" value="${escape(token)}"><button class="button" type="submit">${confirming ? "Confirm subscription" : "Unsubscribe"}</button></form>`)); return;
    }
    const session = db.prepare("SELECT * FROM licensing_sessions WHERE id=? AND expires>?").get(hash(id), timestamp);
    if (req.method === "POST" && path === "/account/sign-out") {
      db.prepare("DELETE FROM licensing_sessions WHERE id=?").run(hash(id)); db.prepare("DELETE FROM licensing_auth WHERE id=?").run(hash(id));
      setCookie(id, 0); redirect("/account"); return;
    }
    if (!session) {
      if (path !== "/account" || req.method !== "GET") fail(401, "Sign in to your BotHearth account first.");
      res.end(page("Get your free licence", `<p class="lead">Sign in with Google to get a noncommercial key for BotHearth ${escape(config.coveredRelease)}.</p>${form(id, "/account/auth/google/start", "", "Continue with Google")}<p>Signup uses your Google identity and email. It does not give us access to your Gmail, files or local BotHearth tasks.</p><p><a href="/account/privacy">Account privacy</a> · <a href="https://bothearth.com/quickstart/">Already have a key? Install BotHearth</a></p><details><summary>Using an earlier version, or cannot use Google?</summary><p>Existing grants still apply to their covered versions without a Google account or activation. <a href="https://bothearth.com/contact/">Contact us for help</a> · <a href="https://github.com/sanjaygbhat/bothearth">Source and licence terms</a></p></details>`)); return;
    }
    const fresh = () => { if (timestamp - session.authenticated > 15 * 60000) fail(401, "Sign in again before accessing keys or changing account security."); };
    let account = db.prepare("SELECT * FROM licensing_accounts WHERE google_sub=?").get(session.subject);
    if (req.method === "POST" && path === "/account/recover") {
      fresh();
      limit(`recover:${session.subject}`, 5, 3600000); limit("recover-global", 100, 3600000);
      if (account) fail(409, "This Google identity already has a profile. Account merging is not supported.");
      const code = body.get("recovery_code") || "";
      if (!/^[A-Za-z0-9_-]{43}$/.test(code)) fail(400, "Recovery code is invalid or has already been used.");
      transaction(() => {
        const old = db.prepare("SELECT a.* FROM licensing_accounts a JOIN licensing_recovery r ON a.id=r.account_id WHERE r.code_hash=?").get(digest(code));
        if (!old) fail(400, "Recovery code is invalid or has already been used.");
        db.prepare("DELETE FROM licensing_recovery WHERE account_id=?").run(old.id);
        db.prepare("DELETE FROM licensing_sessions WHERE subject=?").run(old.google_sub);
        for (const row of db.prepare("SELECT * FROM licensing_subscriptions WHERE account_id=?").all(old.id)) {
          db.prepare("INSERT OR REPLACE INTO licensing_suppressions VALUES (?,?)").run(row.email, timestamp);
          db.prepare("UPDATE licensing_subscriptions SET status='unsubscribed',confirm_hash=NULL,confirm_expires=NULL WHERE email=?").run(row.email);
          event(row, "withdrawn", "account/recover", timestamp);
        }
        db.prepare("UPDATE licensing_accounts SET google_sub=?,email=? WHERE id=?").run(session.subject, session.email, old.id);
      });
      redirect("/account?recovered=1"); return;
    }
    if (req.method === "POST" && path === "/account/create") {
      if (body.get("account_terms") !== config.terms.account.id || body.get("licence_terms") !== config.terms.noncommercial.id) fail(400, "Read and accept the current account and noncommercial terms.");
      fresh();
      transaction(() => {
        db.prepare("INSERT INTO licensing_accounts VALUES (?,?,?,?) ON CONFLICT(google_sub) DO NOTHING").run(`holder-${randomUUID()}`, session.subject, session.email, timestamp);
        account = db.prepare("SELECT * FROM licensing_accounts WHERE google_sub=?").get(session.subject);
        for (const term of [config.terms.account, config.terms.noncommercial]) db.prepare("INSERT OR IGNORE INTO licensing_acceptances VALUES (?,?,?)").run(account.id, term.id, timestamp);
        issue(account, timestamp);
      });
      redirect("/account"); return;
    }
    if (!account) {
      if (path !== "/account" || req.method !== "GET") fail(403, "Create your profile and accept the terms first.");
      res.end(page("Create your profile", `<p>Signed in as ${escape(session.email)}.</p><p>By selecting Create profile, you agree to the <a href="/account/terms">Account Terms</a>. Your free use is covered by the <a href="/account/noncommercial">Noncommercial Licence</a>. <a href="/account/privacy">Account privacy</a>.</p>${form(id, "/account/create", `<input type="hidden" name="account_terms" value="${escape(config.terms.account.id)}"><input type="hidden" name="licence_terms" value="${escape(config.terms.noncommercial.id)}">`, "Create profile")}<p>No newsletter subscription is included.</p><details><summary>Recover an existing profile</summary><p>Your saved recovery code moves your existing profile to this Google identity. Existing licences stay unchanged; newsletter preferences are withdrawn.</p>${form(id, "/account/recover", '<label>Recovery code<input type="password" name="recovery_code" autocomplete="off" maxlength="43" required></label>', "Recover profile")}</details>`)); return;
    }
    if (req.method === "POST" && path === "/account/recovery-code") {
      fresh();
      const code = randomBytes(32).toString("base64url");
      db.prepare("INSERT INTO licensing_recovery VALUES (?,?,?) ON CONFLICT(account_id) DO UPDATE SET code_hash=excluded.code_hash,created=excluded.created")
        .run(account.id, digest(code), timestamp);
      res.end(page("Save your recovery code", `<p>This code is shown once. Store it in a password manager. It lets you move this profile to another Google identity if you lose access. Generating another code replaces this one.</p><label for="licence-key">Recovery code</label><textarea id="licence-key" readonly rows="2">${code}</textarea><button class="button" id="copy-key" type="button">Copy code</button><p id="key-message" role="status" aria-live="polite"></p><p><a href="/account">Return to account</a></p><script src="/account/key.js" defer></script>`)); return;
    }
    if (req.method === "POST" && path === "/account/close") {
      fresh();
      if (body.get("confirm") !== "close") fail(400, "Confirm account closure after exporting your licences.");
      transaction(() => {
        for (const row of db.prepare("SELECT * FROM licensing_subscriptions WHERE account_id=?").all(account.id)) {
          db.prepare("INSERT OR REPLACE INTO licensing_suppressions VALUES (?,?)").run(row.email, timestamp);
          db.prepare("UPDATE licensing_subscriptions SET status='unsubscribed',confirm_hash=NULL,confirm_expires=NULL WHERE email=?").run(row.email);
          db.prepare("DELETE FROM licensing_consent_events WHERE subscription_id=?").run(row.id);
        }
        db.prepare("DELETE FROM licensing_subscriptions WHERE account_id=?").run(account.id);
        db.prepare("DELETE FROM licensing_recovery WHERE account_id=?").run(account.id);
        db.prepare("DELETE FROM licensing_sessions WHERE subject=?").run(session.subject);
        db.prepare("UPDATE licensing_accounts SET google_sub=?,email='' WHERE id=?").run(`closed:${randomUUID()}`, account.id);
      });
      setCookie(id, 0);
      res.end(page("Account closed", "<p>Your Google identity and account email have been removed. Exported licences remain usable under their original terms. Licence and accepted-terms records remain under an opaque holder ID; email suppression records remain to prevent marketing. Backups follow the published retention policy.</p>")); return;
    }
    const licences = () => db.prepare("SELECT * FROM licensing_certificates WHERE account_id=? ORDER BY issued DESC").all(account.id);
    if (req.method === "GET" && path === "/account/me") { json({ email: account.email, licences: licences().map(summary) }); return; }
    const licenceRoute = /^\/account\/licences\/(BH-[a-f0-9-]+)\/(reveal|download)$/.exec(path);
    if (licenceRoute) {
      const [, licenceId, action] = licenceRoute;
      if ((action === "reveal" && req.method !== "POST") || (action === "download" && req.method !== "GET")) fail(405, "Method not allowed.");
      const row = db.prepare("SELECT * FROM licensing_certificates WHERE id=? AND account_id=?").get(licenceId, account.id);
      if (!row) fail(404, "Licence not found."); fresh();
      const token = unseal(row.token, row.id);
      if (action === "download") {
        res.setHeader("content-type", "application/octet-stream"); res.setHeader("content-disposition", `attachment; filename="${row.id}.bothearth-license"`);
        res.end(`${token}\n`); return;
      }
      if (req.headers.accept?.includes("application/json")) { json({ licence: summary(row), key: token }); return; }
      res.end(page("Your licence key", `<label for="licence-key">Licence key</label><textarea id="licence-key" readonly rows="8">${escape(token)}</textarea><p><button class="button" id="copy-key" type="button">Copy key</button> <a href="/account">Hide key</a></p><p id="key-message" role="status" aria-live="polite"></p><p>Keep your key private. It is a licence certificate, not a password or remote-access credential.</p><script src="/account/key.js" defer></script>`)); return;
    }
    if (req.method === "GET" && path === "/account/export") {
      fresh(); res.setHeader("content-disposition", 'attachment; filename="BotHearth-account-export.json"');
      const rows = licences(); const termIds = new Set(rows.map((row) => row.terms_id));
      json({ format: "bothearth-account-export-v1", email: account.email, created_at: new Date(account.created).toISOString(),
        licences: rows.map((row) => ({ ...summary(row), key: unseal(row.token, row.id) })),
        terms: [...termIds].map((termId) => db.prepare("SELECT id,kind,text,sha256 FROM licensing_terms WHERE id=?").get(termId)),
        account_terms: db.prepare("SELECT t.id,t.kind,t.text,t.sha256,a.accepted FROM licensing_acceptances a JOIN licensing_terms t ON t.id=a.terms_id WHERE a.account_id=?").all(account.id),
        newsletter: db.prepare("SELECT email,status FROM licensing_subscriptions WHERE account_id=?").all(account.id), receipts: [],
      }); return;
    }
    if (path === "/account/commercial" || path === "/account/orders") {
      const raw = (body || query).get("quantity") || "1";
      if (!/^[0-9]{1,2}$/.test(raw) || Number(raw) < 1 || Number(raw) > 50) fail(400, "Choose 1–50 licences. For more than 50, use Contact us.");
      if (req.method === "POST") fail(503, COMMERCIAL_OFFER.reason);
      const quantity = Number(raw);
      res.end(page("Commercial licence", `<p class="lead">US$60 once per bot · Introductory price</p><p>Planned future price: US$199 per bot. Not previously charged.</p><p>One commercial key per running bot. Multiple profiles and sequential tasks do not add bots. More than 50 licences? <a href="${COMMERCIAL_OFFER.contact_url}">Contact us</a>.</p><form method="get" action="/account/commercial"><label>Licences<input type="number" name="quantity" min="1" max="50" step="1" value="${quantity}" required></label><button type="submit">Update quantity</button></form><p>${quantity} ${quantity === 1 ? "licence" : "licences"}: US$${quantity * 60} before applicable tax. Final payable totals will be shown when checkout opens.</p><button class="button" disabled>Checkout unavailable</button><p role="status">${COMMERCIAL_OFFER.reason}</p><p>Proposed coverage: ${escape(config.coveredRelease)} and permitted modifications. No subscription or promise of future feature releases. Model use and your machine or optional hosting cost extra.</p><p>Qualifying outputs may be sold without a BotHearth royalty. Commercial operation needs the applicable permission; standard licences do not add hosted-service or resale rights. Independent rights remain unaffected.</p><p>For business customers outside India. Existing grants, orders and published refund rights retain their original terms. <a href="${COMMERCIAL_OFFER.contact_url}">Contact us</a>.</p>`)); return;
    }
    if (req.method === "POST" && path === "/account/newsletter/subscribe") {
      if (body.get("subscribe") !== "yes") { redirect("/account"); return; }
      const email = emailAddress(body.get("email"));
      limit(`newsletter:${email}`, 1, 60000); limit("newsletter-global", 50, 3600000);
      let row = db.prepare("SELECT * FROM licensing_subscriptions WHERE account_id=? AND email=?").get(account.id, email);
      if (row?.status === "confirmed") { redirect("/account"); return; }
      const subscriptionId = row?.id || randomUUID(); const token = randomBytes(32).toString("base64url");
      const unsubscribe = row ? unseal(row.unsubscribe_token, row.id) : randomBytes(32).toString("base64url");
      transaction(() => {
        db.prepare(`INSERT INTO licensing_subscriptions VALUES (?,?,?,'pending',?,?,?,?,?) ON CONFLICT(account_id,email) DO UPDATE SET status='pending',confirm_hash=excluded.confirm_hash,confirm_expires=excluded.confirm_expires,updated=excluded.updated`)
          .run(subscriptionId, account.id, email, hash(token), timestamp + 86400000, hash(unsubscribe), seal(unsubscribe, subscriptionId), timestamp);
        row = db.prepare("SELECT * FROM licensing_subscriptions WHERE id=?").get(subscriptionId);
        event(row, "requested", "/account/newsletter/subscribe", timestamp);
      });
      try {
        await sendMail({ from, to: [email], subject: "Confirm your BotHearth newsletter", text: `You asked to receive BotHearth releases, practical tips and occasional offers. Confirm within 24 hours: ${origin}/account/newsletter/confirm?token=${token}\n\nYour licence is ready either way. If this was not you, ignore this message. Stop these emails: ${origin}/account/newsletter/unsubscribe?token=${unsubscribe}` }, `newsletter-${subscriptionId}-${hash(token).slice(0,16)}`);
      } catch { fail(503, "Your licence is ready, but newsletter confirmation delivery could not be confirmed. You can try again in a minute."); }
      redirect("/account?newsletter=pending"); return;
    }
    if (req.method === "POST" && path === "/account/newsletter/withdraw") {
      const row = db.prepare("SELECT * FROM licensing_subscriptions WHERE id=? AND account_id=?").get(body.get("subscription"), account.id);
      if (!row) fail(404, "Subscription not found."); withdraw(row, timestamp); redirect("/account"); return;
    }
    if (req.method !== "GET" || path !== "/account") fail(404, "Page not found.");
    const rows = licences();
    const newRelease = rows.some((row) => row.covered_release === config.coveredRelease && row.terms_id === config.terms.noncommercial.id) ? "" : `<section><h2>Licence for ${escape(config.coveredRelease)}</h2><p>By selecting Get licence, you agree to the <a href="/account/terms">Account Terms</a> and <a href="/account/noncommercial">Noncommercial Licence</a> for this release. Your earlier certificates remain available.</p>${form(id, "/account/create", `<input type="hidden" name="account_terms" value="${escape(config.terms.account.id)}"><input type="hidden" name="licence_terms" value="${escape(config.terms.noncommercial.id)}">`, "Get licence")}</section>`;
    const licenceBody = rows.map((row) => `<section><p class="account-badge">Non-commercial</p><p>Covers ${escape(row.covered_release)}. No renewal required.</p><p>Key ••••••••${escape(row.id.slice(-6))}</p>${form(id, `/account/licences/${row.id}/reveal`, "", "Reveal key")}<p><a href="/account/licences/${row.id}/download">Download licence</a> · <a href="https://bothearth.com/quickstart/">Install BotHearth</a></p></section>`).join("");
    const subscriptions = db.prepare("SELECT * FROM licensing_subscriptions WHERE account_id=?").all(account.id);
    const preferences = subscriptions.map((row) => `<p>${escape(row.email)}: ${row.status === "confirmed" ? "Subscribed" : row.status === "pending" ? "Awaiting email confirmation" : "Unsubscribed"}.</p>${row.status !== "unsubscribed" ? form(id, "/account/newsletter/withdraw", `<input type="hidden" name="subscription" value="${row.id}">`, "Unsubscribe") : ""}`).join("");
    res.end(page("Your licence", `<p>Signed in as ${escape(account.email)}.</p>${newRelease}${licenceBody}<p>For uses permitted by the noncommercial terms recorded with each certificate. Working for a business or client? <a href="/account/commercial">Commercial licences</a>.</p><details><summary>Stay in touch</summary>${preferences}${form(id, "/account/newsletter/subscribe", `<label>Email for updates<input type="email" name="email" value="${escape(account.email)}" maxlength="254" required></label><label class="consent"><input type="checkbox" name="subscribe" value="yes"><span>${NEWSLETTER_CONSENT.text}</span></label>`, "Save preference")}<p>We’ll ask you to confirm your email. Your licence is ready either way.</p></details><p><a href="/account/export">Export licences and account records</a></p><details><summary>Account security</summary><p>Save a recovery code before losing access to Google. A licence key cannot recover your account.</p>${form(id, "/account/recovery-code", "", "Generate recovery code")}<p>Export your licences before closing your account. Closure removes your Google identity, email and newsletter preferences. Licence and accepted-terms records remain under an opaque ID, and suppression records prevent marketing. Existing offline licences remain valid; account recovery is disabled.</p>${form(id, "/account/close", '<label><input type="checkbox" name="confirm" value="close" required> I have exported my licences and want to close this account.</label>', "Close account")}</details>${form(id, "/account/sign-out", "", "Sign out")}`));
  };
}
