# Contributing

Use Node.js 22.18 or newer. Install both dependency sets, then check your work:

```bash
npm ci
npm ci --prefix computer-server --ignore-scripts
npm run typecheck
npm run lint
npm run build
npm test
```

`npm test` runs the full suite, which uses real containers and the images described in
[QUICKSTART.md](docs/QUICKSTART.md). Docker tests serialize through `tests/docker-int/.lock`; do not prune containers belonging to other runs. `npm run test:unit` and `npm run test:contracts` are the narrower checks to run while you work, and they need no Docker. The optional host-browser check reports an explicit skip when Chromium is absent. Require it with `MODELBOT_TEST_REQUIRE_HOST_BROWSER=1 node --test tests/unit/computer-server/browser.test.ts`; release verification must also run `npm run test:docker-int` and the real-image takeover test so a skipped host check cannot stand in for browser evidence.

Building the macOS app is one command, and needs the Xcode Command Line Tools:

```bash
npm run app:mac        # writes apps/macos/build/ModelBot.app, ad-hoc signed
```

## Style

`npm run lint` is Biome with a small rule set, and it must stay green. Formatting is **not** enforced repo-wide: the tree predates Biome, so `npm run format:check` still reports pre-existing differences. Run `npm run format` on files you are already changing rather than reformatting anything else — a formatting-only diff makes a change hard to review.

Keep changes small, use existing helpers and Node built-ins, and leave a runnable check for changed behavior. Read [architecture](docs/ARCHITECTURE.md) and the relevant [decisions](docs/DECISIONS.md) when changing a trust boundary. [Extending BotHearth](docs/EXTENDING.md) covers the supported seams: adding a model provider, adding a connector, writing an extension, and customising policy. Verify behavior against current code and tests.

Regenerate CLI/config references with `npm run docs:gen`. Run `npm run claim-scan` after changing launch copy. Keep examples executable and distinguish measured results from planned work. Never commit real credentials, private task data, or browser profiles.

For a clean source-release candidate, run `node scripts/export-public.mjs /tmp/bothearth-review` with a new directory outside the checkout. It copies allowlisted source files, refuses symlinks and overwrites, and writes `PUBLIC_EXPORT.json` with file hashes and targeted scan results. Run `node scripts/export-public.mjs --self-test` to check the selector/scanner. Review screenshots and provenance separately; the scanner is not a complete secret or copyright audit. Publishing is a separate step.

## Sign-off

BotHearth is source-available under [PolyForm Noncommercial 1.0.0](LICENSE), free for its permitted noncommercial uses. The current launch has no paid offering; see [license and costs](COMMERCIAL.md). Contributions are made under the [contributor licence agreement](CLA.md). Sign every commit with `git commit -s`, which appends a `Signed-off-by` line; this project's trailer means you agree to the CLA, not merely the separate Developer Certificate of Origin used by some projects. You keep your copyright; the author gets a perpetual licence to use, sublicense and relicense the contribution, including under commercial terms.

Identify copied or adapted code, fonts, images, generated assets, and their source/license in the pull request. Keep required attribution and update [third-party notices](THIRD_PARTY_NOTICES.md). Submit only work you have the right to contribute, including any required employer permission. AI assistance does not establish ownership of matching third-party material; check provenance and review the result. Do not include third-party private data in examples or screenshots.
