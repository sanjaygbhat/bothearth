# Third-party components

Reviewed against this source checkout on 2026-09-08. This inventory identifies known components and redistribution requirements; it is not a complete license audit of a built operating-system image. The [BotHearth license](LICENSE) does not replace or restrict upstream rights in separately licensed components.

## Code and assets included in this repository

| Component | Where it is used | License and notice |
|---|---|---|
| CopilotKit OpenBot | Browser live view/key handling, shell tools, proxy hostname rules, MCP result parsing, scheduling description, model reasoning options | MIT; copyright and full permission text in [NOTICE](NOTICE). [Upstream license](https://github.com/CopilotKit/OpenBot/blob/main/LICENSE). |
| Moby v27.3.1 | Modified `sandbox/seccomp-chromium.json`; changed clone/unshare/chroot permissions for Chromium | Apache-2.0; [license](sandbox/Moby-LICENSE.txt), [upstream notice](sandbox/Moby-NOTICE.txt), [changes](sandbox/README-seccomp.md). [Exact upstream version](https://github.com/moby/moby/tree/v27.3.1/profiles/seccomp). |
| Fraunces | UI and website fonts; lettering in the brand assets | SIL OFL-1.1; [font license](src/ui/fonts/Fraunces-OFL.txt), also copied into `website/fonts/`. Preserve the font notice when serving the font files. |
| Gradle wrapper | Android build launcher and wrapper JAR | Apache-2.0; wrapper scripts retain upstream headers. The Apache text is included in [Moby-LICENSE.txt](sandbox/Moby-LICENSE.txt); [Gradle's upstream license](https://github.com/gradle/gradle/blob/v8.13.0/LICENSE). The downloaded Gradle distribution has additional components and notices. |
| JSON Canonicalization Scheme vectors | `tests/fixtures/jcs/input`, `output`, and RFC 8785 number samples | Anders Rundgren's vectors use Apache-2.0; RFC samples carry IETF attribution. See [NOTICE](NOTICE), [vector provenance](tests/fixtures/jcs/SOURCE.txt), and the [upstream license](https://github.com/cyberphone/json-canonicalization/blob/master/LICENSE). |

## Dependencies installed during a build

The lockfiles pin npm packages. They are installed from their publishers rather than included as source copies in the repository.

| Direct component | Locked version | Declared license |
|---|---|---|
| `@modelcontextprotocol/sdk` | 1.30.0 | MIT |
| `yaml` | 2.9.0 | ISC |
| `playwright`, `playwright-core` | 1.59.1 | Apache-2.0 |
| TypeScript (build tool) | See lockfiles | Apache-2.0 |
| `@types/node` (build types) | See lockfiles | MIT |
| Biome (development tool) | 2.5.12 | MIT OR Apache-2.0 |

The root lockfile's runtime entries declare MIT, ISC, BSD-2-Clause, or BSD-3-Clause. The computer-server lockfile adds Playwright's Apache-2.0 entries and an optional MIT `fsevents` package. This is package metadata, not proof that each transitive file was reviewed. Inspect and preserve each installed package's own `LICENSE`, `NOTICE`, and third-party notice files before distributing a bundle; an SPDX label or this table is not a substitute for them.

## Container images and native application bundles

Images install Debian packages, Node.js, and, in the browser image, Playwright and Chromium. These include separately licensed software and may include GPL/LGPL components. The final contents depend on the image build, architecture, and package repository state.

Retain `/usr/local/node/LICENSE`, dependency license/notice files, `/usr/share/doc/*/copyright`, and `/usr/share/common-licenses`. Debian documents its notice layout in [copyright information](https://www.debian.org/doc/debian-policy/ch-docs.html#copyright-information). Node's distribution also carries licenses for its bundled components; see [Node 22.23.2 LICENSE](https://github.com/nodejs/node/blob/v22.23.2/LICENSE).

Before publishing prebuilt images or native bundles:

1. Inventory the exact shipped files and dependency versions, including Chromium and downloaded runtimes.
2. Include BotHearth's license and required notices and all applicable upstream notices with the artifact.
3. Satisfy any corresponding-source obligations for GPL/LGPL components using an appropriate method for the actual license and distribution. A link to this repository alone does not supply Debian, Chromium, or Node component sources.
4. Review the finished artifact. A successful application test does not establish license compliance.

This source launch does not claim that prebuilt image, signed native-app, or app-store distribution has passed those checks. Operators building for their own use and people redistributing binaries have different obligations.

## External services and optional tools

BotHearth does not distribute Codex, Claude Code, Docker Desktop, OrbStack, model weights, cloud accounts, or a paid model entitlement. Their own licenses, account terms, and usage policies apply. See [provider requirements](docs/PROVIDERS.md) and [license and costs](COMMERCIAL.md). Preserve provider authentication and do not pool or resell end-user accounts.

Report an attribution omission privately to [Sanjay Bhat](mailto:sanjaygbhat@gmail.com), identifying the file, original source, license, and relevant version.
