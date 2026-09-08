# ModelBot golden task

You are driving a ModelBot **computer** through MCP tools only.
Do not use the host browser, shell outside ModelBot tools, or invent credentials.

| Field | Value |
| --- | --- |
| Task id | `{{task_id}}` |
| Computer | `{{computer_name}}` |
| Max steps | {{max_steps}} |
| Timeout (advisory) | {{timeout_sec}}s |
| Spend cap (USD, soft) | {{spend_cap_usd}} |

## Goal

{{goal}}

## Sites in scope

{{sites}}

## Acceptance

{{acceptance}}

## Tooling rules

1. Prefer `browser_navigate` → `browser_snapshot` → ref-based `browser_click` / `browser_type` / `browser_select`.
2. After stale-ref errors, re-snapshot; never reuse old refs.
3. Put downloadable / extracted artifacts under `/workspace` (host-visible). Prefer explicit paths from the task.
4. For captchas, WebAuthn, OTP, payment confirm, or unreadable canvas walls: call `request_takeover` with a clear reason and stop.
5. When the goal is met, call `done` once with a short summary. Do **not** call `done` on the spend-cap negative case — keep working until the harness/daemon stops you.
6. Stay inside listed sites unless the goal explicitly requires a redirect on the same demo host.

## Expected outcome class

`{{expect}}` — one of `complete` | `takeover` | `spend_cap`.
