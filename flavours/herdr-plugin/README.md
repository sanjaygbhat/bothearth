# ModelBot Herdr plugin

Thin Herdr plugin for ModelBot: start/stop/status computers, open the live UI, and jump to pending takeovers. It talks to the ModelBot daemon on loopback (`127.0.0.1:7777`) using a UI session bootstrapped with your one-time bootstrap token. It is not a launch-catalogue flavour.

## Requirements

- Herdr ≥ 0.8.2 (`herdr --version`)
- Node.js ≥ 22
- ModelBot daemon running (`modelbot start`)
- Environment:
  - `MODELBOT_BOOTSTRAP_TOKEN` — same token the daemon was started with
  - optional `MODELBOT_BASE_URL` (default `http://127.0.0.1:7777`)
  - optional `MODELBOT_COMPUTER_ID` for start/stop when you do not pass `--computer`

## Install (dev link)

From the ModelBot repo:

```bash
herdr plugin link "$PWD/flavours/herdr-plugin"
herdr plugin list
```

You should see `modelbot` listed and enabled.

## Actions

```bash
# Snapshot (JSON): computers, tasks, takeovers, approvals
herdr plugin action invoke status --plugin modelbot

# Create a computer
herdr plugin action invoke computer-create --plugin modelbot

# Start / stop (uses MODELBOT_COMPUTER_ID or the first computer)
herdr plugin action invoke start --plugin modelbot
herdr plugin action invoke stop --plugin modelbot

# Print + open UI bootstrap URL (/?bootstrap=…)
herdr plugin action invoke computer-open --plugin modelbot

# Open live view for a pending takeover (falls back to UI bootstrap)
herdr plugin action invoke takeover-open --plugin modelbot
```

## Status pane

```bash
herdr plugin pane open --plugin modelbot --entrypoint status --placement overlay
```

The pane runs `modelbot status --watch` (refresh every 2 seconds).

## Unlink

```bash
herdr plugin unlink modelbot
```
