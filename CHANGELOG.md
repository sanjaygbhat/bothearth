# Changelog

## 0.0.1 alpha — 2026-09-08

The first BotHearth public source preview gives an AI agent a separate browser,
shell, and workspace on a macOS or Linux host. The operator can watch tasks,
review approval requests, and take human control of the browser.

### Included

- Source installation, task UI, task-scoped MCP, native Codex and Claude Code
  connections, configuration and troubleshooting documentation.
- The `bothearth` command alongside the compatible `modelbot` alias. Existing
  storage paths, configuration identifiers, image names and `ModelBot.app` remain.
- Seven static website pages at [bothearth.com](https://bothearth.com/), covering
  setup, architecture, security, examples, licence, costs and contributions.
- Public build checks and a source-export manifest. Optional native clients
  remain development builds; this release distributes source only.

### Fixed during release review

- Invalid HTTP request URLs or Host headers return an error without terminating
  the daemon.
- Full-URL origin patterns check the scheme and port as well as the host/path.
- Vault and routine commands follow configured storage paths and daemon overrides.
- Packed source includes the files needed by the Docker builds, and locally built
  images retain the required project and dependency notices.
- The default standalone OpenAI adapter model matches its Chat Completions support.
- Documentation describes actual approval, human-control, retention and cost limits.

### Release boundaries

Free for permitted noncommercial use under [PolyForm Noncommercial 1.0.0](LICENSE).
This is source-available, not OSI open source. There is no paid plan or commercial-use
grant in this release; model accounts and infrastructure have separate terms and costs.

This alpha targets one operator and locally built computer images. It has no
published registry package, prebuilt image, notarized native app, security
certification, or guaranteed model-task success. Read [security](SECURITY.md),
[privacy](PRIVACY.md) and [provider requirements](docs/PROVIDERS.md) before use.
