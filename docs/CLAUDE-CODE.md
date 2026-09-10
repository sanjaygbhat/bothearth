# Use your own Claude Code

In **Settings → Model connection**, choose **Claude Code**, then use its existing guest login or start its native sign-in. The computer image includes the unmodified official CLI. Subscription and Anthropic Console sign-in remain separate choices; private sign-in instructions and replies appear in Settings. Choose the model for your task. BotHearth does not copy host credentials into the computer; native API keys, cloud connections and credential helpers remain Claude Code’s configuration.

New tasks run the CLI’s documented `--print --output-format stream-json` interface inside the bot’s computer. Stock tools and guest configuration remain available alongside task-scoped BotHearth MCP tools. **Use subagents** is unchecked by default; checking it enables delegation and reveals the **Subagent model** choice. Native permission prompts are disabled inside the container. MCP action checks and usage estimates cover BotHearth calls, not every native shell/network operation. Human control freezes guest model processes and their tool children; cancellation stops them. A clean turn without `done` keeps the conversation open for your reply. Provider limits and charges still apply.

## Terms and current limits

See [provider requirements](PROVIDERS.md) for the dated account and integration conditions. The official [programmatic interface](https://code.claude.com/docs/en/headless) documents `claude -p`; [authentication](https://code.claude.com/docs/en/authentication) remains owned by the native CLI. Check your account's current allowances before use. BotHearth does not guarantee included or unlimited usage, an unchanged quota, or an Anthropic spending cap.

For an interactive workflow, open official Claude Code yourself and connect BotHearth using [Claude Code's MCP instructions](https://code.claude.com/docs/en/mcp) and BotHearth's [harness setup](HARNESS-INTEGRATIONS.md). Native permission prompts stay in Claude Code.

Historical host tasks resume with their original host CLI/login and existing tool restrictions. A manually connected host harness also keeps its independent host permissions. New guest sessions store authentication and history in the computer’s private model-home volume. See [security](../SECURITY.md) and [privacy](../PRIVACY.md).
