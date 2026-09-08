# Documentation

New here? [Quickstart](QUICKSTART.md) takes you from a fresh checkout to your first task: build it, `bothearth start`, and open the printed link in your browser. The Mac app is an optional shell over the same thing.

[CLI.md](CLI.md) and [CONFIG.md](CONFIG.md) are generated from the implementation and the schema. Run `npm run docs:gen` rather than editing them by hand.

## Using BotHearth

| Topic | Document |
|---|---|
| Build it and run your first task | [Quickstart](QUICKSTART.md) |
| Something is broken | [Troubleshooting](TROUBLESHOOTING.md) |
| What a task may spend, and the limits on a long one | [Quickstart](QUICKSTART.md#what-a-task-is-allowed-to-spend) |
| The optional Mac app: building, signing, how the shell works | [apps/macos/README.md](../apps/macos/README.md) |
| Every command | [CLI reference](CLI.md) |
| Every configuration key | [Configuration reference](CONFIG.md) |
| Connecting Claude Code | [Claude Code](CLAUDE-CODE.md) |
| Model accounts, authentication, and provider terms | [Provider requirements](PROVIDERS.md) |
| Running with Docker Compose | [Compose](COMPOSE.md) |
| Running on a machine you rent | [Remote deployment](REMOTE-DEPLOY.md), [remote clients](REMOTE-CLIENT.md) |
| Driving BotHearth from your own coding harness | [Harness integrations](HARNESS-INTEGRATIONS.md) |
| Phone and tablet clients | [Native clients](../mobile/README.md) |

## Boundaries and data

| Topic | Document |
|---|---|
| Trust boundaries, reporting a vulnerability | [SECURITY.md](../SECURITY.md) |
| What is stored, where, and for how long | [PRIVACY.md](../PRIVACY.md) |
| Pre-release security checks | [Security checklist](SECURITY-CHECKLIST.md) |
| Third-party code, fonts, and redistribution | [Third-party notices](../THIRD_PARTY_NOTICES.md) |

## Licence

BotHearth is free for the purposes permitted by [PolyForm Noncommercial 1.0.0](../LICENSE). It is source-available, not OSI open source. There is no paid offering in this launch. [License and costs](../COMMERCIAL.md) explains the scope and separate provider costs. Contributors sign off under the [CLA](../CLA.md).

## Contributing

| Topic | Document |
|---|---|
| How to contribute | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| How the pieces fit together | [Architecture](ARCHITECTURE.md) |
| Why the design is the way it is | [Decisions](DECISIONS.md) |
| Adding providers, connectors, extensions and policy | [Extending BotHearth](EXTENDING.md) |

Historical build evidence, research, and business planning are retained privately by the maintainer. Public claims should be checked against this documentation and reproducible tests.
