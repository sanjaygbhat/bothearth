import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const page = (title, text) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)} — BotHearth</title><link rel="stylesheet" href="https://bothearth.com/tokens.css"><link rel="stylesheet" href="https://bothearth.com/style.css"><main class="wrap page-header"><p class="eyebrow">BotHearth</p><h1>${escape(title)}</h1><p class="lead">${escape(text)}</p><p><a class="button" href="https://bothearth.com/contact/">Back to contact form</a></p></main></html>`;

export function createContactServer({ contact, from, sendMail, now = Date.now }) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact || "") || !from || !sendMail) throw new Error("Configure the private recipient, sender, and email service.");
  // ponytail: one low-volume instance; use a shared rate limiter if contact traffic needs multiple instances.
  const recent = new Map();
  let window = 0; let count = 0;
  return createServer(async (req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", "default-src 'none'; style-src https://bothearth.com; font-src https://bothearth.com; frame-ancestors 'none'; base-uri 'none'");
    const respond = (status, title, text) => { res.statusCode = status; res.end(page(title, text)); };
    if (req.method === "GET" && req.url === "/health") { res.end("ok"); return; }
    if (req.method !== "POST" || req.url !== "/enquiry") { respond(404, "Page not found", "Use the contact form to send an enquiry."); return; }
    if (req.headers.origin !== "https://bothearth.com" || req.headers["content-type"]?.split(";")[0].trim() !== "application/x-www-form-urlencoded") { respond(403, "Please use the contact form", "Open the form on bothearth.com and submit it there."); return; }
    const timestamp = now();
    if (Math.floor(timestamp / 60000) !== window) { window = Math.floor(timestamp / 60000); count = 0; }
    if (++count > 30) { res.setHeader("retry-after", "60"); respond(429, "Please try again shortly", "We’re receiving many enquiries. Please wait a minute before trying again."); return; }
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 16384) { respond(413, "Message too long", "Keep your message under 4,000 characters."); return; } chunks.push(chunk); }
      const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const name = (body.get("name") || "").trim();
      const email = (body.get("email") || "").trim();
      const organisation = (body.get("organisation") || "").trim();
      const message = (body.get("message") || "").trim();
      const seats = Number(body.get("seats") || 0);
      if (body.get("website")) { respond(400, "Please try again", "Leave the hidden website field empty."); return; }
      if (!name || name.length > 160 || organisation.length > 160 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || email.length > 254 || !message || message.length > 4000 || !Number.isInteger(seats) || seats < 0 || seats > 10000 || /[\x00-\x1f\x7f]/.test(name + organisation + email) || message.includes("\0")) { respond(400, "Check your enquiry", "Enter your name, a valid reply email, and a message of up to 4,000 characters. Use your browser’s Back button to edit your message."); return; }
      for (const [key, expires] of recent) if (expires <= timestamp) recent.delete(key);
      const key = createHash("sha256").update(email.toLowerCase()).digest("hex");
      if (recent.has(key)) { res.setHeader("retry-after", "60"); respond(429, "Please wait a minute", "Allow a minute between enquiries from the same email address. Use your browser’s Back button to keep your message."); return; }
      recent.set(key, timestamp + 60000);
      const text = `Name: ${name}\nReply email (unverified): ${email}\nOrganisation: ${organisation || "Not supplied"}\nAdditional licences: ${seats}\n\n${message}`;
      const id = createHash("sha256").update(`${Math.floor(timestamp / 600000)}:${text}`).digest("hex");
      await sendMail({ from, to: [contact], reply_to: email, subject: "BotHearth contact enquiry", text }, `contact-${id}`);
      respond(200, "Enquiry sent", "Our email service has accepted your enquiry. We’ll reply to the address you provided.");
    } catch {
      respond(503, "Your enquiry could not be sent", "Please use your browser’s Back button to keep your message, wait a minute, and try again. We haven’t confirmed delivery.");
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  if (!env.RESEND_API_KEY) throw new Error("Configure RESEND_API_KEY.");
  const server = createContactServer({ contact: env.ENTERPRISE_CONTACT, from: env.ENTERPRISE_FROM,
    sendMail: async (payload, key) => {
      const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error("Email service rejected the enquiry.");
    } });
  server.listen(Number(env.PORT || 8080), "0.0.0.0");
}
