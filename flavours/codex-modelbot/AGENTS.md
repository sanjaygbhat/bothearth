# ModelBot + Codex

This profile (`CODEX_HOME`) is isolated for ModelBot. Use the **modelbot** MCP server for all computer work.

- Snapshot before act; verify after.
- `request_takeover` hands the person the keyboard and mouse of the bot's computer and waits until they give it back.
- Approvals may prompt for gated tools; wait for the human.
- Tool timeouts are raised (`tool_timeout_sec = 300`); browser work can be slow.
- Skill: `$skill modelbot-computer` / skills under `skills/modelbot-computer/`.
