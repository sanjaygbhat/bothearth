# BotHearth website

Eleven substantive pages, rendered to static HTML with a small Node standard-library build. The informational site uses a small local script for accessible image previews, with no framework, analytics, checkout, or hosted agent service. Enterprise verification, certificate issuance, and enquiry delivery run in the separate [Node service](../enterprise/README.md). The agent daemon is a separate local application.

## Build and preview

From the repository root, with Node.js 22.18+:

```sh
npm run site:build
npm run site:check
npm run site:test
python3 -m http.server 4176 --bind 127.0.0.1 --directory .site-build
```

Open <http://127.0.0.1:4176/>. Stop the local preview server with Ctrl+C. The static build and checker require no dependency installation, Docker, model account, or product build. The enterprise integration test needs `npm ci`. They never touch product `dist/`.

`website/*.html` contains authored page fragments and the shared layout. `website/site.json` supplies page titles, descriptions, slugs, repository URL, canonical site URL, and the actual source-review date. The build copies only selected public assets to `.site-build/`, then emits sitemap, robots, 404, and domain files. Serve that output, not the source directory.

The static site test checks the custom domain and GitHub Pages project-path builds, plus rejection of a query-bearing canonical URL. The checker validates local links, fragments, repository document paths, CSS assets, unique metadata, schema, sitemap, image dimensions, and absence of remote runtime assets or unexpected scripts. With the preview server running and the existing computer-server Playwright dependency plus Chrome installed, run `node scripts/check-site-browser.mjs http://127.0.0.1:4176/` to check image opening, all three closing methods, keyboard focus and scroll restoration on desktop and mobile.

## URLs and branding

The configured canonical URL is `https://bothearth.com/`, the purchased project domain. The repository is `https://github.com/sanjaygbhat/bothearth`. A build does not configure DNS or publish either resource.

For a different deployment, override both generation and checks consistently:

```sh
SITE_URL=https://sanjaygbhat.github.io/bothearth/ npm run site:build
SITE_URL=https://sanjaygbhat.github.io/bothearth/ npm run site:check
```

`SITE_REPOSITORY` optionally overrides source links. HTTPS URLs must have no credentials, query, or fragment. Project-path builds receive the correct asset prefix and omit `CNAME`. A custom apex build emits `CNAME`; GitHub Actions Pages still requires the custom domain in repository settings.

The website uses a text/SVG BotHearth wordmark, the existing warm palette, a locally served Fraunces font, and system interface fonts. `social-preview.svg` is the editable 1200×630 vector source for the committed `social-preview.png`. No external font or image service is used.

The main page introduces BotHearth through a task, the agent's visible work, and its saved result. Keep setup requirements beside the entry point and detailed implementation/licence answers in the linked guides. The reading-log illustration is labeled as an example and uses the exact sample totals from the examples page.

The homepage and repository README use `email-inbox-redacted.png`, the actual 1440×900 inbox capture from the 8 September 2026 email organisation test. The About page and README also show the original completion capture, `email-organised-redacted.png`. Private inbox details, task narration and obsolete internal details are irreversibly blurred; other pixels, task durations and results are unchanged. The test took 51 min 6 s across two runs; the final run completed in 20 min 49 s. The approval screenshot `needs-you.png` and retained `task-running.png` asset are pre-rename captures from 7 September. Other historical screenshots are not deployed assets.

## Publish the informational site with GitHub Pages

GitHub Pages is available for public repositories on GitHub Free. Use the clean public source repository, not private development history. The [official custom-workflow guide](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) describes the hosting path.

