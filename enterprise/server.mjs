import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { domainToASCII } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { parse } from "tldts";
import disposable from "disposable-email-domains/index.json" with { type: "json" };
import wildcard from "disposable-email-domains/wildcard.json" with { type: "json" };

const root = fileURLToPath(new URL("../", import.meta.url));
const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const termsVersion = "2026-09-09.2";
const terms = readFileSync(resolve(root, "website/enterprise.html"), "utf8")
  .match(/<section id="terms">([\s\S]*?)<\/section>/)[1]
  .replaceAll("{{BASE}}", "https://bothearth.com/")
  .replaceAll("{{REPOSITORY}}", "https://github.com/sanjaygbhat/bothearth");
const blocked = new Set([...disposable, ...wildcard, ...`gmail.com googlemail.com outlook.com hotmail.com live.com msn.com yahoo.com yahoo.co.uk yahoo.co.in yahoo.in ymail.com rocketmail.com aol.com icloud.com me.com mac.com proton.me protonmail.com pm.me tutanota.com tuta.com tuta.io tutamail.com mail.com email.com gmx.com gmx.de gmx.net fastmail.com fastmail.fm hey.com zoho.com zohomail.com rediffmail.com rediff.com qq.com 163.com 126.com 139.com sina.com sohu.com mail.ru inbox.ru list.ru bk.ru yandex.com yandex.ru rambler.ru duck.com simplelogin.com simplelogin.io mozmail.com firefox.com onmicrosoft.com example.com example.org example.net`.split(" ")]);
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const equal = (a, b) => typeof a === "string" && typeof b === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function workEmail(value) {
  if (typeof value !== "string" || value.length > 254) fail(400, "Enter a valid work email address.");
  const parts = value.trim().split("@");
  if (parts.length !== 2 || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/.test(parts[0]) || parts[0].startsWith(".") || parts[0].endsWith(".") || parts[0].includes("..")) fail(400, "Enter a valid work email address.");
  const host = domainToASCII(parts[1].toLowerCase());
  if (!host || host.length > 253 || host.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) fail(400, "Enter a valid work email domain.");
  const parsed = parse(host, { allowPrivateDomains: true });
  if (!parsed.domain || !parsed.isIcann || parsed.isPrivate) fail(400, "Use a domain owned by your organisation.");
  for (let domain = host; domain.includes("."); domain = domain.slice(domain.indexOf(".") + 1)) {
    if (blocked.has(domain)) fail(400, "Use your organisation’s own domain, not a personal or disposable email service. Contact us if your domain was rejected incorrectly.");
  }
  // ponytail: mailbox verification + domain lists cannot prove a legal organisation; review disputed claims manually.
  return { email: `${parts[0].toLowerCase()}@${host}`, domain: parsed.domain };
}

