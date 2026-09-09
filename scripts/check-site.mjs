#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, ".site-build");
const config = JSON.parse(readFileSync(join(root, "website/site.json"), "utf8"));
const site = new URL(process.env.SITE_URL || config.url);
site.pathname = `${site.pathname.replace(/\/$/, "")}/`;
const repo = (process.env.SITE_REPOSITORY || config.repository).replace(/\/$/, "");
const decode = (value) => value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const read = (file) => readFileSync(join(output, file), "utf8");
const titles = new Set();
const descriptions = new Set();
let links = 0;
let assets = 0;
function checkReference(ref, current) {
  const url = new URL(decode(ref), current);
  assert(!["javascript:", "data:"].includes(url.protocol), `Unsafe reference ${ref}`);
  if (url.href.startsWith(`${repo}/blob/main/`)) {
    const file = decodeURIComponent(url.pathname.split("/blob/main/")[1]);
    assert(existsSync(join(root, file)), `Missing repository document: ${file}`);
  }
  if (url.origin !== site.origin) return;
  assert(url.pathname.startsWith(site.pathname), `Reference escapes site base: ${ref}`);
  const relative = decodeURIComponent(url.pathname.slice(site.pathname.length));
  const file = relative.endsWith("/") || !relative ? `${relative}index.html` : relative;
  assert(existsSync(join(output, file)), `Broken local reference ${ref} in ${current}`);
  if (url.hash && file.endsWith(".html")) {
    const id = decodeURIComponent(url.hash.slice(1));
    const ids = [...read(file).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    assert(ids.includes(id), `Broken fragment ${ref} in ${current}`);
  }
  links++;
}
for (const page of config.pages) {
  const relative = page.slug ? `${page.slug}/index.html` : "index.html";
  const html = read(relative);
  const current = new URL(page.slug ? `${page.slug}/` : "", site).href;
  assert(!/\{\{[A-Z]+\}\}/.test(html), `Unresolved template in ${relative}`);
  assert.equal((html.match(/<h1\b/g) || []).length, 1, `Expected one h1 in ${relative}`);
  assert.equal((html.match(/<main\b/g) || []).length, 1, `Expected one main in ${relative}`);
  assert(html.includes('lang="en"') && html.includes('href="#main"'), `Missing language/skip link in ${relative}`);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, new Set(ids).size, `Duplicate id in ${relative}`);
  const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
  const description = html.match(/<meta name="description" content="([^"]+)"/)?.[1];
  assert(title && !titles.has(title), `Missing/duplicate title in ${relative}`);
  assert(description && !descriptions.has(description), `Missing/duplicate description in ${relative}`);
  titles.add(title); descriptions.add(description);
  assert.equal(decode(html.match(/<link rel="canonical" href="([^"]+)"/)?.[1] || ""), current);
  assert.equal(decode(html.match(/<meta property="og:url" content="([^"]+)"/)?.[1] || ""), current);
  assert.equal(decode(html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] || ""), decode(title));
  const schemaText = html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)?.[1];
  assert(schemaText, `Missing schema in ${relative}`);
  const schema = JSON.parse(schemaText);
  assert.equal(schema["@context"], "https://schema.org");
  assert(schema["@graph"].some((item) => item["@type"] === "WebSite" && item.url === site.href));
  assert(schema["@graph"].some((item) => item["@type"] === "WebPage" && item.url === current));
  if (!page.slug) {
    const app = schema["@graph"].find((item) => item["@type"] === "SoftwareApplication");
    assert(app && app.name === "BotHearth" && app.license === `${repo}/blob/main/LICENSE`);
    assert(!app.aggregateRating && !app.review && !app.offers, "Do not invent ratings or an unrestricted free offer");
  }
  assert.equal((html.match(/<script\b/g) || []).length, 1, `Runtime script in ${relative}`);
  assert(!/<iframe\b/i.test(html), `Unexpected frame in ${relative}`);
  assert(!/\bSanjay\b|\bSGBhat\b|mailto:|sanjaygbhat@gmail\.com/i.test(html), `Private contact identity in ${relative}`);
  if (page.slug === "contact") {
    assert.equal((html.match(/<form\b/g) || []).length, 1);
    assert(html.includes('method="post"') && html.includes('name="email"') && html.includes('name="message"'));
    const action = html.match(/<form[^>]*action="([^"]+)"/)?.[1];
    assert(action ? action.startsWith("https://") && !decodeURIComponent(action).includes("@") : html.includes('<fieldset disabled>'), "Contact form must have a private endpoint or explicitly disable sending");
  } else assert(!/<form\b/i.test(html), `Unexpected form in ${relative}`);
  assert(!/(?:src|href)="https?:\/\//.test(html.replace(/<a\b[^>]*>/g, "").replace(/<link rel="canonical"[^>]*>/g, "")), `External runtime asset in ${relative}`);
  for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) checkReference(match[1], current);
  checkReference(html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] || "", current);
  for (const match of html.matchAll(/<img\b[^>]*>/g)) {
    assert(/\balt="[^"]+"/.test(match[0]), `Missing image alternative in ${relative}`);
    assert(/\bwidth="\d+"/.test(match[0]) && /\bheight="\d+"/.test(match[0]), `Missing image dimensions in ${relative}`);
  }
  const text = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");
  assert(!/\bunlimited\b|nothing leaves without|nothing moves off this machine/i.test(text), `Overclaim in ${relative}`);
}
for (const file of ["tokens.css", "style.css"]) {
  for (const match of read(file).matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
    checkReference(match[1], new URL(file, site).href); assets++;
  }
}
const urls = [...read("sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decode(m[1]));
assert.deepEqual(urls.sort(), config.pages.map((p) => new URL(p.slug ? `${p.slug}/` : "", site).href).sort());
assert(read("robots.txt").includes(`Sitemap: ${site.href}sitemap.xml`));
assert(!/Disallow:\s*\//.test(read("robots.txt")), "Site must be crawlable");
assert(read("404.html").includes('content="noindex"'));
if (site.pathname === "/" && !site.hostname.endsWith(".github.io")) assert.equal(read("CNAME").trim(), site.hostname);
else assert(!existsSync(join(output, "CNAME")), "Project-path preview must not emit CNAME");
assert.equal(readFileSync(join(output, "social-preview.png")).readUInt32BE(16), 1200);
assert.equal(readFileSync(join(output, "social-preview.png")).readUInt32BE(20), 630);
const walk = (path) => readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)]);
const files = walk(output);
assert(files.every((file) => !/README|layout\.html|site\.json|\.mjs$|node_modules|docs\/internal/.test(file)), "Private/build source leaked into site");
console.log(`Site check passed: ${config.pages.length} pages, ${links} local links/assets, ${assets} CSS assets; unique metadata, schema, sitemap, fragments, and privacy checks`);
