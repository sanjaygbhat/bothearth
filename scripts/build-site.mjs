#!/usr/bin/env node
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "website");
const output = join(root, ".site-build");
const config = JSON.parse(readFileSync(join(source, "site.json"), "utf8"));
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const site = new URL(process.env.SITE_URL || config.url);
const repository = new URL(process.env.SITE_REPOSITORY || config.repository);
for (const url of [site, repository]) {
  assert(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash,
    "Site and repository URLs must be HTTPS without credentials, a query, or a fragment");
}
site.pathname = `${site.pathname.replace(/\/$/, "")}/`;
const enterprise = process.env.SITE_ENTERPRISE_URL ? new URL(process.env.SITE_ENTERPRISE_URL) : null;
if (enterprise) assert(enterprise.protocol === "https:" && !enterprise.username && !enterprise.password && !enterprise.search && !enterprise.hash && enterprise.pathname === "/",
  "SITE_ENTERPRISE_URL must be an HTTPS origin without credentials, path, query, or fragment");
const contact = process.env.SITE_CONTACT_URL ? new URL(process.env.SITE_CONTACT_URL) : null;
if (contact) assert(contact.protocol === "https:" && !contact.username && !contact.password && !contact.search && !contact.hash && !decodeURIComponent(contact.pathname).includes("@"), "SITE_CONTACT_URL must be an HTTPS form endpoint without credentials, email addresses, query, or fragment");
const repo = repository.href.replace(/\/$/, "");
const escape = (value) => String(value).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const template = readFileSync(join(source, "layout.html"), "utf8");
const nav = [["how-it-works", "How it works"], ["examples", "What it can do"], ["faq", "FAQ"], ["enterprise", "Enterprise"]];
const pages = config.pages;
assert.equal(new Set(pages.map((page) => page.slug)).size, pages.length, "Duplicate page slug");
const author = { "@type": "Organization", "@id": `${site.href}#project`, name: "BotHearth", url: site.href };
for (const page of pages) {
  assert(/^(?:[a-z0-9]+(?:-[a-z0-9]+)*)?$/.test(page.slug), "Invalid page slug");
  assert(/^[a-z-]+\.html$/.test(page.file), "Invalid page source");
  const canonical = new URL(page.slug ? `${page.slug}/` : "", site).href;
  const graph = [{ "@type": "WebSite", "@id": `${site.href}#website`,
    name: config.name, url: site.href, inLanguage: "en", publisher: author },
  { "@type": "WebPage", "@id": `${canonical}#page`, url: canonical,
    name: page.title, description: page.description, inLanguage: "en",
    isPartOf: { "@id": `${site.href}#website` }, author,
    dateModified: config.reviewed }];
  if (!page.slug) graph.push({ "@type": "SoftwareApplication", "@id": `${site.href}#software`,
    name: config.name, alternateName: "ModelBot", url: site.href,
    description: page.description,
    applicationCategory: "ProductivityApplication", operatingSystem: "macOS, Linux",
    softwareVersion: version, releaseNotes: `${site.href}about/#release`,
    softwareRequirements: "Node.js 22.18+, supported container runtime, and an eligible model account",
    license: `${repo}/blob/main/LICENSE`, author,
    downloadUrl: repo, screenshot: `${site.href}screenshots/email-inbox-redacted.png` });
  const values = { TITLE: escape(page.title), DESCRIPTION: escape(page.description),
    CANONICAL: escape(canonical), SITE: escape(site.href), BASE: escape(site.pathname),
    REPOSITORY: escape(repo), VERSION: escape(version), DATE: escape(config.reviewed),
    ENTERPRISEACTION: enterprise ? `<a class="button" href="${escape(enterprise.href)}">Claim your free licence →</a>` : `<p class="qualification">Online claims are not open yet. <a href="${escape(site.pathname)}quickstart/">Use the free business permission now</a>.</p>`,
    CLAIMINTRO: enterprise ? '<p>Use your work email to record the organisation’s existing free allowance. Verification proves mailbox access, not legal authority.</p>' : '<p>Online certificate claims are not open yet. You can use the published free business permission now, without registration. The steps below describe the certificate flow when enabled.</p>',
    SERVICESTATUS: `<p><strong>Current availability:</strong> online certificate claims ${enterprise ? 'are enabled' : 'are not open yet'}; contact submission ${contact ? 'is enabled' : 'is not open yet'}. The following describes the service data flows when enabled.</p>`,
    ENTERPRISECONTACT: `<a class="button" href="${escape(site.pathname)}contact/">Contact us</a>`,
    CONTACTACTION: contact ? `action="${escape(contact.href)}"` : '',
    CONTACTSTATE: contact ? '' : 'disabled',
    CONTACTNOTICE: contact ? '<p>We’ll reply to the email you provide.</p>' : '<p role="status">Contact submission is not open yet. This form cannot send a message. The free business permission is available without contacting us.</p>',
    NAV: nav.map(([slug, label]) => `<a href="${escape(`${site.pathname}${slug}/`)}"${slug === page.slug ? ' aria-current="page"' : ""}>${label}</a>`).join(""),
    SCHEMA: JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c") };
  const render = (html) => html.replace(/\{\{([A-Z]+)\}\}/g, (_, key) => {
    assert(Object.hasOwn(values, key), `Unknown template key ${key}`);
    return values[key];
  });
  values.CONTENT = render(readFileSync(join(source, page.file), "utf8"));
  values.IMAGEVIEWER = values.CONTENT.includes("<img ") ? `<script src="${escape(site.pathname)}image-viewer.js" defer></script>` : "";
  const destination = join(output, page.slug);
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, "index.html"), render(template));
}
for (const file of ["tokens.css", "style.css", "image-viewer.js", "favicon.svg", "social-preview.png", "70df6a3860a46a46f4485513292e8249.txt",
  "fonts/fraunces-latin-wght.woff2", "fonts/Fraunces-OFL.txt",
  "screenshots/task-running.png", "screenshots/needs-you.png",
  "screenshots/email-inbox-redacted.png", "screenshots/email-organised-redacted.png"]) {
  mkdirSync(dirname(join(output, file)), { recursive: true });
  cpSync(join(source, file), join(output, file));
}
const urls = pages.map((page) => new URL(page.slug ? `${page.slug}/` : "", site).href);
writeFileSync(join(output, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url><loc>${escape(url)}</loc><lastmod>${config.reviewed}</lastmod></url>`).join("\n")}\n</urlset>\n`);
writeFileSync(join(output, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${site.href}sitemap.xml\n`);
writeFileSync(join(output, ".nojekyll"), "");
// Keep old bookmarks usable after retiring the separate review page.
mkdirSync(join(output, "security-review"), { recursive: true });
writeFileSync(join(output, "security-review/index.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0;url=${escape(site.pathname)}security/"><title>BotHearth security</title><p><a href="${escape(site.pathname)}security/">Security and privacy</a></p></html>\n`);
// CNAME is useful for branch hosts; Actions Pages still needs repository domain settings.
const cname = join(output, "CNAME");
if (site.pathname === "/" && !site.hostname.endsWith(".github.io")) {
  writeFileSync(cname, `${site.hostname}\n`);
} else if (existsSync(cname)) unlinkSync(cname);
writeFileSync(join(output, "404.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Page not found — BotHearth</title><link rel="stylesheet" href="${escape(site.pathname)}tokens.css"><link rel="stylesheet" href="${escape(site.pathname)}style.css"><main class="wrap page-header"><p class="eyebrow">404</p><h1>This room is empty.</h1><p class="lead">That page could not be found. <a href="${escape(site.pathname)}">Return to BotHearth</a> or open the <a href="${escape(site.pathname)}quickstart/">quickstart</a>.</p></main></html>\n`);
console.log(`Built ${pages.length} pages in .site-build for ${site.href}`);
