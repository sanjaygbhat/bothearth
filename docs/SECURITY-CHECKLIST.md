# Release security verification

This is a checklist for the exact revision and artifacts being released, not a claim that every check has passed. Record the commit, OS, architecture, container runtime, image IDs, command output, and any skipped checks. The application is pre-release; see [security boundaries](../SECURITY.md).

## Automated checks

From a clean checkout with Node.js 22.18 or newer:

```sh
npm ci
npm ci --prefix computer-server --ignore-scripts
npm run typecheck
npm run lint
npm run build
npm run test:unit
npm run test:contracts
```

With a working runtime and images built by `bothearth image build`, run:

```sh
npm run test:docker-int
bash scripts/image-smoke.sh
bash scripts/egress-bypass.sh
```

Use [contributing](../CONTRIBUTING.md) for the full suite and required real-browser takeover evidence. A skipped host-browser test or mock transport does not establish container isolation or human-control privacy. No `modelbot security audit` command is implemented; do not use historical references to it as release evidence.

## Verify the boundaries

| Boundary | Evidence required |
|---|---|
| Host/container | Browser and shell run without root, extra capabilities, host namespaces, engine socket, or unintended mounts; Chromium starts with its sandbox enabled |
| Network | Browser and shell cannot reach private/metadata addresses or leave by an unintended route; document the bypass cases actually tested |
| Operator/model | MCP token cannot approve, create operator sessions, watch human-control frames, or administer computers; reject invalid origins and CSRF |
| Human control | Model actions/capture stop before grant; operator input stays out of task/audit records; expiry pauses; stale input and post-revocation frames are rejected |
| Files/profile | Workspace path jail rejects escapes; shell cannot read browser cookies; downloads stay in quarantine until promotion |
| Vault/audit | Vault opens under the intended key provider; wrong keys fail without overwrite; audit corruption is detected; backups preserve the chain head and key access |
| Effects and costs | Sensitive-effect requests bind their approval; limits pause work; clearly distinguish tool estimates from provider spending controls |
| Supply chain | Lockfiles install, third-party notices remain in final artifacts, and copied/generated assets have recorded provenance |

## Manual release checks

Perform a harmless task through each advertised harness, review its saved result, acquire and return human control, restart the daemon, revoke a second paired device, and confirm cancellation does not automatically replay an external action. Treat each supported OS/architecture and real remote/mobile deployment as a separate validation claim.

Verify a monitored private reporting route, inspect release archives for private data, and review [third-party redistribution requirements](../THIRD_PARTY_NOTICES.md). Automatic transcript deletion, encrypted browser profiles, signed/notarized native builds, and comprehensive provider/site legal clearance are not implemented or established by this checklist.
