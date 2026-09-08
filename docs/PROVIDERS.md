# Model accounts and provider requirements

BotHearth is an independent local application. It does not include model access, collect a BotHearth payment, or resell model usage. You authenticate with your own provider and remain responsible for its terms, limits, and charges. Checked on 2026-09-08; provider rules can change.

## Codex

Install the official Codex CLI and complete its native sign-in. The task runner invokes `codex exec --json` and configures BotHearth's task-scoped MCP tools. Remote device sign-in is described in [remote deployment](REMOTE-DEPLOY.md). BotHearth does not extract a ChatGPT session from your browser or implement its own subscription-token API.

OpenAI documents [non-interactive Codex execution](https://developers.openai.com/codex/noninteractive/) and [authentication](https://learn.chatgpt.com/docs/auth). These are technical integration interfaces; they do not waive account restrictions or guarantee plan eligibility. Review the applicable [OpenAI terms](https://openai.com/policies/row-terms-of-use/) and your workspace's policies. Other regions or business accounts may use different agreements.

## Claude Code

Install the unmodified official CLI and use native authentication. BotHearth invokes its documented print/stream-JSON interface; see [Claude Code setup](CLAUDE-CODE.md).

Anthropic's [legal guidance](https://code.claude.com/docs/en/legal-and-compliance) conditions running Claude Code in another product on its Commercial Terms, an unmodified binary with all native authentication methods retained, and end users authenticating and paying under their own agreements. It separately restricts third-party collection or mediation of Claude.ai credentials. This integration is not an Anthropic endorsement or permission to pool subscriptions.

## API adapters and local endpoints

Standalone adapters use the configured provider endpoint and credentials. Confirm model/tool-call compatibility and pricing yourself; the Chat Completions adapter does not support GPT-5.6 or newer. Local model servers are separately installed and licensed; model weights can have different terms from server software. See [configuration](CONFIG.md) and [extending BotHearth](EXTENDING.md).

## What your provider receives

Remote providers receive task instructions, model-visible messages, tool descriptions/results, and any submitted screenshots or snapshots. Native harnesses may retain their own histories and diagnostics. Provider data policies and account settings govern those copies; self-hosting BotHearth does not make remote inference offline. Details: [privacy](../PRIVACY.md).

## Website permissions and task limits

Only automate accounts and data you are authorized to use. A successful login, public page, or approval in BotHearth does not override a website's terms, data rights, or anti-bot rules. A policy override is a local software setting, not legal permission. Review external communications and irreversible actions before allowing them.

The harness meter estimates one cent per BotHearth computer-tool call; it is not the provider's bill. API estimates depend on configuration and may overshoot while a request is in flight. Set provider-side limits where available, and review the [security boundaries](../SECURITY.md) before relying on automation.
