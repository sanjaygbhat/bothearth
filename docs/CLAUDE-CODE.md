# Use your own Claude Code

In **Settings → AI connection**, choose **Claude Code**, then use its existing login or start its native sign-in. Subscription and Anthropic Console sign-in remain separate choices. Install the official `claude` binary first. Leave the model field empty to keep Claude Code’s configured default, or explicitly enter a model override. BotHearth does not bundle a modified binary or import Anthropic credentials. Each user configures their own API key, cloud provider or credential helper through Claude Code's documented setup. Do not paste Anthropic tokens into BotHearth.

Tasks use the installed CLI's documented `--print --output-format stream-json` interface. BotHearth supplies only its task-scoped MCP server and disables built-in model tools for these browser tasks. User hooks are disabled with the documented `disableAllHooks` setting; no built-in subagent tool is enabled. Native authentication helpers and administrator-managed policy remain Claude Code's responsibility, outside the browser sandbox. Keep those settings trusted; this process is not an operating-system sandbox. MCP approval, human control, tool budgets, cancellation and canonical `done` remain enforced by BotHearth. A successful CLI exit alone does not complete a task. Usage limits and any charges are your provider account's responsibility; BotHearth's tool-proxy meter is not an Anthropic spending cap.

## Terms and current limits

See [provider requirements](PROVIDERS.md) for the dated account and integration conditions. The official [programmatic interface](https://code.claude.com/docs/en/headless) documents `claude -p`; [authentication](https://code.claude.com/docs/en/authentication) remains owned by the native CLI. Check your account's current allowances before use. BotHearth does not guarantee included or unlimited usage, an unchanged quota, or an Anthropic spending cap.

For an interactive workflow, open official Claude Code yourself and connect BotHearth using [Claude Code's MCP instructions](https://code.claude.com/docs/en/mcp) and BotHearth's [harness setup](HARNESS-INTEGRATIONS.md). Native permission prompts stay in Claude Code.

The installed CLI is host code, even when it controls a container. Its native helpers, environment, managed hooks, and local history have separate privileges and retention. BotHearth does not override administrator policy or prevent a compromised host process from reading the host. See [security](../SECURITY.md) and [privacy](../PRIVACY.md).