1. In the public repository's **Settings → Pages**, choose **GitHub Actions** as the publishing source.
2. Verify the owned domain in the GitHub account's Pages settings using the exact TXT challenge GitHub supplies. In the repository's Pages settings, set the custom domain to `bothearth.com` before pointing DNS at Pages.
3. At Namecheap, configure the apex `@` A records to GitHub's published addresses: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`. If using `www`, point its CNAME to `sanjaygbhat.github.io`, with no repository path. Preserve unrelated records. Resolve conflicting parking records deliberately.
4. Run the **Website** workflow at `.github/workflows/pages.yml` on main. Pull requests build and check only; main pushes or a main-branch manual run can deploy. The uploaded artifact is only `.site-build/`. There is no daemon deployment or model credential.
5. After DNS validation and certificate issuance, enable **Enforce HTTPS** in Pages settings. Check apex and `www` behavior, canonical URLs, `/quickstart/`, `/sitemap.xml`, `/robots.txt`, and an unknown URL returning the 404 page.

Recheck the current [GitHub custom-domain instructions](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site) before changing DNS. The `CNAME` artifact alone is not sufficient for Actions-based hosting. Only the domain owner can complete account-side domain verification and DNS changes.

## Search and AI discovery

The site delivers complete text in the initial HTML response: setup, architecture/model connections, security/privacy boundaries, licence/costs, examples with checks, and named authorship. Each page has a distinct title and description, canonical URL, Open Graph metadata, and matching WebPage/WebSite structured data. Home adds a SoftwareApplication description without invented ratings, reviews, or an unrestricted free offer.

Sitemap dates describe the actual content review, not each rebuild. Update `reviewed` only when the public content is reviewed. Robots permits crawling. No special AI files or hidden keyword pages are required.

After the site is live, verify its Search Console property, submit the sitemap, inspect indexing, and check current generative-AI inclusion/reporting settings. Keep claim evidence and reproducible example results current. The [Google AI optimization guide](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide) is the primary reference; discoverability is not a promise of ranking or citation.

The [IndexNow verification file](70df6a3860a46a46f4485513292e8249.txt) is deliberately public proof of host control, separate from any account credential. After deployment, confirm that `https://bothearth.com/70df6a3860a46a46f4485513292e8249.txt` serves the exact key `70df6a3860a46a46f4485513292e8249` over HTTPS. Then submit one JSON POST to `https://api.indexnow.org/indexnow` with `host: "bothearth.com"`, that `key`, the public file URL as `keyLocation`, and a `urlList` containing only added, changed, or deleted canonical BotHearth URLs. The initial launch can submit the canonical page URLs in the sitemap. Use `Content-Type: application/json; charset=utf-8`.

Submit after the public change is deployed; unchanged URLs need no repeated notification. HTTP 200 acknowledges receipt, while 202 means key validation is pending. Neither proves crawling, indexing, ranking, or AI citation. Follow the [IndexNow protocol](https://www.indexnow.org/documentation) and its [official endpoint guidance](https://www.indexnow.org/faq).

## Licence and privacy

Project code and artwork follow the repository licence and notices. Fraunces retains its [SIL Open Font License](fonts/Fraunces-OFL.txt). This release is source-available under PolyForm Noncommercial plus the Business and Output Permission in COMMERCIAL.md. One business bot is free; certificates record that entitlement, and additional business bots cost US$49 each, once. Standard grants exclude commercial replication of the service, including modified copies. Outputs may be sold.

This static site adds no analytics or cookies. The host receives normal web request data under its own policy. The public security page distinguishes this website from the application's remote model, website, connector, and paired-device data flows.

## Enterprise entry point

Set the GitHub Actions repository variable `SITE_ENTERPRISE_URL` to the verified HTTPS origin of the deployed enterprise service, for example `https://enterprise.bothearth.com`. The builder validates it and adds sign-in links. Leave it unset until the service and real email delivery are verified; the page then explicitly says online claims are not open and links to the contact form. Set `SITE_CONTACT_URL` to a verified HTTPS form endpoint with an opaque ID (never an email-bearing URL), or deploy `enterprise/contact.mjs` and use its `/enquiry` endpoint. Without either, the contact form explicitly disables sending. Run the build and tests with the same variables. GitHub Pages hosts only static output and cannot run `enterprise/server.mjs`. Do not publish the licence database, environment files, or private enquiry records.
