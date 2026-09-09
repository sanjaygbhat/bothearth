import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
test("static site builds and checks both the custom domain and a Pages project path", () => {
  const run = (script: string, site: string, enterprise = "", contact = "") => {
    const result = spawnSync(process.execPath, [script], {
      cwd: root, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, SITE_URL: site, SITE_ENTERPRISE_URL: enterprise, SITE_CONTACT_URL: contact },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  };
  const config = JSON.parse(readFileSync(new URL("../../../website/site.json", import.meta.url), "utf8"));
  try {
    for (const site of [config.url, "https://sanjaygbhat.github.io/bothearth/"]) {
      run("scripts/build-site.mjs", site);
      run("scripts/check-site.mjs", site);
    }
    run("scripts/claim-scan.ts", config.url);
    const terms = readFileSync(new URL("../../../.site-build/terms/index.html", import.meta.url), "utf8");
    assert.match(terms, /US\$49/);
    assert.match(terms, /<del>US\$99<\/del>/);
    assert.match(terms, /limited-time introductory price/i);
    assert.match(terms, /over 50% below the planned standard price/i);
    assert.match(terms, /modified, rebranded/);
    assert.match(terms, /never grants resale or sublicensing/);
    assert.match(terms, /without output royalties/);
    assert.match(terms, /no obligation to provide support, maintenance, fixes, security patches/);
    assert.match(terms, /Upon confirmed payment/);
    const permission = readFileSync(new URL("../../../COMMERCIAL.md", import.meta.url), "utf8");
    assert.match(permission, /no ownership of outputs/);
    assert.match(permission, /Buying more US\$49 licences does not grant them/);
    const enterprisePage = new URL("../../../.site-build/enterprise/index.html", import.meta.url);
    assert.match(readFileSync(enterprisePage, "utf8"), /Online claims are not open yet/);
    assert.match(readFileSync(enterprisePage, "utf8"), /without registration/);
    const privacyPage = new URL("../../../.site-build/security/index.html", import.meta.url);
    assert.match(readFileSync(privacyPage, "utf8"), /online certificate claims are not open yet; contact submission is not open yet/);
    run("scripts/build-site.mjs", config.url, "https://enterprise.bothearth.com");
    run("scripts/check-site.mjs", config.url, "https://enterprise.bothearth.com");
    assert.match(readFileSync(enterprisePage, "utf8"), /href="https:\/\/enterprise.bothearth.com\/">Claim your free licence/);
    assert.match(readFileSync(privacyPage, "utf8"), /online certificate claims are enabled; contact submission is not open yet/);
    run("scripts/build-site.mjs", config.url, "", "https://contact.example.org/enquiry");
    run("scripts/check-site.mjs", config.url, "", "https://contact.example.org/enquiry");
    const contactPage = readFileSync(new URL("../../../.site-build/contact/index.html", import.meta.url), "utf8");
    assert.match(contactPage, /action="https:\/\/contact.example.org\/enquiry"/);
    assert(!contactPage.includes('<fieldset disabled>'));
    assert.match(readFileSync(privacyPage, "utf8"), /online certificate claims are not open yet; contact submission is enabled/);
    for (const contact of ["https://forms.example.org/owner%40example.org", "https://forms.example.org/?recipient=owner", "http://forms.example.org/send"]) {
      const invalid = spawnSync(process.execPath, ["scripts/build-site.mjs"], { cwd: root, encoding: "utf8", timeout: 30_000, env: { ...process.env, SITE_CONTACT_URL: contact } });
      assert.notEqual(invalid.status, 0, "Unsafe or email-bearing contact endpoint must be rejected");
    }
    for (const enterprise of ["http://enterprise.bothearth.com", "https://user:password@example.com", "https://example.com/path", "https://example.com/?token=secret"]) {
      const invalidEnterprise = spawnSync(process.execPath, ["scripts/build-site.mjs"], {
        cwd: root, encoding: "utf8", timeout: 30_000,
        env: { ...process.env, SITE_URL: config.url, SITE_ENTERPRISE_URL: enterprise },
      });
      assert.notEqual(invalidEnterprise.status, 0, "Unsafe enterprise URL must be rejected");
    }
    const invalid = spawnSync(process.execPath, ["scripts/build-site.mjs"], {
      cwd: root, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, SITE_URL: "https://example.com/?tracking=1" },
    });
    assert.notEqual(invalid.status, 0, "Query-bearing canonical URL must be rejected");
  } finally {
    run("scripts/build-site.mjs", config.url, process.env.SITE_ENTERPRISE_URL || "", process.env.SITE_CONTACT_URL || "");
  }
});
