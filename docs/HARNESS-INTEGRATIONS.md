# Harness connections

BotHearth exposes a computer through MCP. The harness supplies the model and its own authentication; BotHearth does not replay consumer OAuth credentials. Use the [quickstart](QUICKSTART.md) to start the daemon. This manual integration is separate from connecting an account in the task workspace.

## Generate a connection

From a built source checkout:

```bash
node dist/cli/index.js connect codex --print
node dist/cli/index.js connect codex
```

`--print` previews without writing. The writer updates only the BotHearth entry, preserves other configuration, and backs up an existing file before replacement. Restart the harness after changing its configuration. `--remove` removes the entry; `--config PATH` chooses a different file.

| Harness | Default configuration |
|---|---|
| Codex | `$CODEX_HOME/config.toml`, otherwise `~/.codex/config.toml`; `--codex-home DIR` selects an alias's home |
| Claude Code | `.mcp.json` in the current directory |
| Gemini | `$GEMINI_CONFIG_DIR/settings.json`, otherwise `~/.gemini/settings.json` |
| Cursor | `~/.cursor/mcp.json` |
| OpenCode | `opencode.json` in the current directory |
| Copilot | `$COPILOT_HOME/mcp-config.json`, otherwise `~/.copilot/mcp-config.json` |

These are the six implemented configuration writers. Generated entries use `http://127.0.0.1:7777/mcp` and reference `MODELBOT_TOKEN`; they never embed the token itself. If your daemon uses another port, update the generated URL. For remote hosts, use a local SSH tunnel to the daemon and point the harness at the forwarded loopback port.

For a Codex alias with a separate home, pass its actual directory:

```bash
node dist/cli/index.js connect codex --codex-home "$HOME/.codex2" --print
node dist/cli/index.js connect codex --codex-home "$HOME/.codex2"
```

Connection setup does not choose a model or launch the harness. Check the harness's own configuration and installed version, and review [provider requirements](PROVIDERS.md). Generated recipes are not a compatibility guarantee.

## Token and task binding

Generated configurations read `MODELBOT_TOKEN` from the harness environment. Load it in the terminal that starts your harness:

```bash
export MODELBOT_TOKEN="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.env.HOME+"/.modelbot/tokens.json","utf8")).mcp_token)')"
```

Adjust the path if you initialized with `--home`. Never put a bootstrap URL or UI cookie in harness configuration.

Create a browser under **Advanced → Computers**. The manual `/mcp` connection requires exactly one running computer. Before using its tools, create a task through the authenticated operator API: POST `/api/v1/harness-bindings` with `task_id`, `computer_id`, `execution: "harness"`, non-negative `spend_cap_usd`, and positive `max_steps`. Operator requests require the UI session cookie and CSRF token; the MCP token cannot create this binding. The task-workspace composer runs its configured agent and is not a manual harness selector.

## Stdio bridge

For a harness that uses stdio, configure its command as `node`, with arguments `/absolute/path/to/ModelBot/dist/cli/index.js` and `mcp-stdio`. The bridge requires `MODELBOT_TOKEN` in its environment and connects to the existing daemon; it does not start one. `MODELBOT_ENDPOINT` can override the default loopback MCP URL. There is no separate `modelbot-mcp` binary.

## Verify the boundary

After creating the operator task binding, give the harness its task and computer identifiers. Verify a public navigation and snapshot before attempting login. During takeover, model tools must return `E_TAKEOVER_BUSY`; only the authenticated operator UI receives live frames and controls the browser. Release control before asking the harness to continue.

The MCP token cannot approve requests, create computers, or open operator live view. Keep bootstrap URLs, UI cookies, and credentials out of harness prompts and configuration. An MCP connection does not restrict the harness's separate host shell or filesystem privileges.

Use [troubleshooting](TROUBLESHOOTING.md) for connection failures; test a small task through your actual model connection before relying on the integration. A generated configuration or mock test pass does not demonstrate task success on that harness.

For sequential tasks on one computer, finish with `done` or cancel the task through the operator API, then POST a new, unique task ID to `/api/v1/harness-bindings`. Active tasks cannot be rebound. Prior budgets and approvals remain in task history; domain consent does not carry into the next task.


## Non-interactive research harnesses

The 9 September 2026 VM trial used the locally signed-in Codex CLI through an SSH tunnel; provider authentication files were not copied to the VM. The daemon, Chromium and task files ran on the VM. This topology needs the local harness and tunnel to remain running; it does not demonstrate laptop-independent model execution.

Recent Codex versions can require their own MCP tool approval before a call reaches BotHearth. For an explicitly authorised, unattended research job, configure only the browser-reading and output-writing tools needed by that job through `mcp_servers.<id>.enabled_tools` and the corresponding per-tool approval settings. Keep BotHearth's operator domain/action approvals enabled. Do not blindly grant an arbitrary MCP server all tools or disable the harness's host sandbox. See the [official configuration reference](https://developers.openai.com/codex/config-reference/). No user-wide configuration change is required for a one-off `codex exec -c ...` invocation.

MCP HTTP request bodies are limited to 1 MiB, including JSON/base64 overhead. Write larger deliverables in smaller `write_file` append chunks within the tool's total file-size limit.
