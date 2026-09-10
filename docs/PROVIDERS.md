# Model accounts and provider requirements

BotHearth is an independent local application. It does not include model access, collect a BotHearth payment, or resell model usage. You authenticate with your own provider and remain responsible for its terms, limits, and charges. Checked on 2026-09-08; provider rules can change.

## Choosing a model

Home lets you choose a provider, a listed model or an exact custom model ID. BotHearth asks the installed CLI for its model catalog; cached and documented suggestions remain labelled when native discovery is unavailable. A listed model is not proof of account access or remaining quota. Connection status is shown separately, so signing out does not hide the selected model.

**Use subagents** is unchecked for each new task. Checking it reveals the optional **Subagent model** selection. The chosen provider/model and delegation setting are saved with the task; resuming it keeps that choice. Existing configured API installations retain their configured runner. See [first task](QUICKSTART.md#6-your-first-task) and [connection troubleshooting](TROUBLESHOOTING.md#model-not-connected-or-models-not-showing).

## Codex

The computer image includes the official Codex CLI. Connect it in **Settings → Model connection** using its native device sign-in; its login stays in the computer. New tasks invoke `codex exec --json` there, with stock native tools and task-scoped BotHearth MCP tools. **Use subagents** is unchecked for every new task; checking it lets you choose a subagent model. Historical host tasks keep their original host CLI/login. See [remote sign-in](REMOTE-DEPLOY.md#provider-login-on-the-vps). BotHearth does not extract a ChatGPT browser session or copy host credentials into the guest.

OpenAI documents [non-interactive Codex execution](https://developers.openai.com/codex/noninteractive/) and [authentication](https://learn.chatgpt.com/docs/auth). These are technical integration interfaces; they do not waive account restrictions or guarantee plan eligibility. Review the applicable [OpenAI terms](https://openai.com/policies/row-terms-of-use/) and your workspace's policies. Other regions or business accounts may use different agreements.

## Claude Code

The computer image includes the unmodified official CLI. Settings starts its native authentication inside the computer; tasks use its documented print/stream-JSON interface with stock native tools. See [Claude Code setup](CLAUDE-CODE.md).

Anthropic's [legal guidance](https://code.claude.com/docs/en/legal-and-compliance) conditions running Claude Code in another product on its Commercial Terms, an unmodified binary with all native authentication methods retained, and end users authenticating and paying under their own agreements. It separately restricts third-party collection or mediation of Claude.ai credentials. This integration is not an Anthropic endorsement or permission to pool subscriptions.

## API adapters and local endpoints

Standalone adapters use the configured provider endpoint and credentials. Confirm model/tool-call compatibility and pricing yourself; the Chat Completions adapter does not support GPT-5.6 or newer. Local model servers are separately installed and licensed; model weights can have different terms from server software. See [configuration](CONFIG.md) and [extending BotHearth](EXTENDING.md).

## What your provider receives

Remote providers receive task instructions, model-visible messages, tool descriptions/results, and any submitted screenshots or snapshots. Native harnesses may retain their own histories and diagnostics. Provider data policies and account settings govern those copies; self-hosting BotHearth does not make remote inference offline. Details: [privacy](../PRIVACY.md).

## Website permissions and task limits

Only automate accounts and data you are authorized to use. A successful login, public page, or approval in BotHearth does not override a website's terms, data rights, or anti-bot rules. A policy override is a local software setting, not legal permission. Review external communications and irreversible actions before allowing them.

The native meter estimates one cent per BotHearth MCP computer-tool call; it does not fully count stock CLI commands or model requests. Native shell/network tools also bypass MCP action checks. API estimates depend on configuration and may overshoot while a request is in flight. Set provider-side limits where available, and review the [security boundaries](../SECURITY.md) before relying on automation.
