# Current project decisions

Reviewed 2026-09-08. This page records the present launch scope; earlier planning and commercial research are not product promises.

- **Free noncommercial source release.** The current [license](../LICENSE) is PolyForm Noncommercial 1.0.0. No payment flow, paid plan, hosted reseller service, or bundled model entitlement is part of this launch. The noncommercial restriction means the project is source-available, not OSI open source. A future license change needs an explicit owner decision and rights review.
- **Host daemon, separate computer.** The daemon runs on the operator's host or VM host. Browser, shell, and egress proxy run in separate containers. No Docker socket is mounted into the computer. The configured workspace is intentionally a host folder; the everyday browser profile is not shared.
- **One operator.** Paired devices share operator authority. This is not a multi-tenant service or an access-control system for mutually untrusted users.
- **Bounded schedules.** Each routines database permits at most 20 enabled routines (`MAX_ENABLED_ROUTINES`). Disabled routines may remain stored; creating or enabling a routine beyond the cap is rejected.
- **Native model authentication.** Use installed, unmodified official harnesses or a separately configured API adapter. Never collect, pool, or replay consumer browser session tokens. Provider terms remain applicable.
- **Visible control.** Approvals are enforced at tool dispatch. Human takeover blocks model capture and ordinary actions; expiry pauses. Detection is incomplete and users must review sensitive work.
- **Conservative claims.** Domain policy is best effort. No promise of complete prompt-injection prevention, guaranteed account safety, fully local data, actual subscription cost accounting, or universal model/site compatibility.
- **Build from source.** Node.js 22.18 or newer; TypeScript and existing dependencies. No published npm package, prebuilt images, signed native downloads, or app-store availability is claimed.
- **Own the operating costs.** Model access, hardware, optional VPS/domain, and other services belong to the operator. Task meters are estimates, not external billing controls.

The [architecture](ARCHITECTURE.md), [quickstart](QUICKSTART.md), [provider requirements](PROVIDERS.md), [security](../SECURITY.md), and [privacy](../PRIVACY.md) describe these decisions in use. Historical development records are retained privately by the maintainer.
