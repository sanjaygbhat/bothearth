# Changelog

## Unreleased — 2026-09-12

### Fixed

- Google sign-in inside the bot's browser: Chromium no longer advertises automation while a person drives, so accounts.google.com accepts the sign-in form. A regression test pins the launch switch.
- A crashed tab no longer stops a task: the browser reopens the page itself and the model can restart the browser. The daemon also relaunches the browser after a crash or repeated timeouts.
- The first Start after a daemon restart no longer shows "Connect Codex before starting" while the runtime is still probing.
- Cancelling a task closes its open human-control holds.
- "Take control" works on a page that has stopped responding.
- Legacy configuration values written by an older template (`policy.kill_switch: true`, `sandbox.memory: 2g`, `sandbox.shm_size: 1g`) no longer silently override the current defaults; `config_version` marks files that were written on purpose.

### Changed

- The bot decides for itself when it needs a person. BotHearth no longer pauses tasks on its own for password, one-time-code, payment or CAPTCHA fields, and its prompts no longer tell the model when to ask. The optional "Ask before sensitive actions" setting is unchanged.
- Inside its computer the bot's shell now runs as the same user as its browser, with a display, so it can use and restart the browser from its shell. See SECURITY.md.
- The hold panel offers "Use a different Google account"; Settings → Computers lists signed-in sites and can forget this computer's logins.
- The kill switch is visible in Settings and on Home when it is on.
- Browser container defaults: 4 GiB memory, 2 GiB shared memory, up to 20 tabs.
- Daemon logs are written to `<data_dir>/logs/daemon.log`; `bothearth doctor` prints the path.

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
This is source-available, not OSI open source. The additional [business
permission](COMMERCIAL.md) covers one free business bot and commercial outputs.
Model accounts and infrastructure have separate terms and costs.

This alpha targets one operator and locally built computer images. It has no
published registry package, prebuilt image, notarized native app, security
certification, or guaranteed model-task success. Read [security](SECURITY.md),
[privacy](PRIVACY.md) and [provider requirements](docs/PROVIDERS.md) before use.