export function createEnterpriseServer({ database, origin, secret, from, contact, sendMail, now = Date.now }) {
  const url = new URL(origin);
  const local = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  if ((!local && url.protocol !== "https:") || url.origin !== origin || secret.length < 32 || !from || !sendMail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) throw new Error("Configure an HTTPS origin, a 32+ character secret, email sender, and contact address.");
  const db = new DatabaseSync(database);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, email TEXT NOT NULL, domain TEXT NOT NULL, code TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, email TEXT NOT NULL, domain TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS licences (domain TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, organisation TEXT NOT NULL, email TEXT NOT NULL, issued INTEGER NOT NULL, version TEXT NOT NULL, terms_version TEXT NOT NULL, terms_html TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS limits (id TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS enquiries (id TEXT PRIMARY KEY, email TEXT NOT NULL, domain TEXT NOT NULL, seats INTEGER NOT NULL, message TEXT NOT NULL, created INTEGER NOT NULL, delivered INTEGER);`);
  const hash = (value) => createHmac("sha256", secret).update(value).digest("hex");
  const cookieName = local ? "enterprise" : "__Host-enterprise";
  const setCookie = (res, id, age = 86400) => res.setHeader("set-cookie", `${cookieName}=${id}.${hash(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${local ? "" : "; Secure"}`);
  const csrf = (id) => `<input type="hidden" name="csrf" value="${hash(`csrf:${id}`)}">`;
  const form = (id, action, content, button) => `<form class="enterprise-form" method="post" action="${action}">${csrf(id)}${content}<button class="button" type="submit">${button}</button></form>`;
  const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>${escape(title)} — BotHearth</title><link rel="stylesheet" href="https://bothearth.com/tokens.css"><link rel="stylesheet" href="/style.css"></head><body><a class="skip" href="#main">Skip to content</a><div class="wrap"><header class="site-header"><a class="wordmark" href="https://bothearth.com/">BotHearth</a><nav aria-label="Main navigation"><a href="https://bothearth.com/enterprise/">Enterprise offer</a></nav></header><main class="page-header prose" id="main"><h1>${escape(title)}</h1>${body}</main><footer class="site-footer"><p><a href="https://bothearth.com/security/#website">Privacy</a> · <a href="https://bothearth.com/contact/">Contact us</a></p></footer></div></body></html>`;
  const limit = (key, count, period) => {
    const window = Math.floor(now() / period);
    const result = db.prepare("INSERT INTO limits VALUES (?, 1, ?) ON CONFLICT(id) DO UPDATE SET count=count+1 RETURNING count").get(hash(`${key}:${window}`), (window + 1) * period);
    if (result.count > count) fail(429, "Too many attempts. Please try again later.");
  };
  const certificate = (licence) => page("Enterprise licence certificate", `<p>Issued by BotHearth to <strong>${escape(licence.organisation)}</strong>.</p><dl><dt>Licence ID</dt><dd>${escape(licence.id)}</dd><dt>Organisation domain</dt><dd>${escape(licence.domain)}</dd><dt>Issued</dt><dd>${new Date(licence.issued).toISOString()}</dd><dt>BotHearth version</dt><dd>${escape(licence.version)}</dd><dt>Terms version</dt><dd>${escape(licence.terms_version)}</dd><dt>Allowance</dt><dd>One running installation under the recorded terms below. Perpetual; no renewal fee.</dd></dl>${licence.terms_html}`);
  const server = createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", "default-src 'none'; style-src 'self' https://bothearth.com; font-src 'self' https://bothearth.com; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (!local) res.setHeader("strict-transport-security", "max-age=31536000");
    res.setHeader("content-type", "text/html; charset=utf-8");
    let id;
    try {
      const path = new URL(req.url, origin).pathname;
      if (req.method === "GET" && path === "/health") { res.end("ok"); return; }
      if (req.method === "GET" && ["/style.css", "/fonts/fraunces-latin-wght.woff2"].includes(path)) {
        res.setHeader("content-type", path.endsWith(".css") ? "text/css" : "font/woff2");
        res.end(readFileSync(resolve(root, `website${path}`))); return;
      }
      if (!["GET", "POST"].includes(req.method)) fail(405, "Method not allowed.");
      // Use the socket address, never client-supplied forwarding headers. A reverse proxy shares this budget.
      limit(`request:${req.socket.remoteAddress}`, 120, 60000);
      const timestamp = now();
      for (const table of ["challenges", "sessions", "limits"]) db.prepare(`DELETE FROM ${table} WHERE expires <= ?`).run(timestamp);
      db.prepare("DELETE FROM enquiries WHERE created < ?").run(timestamp - 90 * 86400000);
      const raw = (req.headers.cookie || "").split("; ").find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      const match = /^(\d+_[a-f0-9]{48})\.([a-f0-9]{64})$/.exec(raw || "");
      if (match && Number(match[1].split("_")[0]) > timestamp - 86400000 && equal(match[2], hash(match[1]))) id = match[1];
      if (!id) {
        if (req.method === "POST") fail(403, "Your session expired. Sign in again.");
        id = `${timestamp}_${randomBytes(24).toString("hex")}`; setCookie(res, id);
      }
      let body;
      if (req.method === "POST") {
        if (req.headers.origin !== origin || !req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) fail(403, "This form must be submitted from the enterprise site.");
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 16384) fail(413, "The message is too large."); chunks.push(chunk); }
        body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        if (!equal(body.get("csrf"), hash(`csrf:${id}`))) fail(403, "The form expired. Reload and try again.");
      }
      const session = db.prepare("SELECT * FROM sessions WHERE id=? AND expires>?").get(hash(id), timestamp);
      const redirect = (location) => { res.writeHead(303, { location }); res.end(); };
      if (req.method === "POST" && path === "/sign-in") {
        const { email, domain } = workEmail(body.get("email"));
        limit(`email:${email}`, 1, 60000); limit(`email:${email}`, 5, 3600000);
        limit(`domain:${domain}`, 20, 3600000); limit("email-global", 50, 3600000);
        const code = String(randomInt(0, 100000000)).padStart(8, "0");
        db.prepare("INSERT OR REPLACE INTO challenges VALUES (?, ?, ?, ?, ?, 0)").run(hash(id), email, domain, hash(`${id}:${code}`), timestamp + 600000);
        try {
          await sendMail({ from, to: [email], subject: "Your BotHearth sign-in code", text: `Your BotHearth code is ${code}. It expires in 10 minutes and works once. Enter it only at ${origin}/verify in the browser where you requested it. Never share it with anyone, including support. If you did not request it, ignore this email.` }, `signin-${randomUUID()}`);
        } catch { db.prepare("DELETE FROM challenges WHERE id=? AND code=?").run(hash(id), hash(`${id}:${code}`)); fail(503, "Email could not be sent. Please try again later or contact us."); }
        redirect("/verify"); return;
      }
      if (path === "/verify") {
        const pending = db.prepare("SELECT * FROM challenges WHERE id=? AND expires>?").get(hash(id), timestamp);
        if (!pending || pending.attempts >= 5) fail(400, "The code expired or too many attempts were made. Request a new code.");
        if (req.method === "POST") {
          db.prepare("UPDATE challenges SET attempts=attempts+1 WHERE id=?").run(hash(id));
          const code = body.get("code") || "";
          if (!/^[0-9]{8}$/.test(code) || !equal(pending.code, hash(`${id}:${code}`))) fail(400, "That code is incorrect. Return to the code form and try again.");
          const next = `${timestamp}_${randomBytes(24).toString("hex")}`;
          db.exec("BEGIN IMMEDIATE");
          try {
            db.prepare("DELETE FROM challenges WHERE id=?").run(hash(id));
            db.prepare("DELETE FROM sessions WHERE id=?").run(hash(id));
            db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(hash(next), pending.email, pending.domain, timestamp + 86400000);
            db.exec("COMMIT");
          } catch (error) { db.exec("ROLLBACK"); throw error; }
          setCookie(res, next); redirect("/"); return;
        }
        res.end(page("Check your work email", `<p>Enter the eight-digit code sent to ${escape(pending.email)}. It expires in ten minutes.</p>${form(id, "/verify", '<label>Verification code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{8}" minlength="8" maxlength="8" required></label>', "Verify email")}<a href="/">Use another email</a>`)); return;
      }
      if (req.method === "POST" && path === "/sign-out") {
        db.prepare("DELETE FROM sessions WHERE id=?").run(hash(id));
        db.prepare("DELETE FROM challenges WHERE id=?").run(hash(id));
        setCookie(res, id, 0); redirect("/"); return;
      }
      if (!session) {
        if (path !== "/" || req.method !== "GET") fail(401, "Sign in with your work email first.");
        res.end(page("Your organisation’s licence", `<p class="lead">One free perpetual business bot. Sell what it creates. Sign in to record your organisation’s published free entitlement, access its certificate, or enquire about additional bots.</p>${form(id, "/sign-in", '<label>Work email<input name="email" type="email" autocomplete="email" maxlength="254" placeholder="you@yourcompany.com" required></label><p>We’ll email a one-time code. Personal and disposable addresses are not eligible. No card is required.</p>', "Email me a sign-in code")}<p>Only sign in for an organisation you are authorised to represent. <a href="https://bothearth.com/enterprise/#terms">Offer terms</a>.</p>`)); return;
      }
      const getLicence = () => db.prepare("SELECT * FROM licences WHERE domain=?").get(session.domain);
      if (req.method === "POST" && path === "/claim") {
        const organisation = (body.get("organisation") || "").trim();
        if (!organisation || organisation.length > 160 || /[\x00-\x1f\x7f]/.test(organisation) || body.get("accept") !== termsVersion) fail(400, "Enter your organisation name and accept the licence terms.");
        db.prepare("INSERT INTO licences VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(domain) DO NOTHING").run(session.domain, `BH-${randomUUID()}`, organisation, session.email, timestamp, version, termsVersion, terms);
        redirect("/"); return;
      }
      if (req.method === "GET" && path === "/certificate") {
        const licence = getLicence(); if (!licence) fail(404, "Claim your organisation’s licence first.");
        res.setHeader("content-disposition", 'attachment; filename="BotHearth-enterprise-licence.html"');
        res.end(certificate(licence)); return;
      }
      let notice = "";
      let enquiryId = randomUUID();
      if (req.method === "POST" && path === "/contact") {
        const seats = Number(body.get("seats")); const message = (body.get("message") || "").trim(); enquiryId = body.get("request_id");
        if (!Number.isInteger(seats) || seats < 1 || seats > 10000 || !message || message.length > 4000 || !/^[a-f0-9-]{36}$/.test(enquiryId || "")) fail(400, "Enter 1–10,000 additional licences and a message of up to 4,000 characters.");
        limit(`contact:${session.email}`, 10, 3600000);
        const previous = db.prepare("SELECT * FROM enquiries WHERE id=?").get(enquiryId);
        if (previous && previous.email !== session.email) fail(403, "This enquiry belongs to another session.");
        db.prepare("INSERT OR IGNORE INTO enquiries VALUES (?, ?, ?, ?, ?, ?, NULL)").run(enquiryId, session.email, session.domain, seats, message, timestamp);
        const enquiry = db.prepare("SELECT * FROM enquiries WHERE id=?").get(enquiryId);
        if (!enquiry.delivered) {
          if (timestamp - enquiry.created >= 23 * 3600000) fail(409, "This saved enquiry needs manual follow-up. Please use the contact form and include your reference.");
          try {
            await sendMail({ from, to: [contact], reply_to: enquiry.email, subject: `BotHearth enterprise enquiry — ${enquiry.domain}`, text: `Reference: ${enquiry.id}\nVerified work email: ${enquiry.email}\nDomain: ${enquiry.domain}\nAdditional licences: ${enquiry.seats}\n\n${enquiry.message}` }, `enquiry-${enquiry.id}`);
            db.prepare("UPDATE enquiries SET delivered=? WHERE id=?").run(now(), enquiryId);
          } catch {
            res.statusCode = 503;
            notice = `<div class="enterprise-notice" role="alert">Your enquiry is saved, but email delivery could not be confirmed. Use Retry email below. Reference: ${escape(enquiry.id)}.</div>${form(id, "/contact", `<input type="hidden" name="request_id" value="${escape(enquiry.id)}"><input type="hidden" name="seats" value="${enquiry.seats}"><input type="hidden" name="message" value="${escape(enquiry.message)}">`, "Retry email")}`;
          }
        }
        if (!notice) { redirect(`/?sent=${enquiryId}#contact`); return; }
      } else if (req.method !== "GET" || path !== "/") fail(404, "Page not found.");
      enquiryId = randomUUID();
      const sent = new URL(req.url, origin).searchParams.get("sent");
      if (sent && db.prepare("SELECT id FROM enquiries WHERE id=? AND email=? AND delivered IS NOT NULL").get(sent, session.email)) notice = '<div class="enterprise-notice" role="status">Your enquiry has been accepted by our email service for delivery to our inbox. We can reply directly to your verified work email.</div>';
      const pendingEnquiries = db.prepare("SELECT * FROM enquiries WHERE email=? AND delivered IS NULL ORDER BY created DESC LIMIT 10").all(session.email);
      const retries = pendingEnquiries.map((enquiry) => `<p>Saved enquiry ${escape(enquiry.id)}: ${enquiry.seats} additional licences.</p>${timestamp - enquiry.created < 23 * 3600000 ? form(id, "/contact", `<input type="hidden" name="request_id" value="${escape(enquiry.id)}"><input type="hidden" name="seats" value="${enquiry.seats}"><input type="hidden" name="message" value="${escape(enquiry.message)}">`, "Retry saved enquiry email") : `<p>Please use the contact form with this reference for manual follow-up.</p>`}`).join("");
      const licence = getLicence();
      const licenceBody = licence ? `<section><h2>Your free perpetual licence</h2><p><strong>${escape(licence.organisation)}</strong> · ${escape(licence.domain)}</p><p>Licence ${escape(licence.id)} covers one running installation of BotHearth ${escape(licence.version)} under its recorded terms. No expiry or renewal fee. Your colleagues on this domain share this licence.</p><p><a class="button" href="/certificate">Download licence certificate</a> <a href="https://bothearth.com/quickstart/">Install BotHearth</a></p></section>` : `<section><h2>Claim your free perpetual licence</h2><p>One running installation for <strong>${escape(session.domain)}</strong>. Your own business work and client deliverables, with no expiry or renewal fee. Sell outputs; no resale or hosted replication of BotHearth. This certificate records the published free allowance.</p><details><summary>Read the licence terms</summary>${terms}</details>${form(id, "/claim", `<label>Legal organisation name<input name="organisation" maxlength="160" autocomplete="organization" required></label><label class="consent"><input type="checkbox" name="accept" value="${termsVersion}" required><span>I am authorised to represent this organisation, it has not claimed another free licence, and I accept the licence terms above (${termsVersion}).</span></label>`, "Claim free licence")}</section>`;
      res.end(page("Enterprise account", `<p>Signed in as ${escape(session.email)}.</p>${licenceBody}<section id="contact"><p>Limited-time introductory offer · Over 50% off</p><h2>Additional business bots: <del>US$99</del> US$49 each</h2><p>Request the introductory price while available. Regular price US$99; introductory price US$49, paid once per additional business bot of the issued version, plus applicable taxes. An enquiry alone does not reserve a price; the confirmed order governs. Sell outputs; neither free nor paid standard licences permit resale or hosting of BotHearth copies, including modified versions. For business customers outside India. No voluntary refunds. <a href="https://bothearth.com/terms/">Commercial terms</a> · <a href="https://bothearth.com/refunds/">Refund policy</a>. Payment collection is not open yet.</p><p>Your enquiry goes to our private inbox, with your verified work email as the reply address.</p>${notice}${retries}${form(id, "/contact", `<input type="hidden" name="request_id" value="${enquiryId}"><label>Additional licences<input name="seats" type="number" min="1" max="10000" step="1" value="1" required></label><label>What is your billing country, and how will your organisation use BotHearth?<textarea name="message" rows="5" maxlength="4000" required></textarea></label><p>Do not include passwords, API keys, or confidential task data.</p>`, "Send enquiry")}</section>${form(id, "/sign-out", "", "Sign out")}`));
    } catch (error) {
      res.statusCode = error.status || 500;
      if (error.status === 429) res.setHeader("retry-after", "60");
      // Do not log email addresses, codes, cookies, or provider response bodies.
      if (!error.status) console.error("Enterprise request failed");
      res.end(page("Please try again", `<p role="alert">${escape(error.status ? error.message : "Something went wrong. Please try again or contact us.")}</p><p><a href="/">Return to your account</a> · <a href="/verify">Return to the code form</a></p>`));
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on("close", () => db.close());
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  if (!env.ENTERPRISE_ORIGIN || !env.ENTERPRISE_SECRET || !env.RESEND_API_KEY || !env.ENTERPRISE_FROM || !env.ENTERPRISE_DB || !env.ENTERPRISE_CONTACT) throw new Error("Set ENTERPRISE_ORIGIN, ENTERPRISE_SECRET, RESEND_API_KEY, ENTERPRISE_FROM, ENTERPRISE_DB, and ENTERPRISE_CONTACT. See enterprise/README.md.");
  process.umask(0o077);
  mkdirSync(dirname(resolve(env.ENTERPRISE_DB)), { recursive: true, mode: 0o700 });
  const server = createEnterpriseServer({ database: env.ENTERPRISE_DB, origin: env.ENTERPRISE_ORIGIN, secret: env.ENTERPRISE_SECRET, from: env.ENTERPRISE_FROM, contact: env.ENTERPRISE_CONTACT,
    sendMail: async (payload, key) => {
      const response = await fetch("https://api.resend.com/emails", { method: "POST", signal: AbortSignal.timeout(10000), headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json", "user-agent": "BotHearth-enterprise/1.0", "idempotency-key": key }, body: JSON.stringify(payload) });
      if (!response.ok || !(await response.json()).id) throw new Error("Email delivery failed");
    } });
  server.listen(Number(env.PORT || 4180), env.ENTERPRISE_BIND || "127.0.0.1", () => console.log("BotHearth enterprise service listening"));
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => server.close());
}
