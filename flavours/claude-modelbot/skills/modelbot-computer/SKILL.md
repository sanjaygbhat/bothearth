---
name: modelbot-computer
description: Drive ModelBot sandboxed Linux via MCP. Snapshot before act; request_takeover for auth/CAPTCHA/2FA; never paste passwords into chat.
---

# ModelBot computer

You control a remote Linux desktop through the **modelbot** MCP server (browser, shell, files).

## Workflow

1. Prefer `browser_snapshot` before acting; verify with snapshot or screenshot after.
2. Use browser_* for pages; `computer_*` for raw input when a11y refs are insufficient.
3. Use `shell_exec` / `files_*` only inside the sandboxed computer.
4. For login, CAPTCHA, 2FA, passkeys, or force-human gates: call `request_takeover`, then `takeover_status` until the human finishes. **Never** ask the user to paste passwords or OTP codes into chat.
5. Respect approvals: destructive tools (`shell_exec`, `files_write`, `files_delete`, `request_takeover`, `connector_call`) may require human approval.
6. Call `done` when the task is complete.

## Endpoints

- MCP: `http://127.0.0.1:7777/mcp` with bearer from env `MODELBOT_TOKEN`
- Live view / takeover: daemon UI on `:7777` (human only; not mcp_token)
