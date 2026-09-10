# BotHearth CLI reference

Generated from `modelbot --help`. The `bothearth` alias runs the same command. Do not hand-edit; re-run:

```bash
node --experimental-strip-types scripts/gen-cli-doc.ts
```

## Help output

```text
BotHearth 0.0.1
Usage: modelbot <command> [flags]
Alias: bothearth <command> [flags] (same command; existing modelbot paths are retained)

Commands:
  init [--home DIR] [--data-dir DIR] [--bind ADDR] [--port N]
       [--force] [--skip-detect] [--skip-images] [--quiet]
       [--keychain auto] [--reset-vault-key]
  start [--port N] [--host ADDR] [--home DIR] [--daemon] [--no-open]
        [--allow-public-bind] [--ready-json]
  stop [--home DIR]
  pair [--home DIR] [--list | --revoke DEVICE_ID]
       Print a fresh sign-in link when the last one expired
  doctor [--home DIR] [--config PATH] [--json]
  security audit
  image pull|build
  mcp-stdio
  audit verify [--path FILE] [--key-file FILE] [--home DIR] [--config PATH]
       HMAC key: vault `audit/hmac` (default); --key-file or MODELBOT_AUDIT_KEY_HEX / MODELBOT_AUDIT_KEY override when set
  vault set|get|rm|ls|rotate [--path P] [--value-file F]
  connect <codex|claude|gemini|cursor|opencode|copilot>
          [--print] [--remove] [--config PATH] [--home DIR]
          [--codex-home DIR]
  status [--watch] [--json] [--pid] [--daemon] [--home DIR]
  computer create|destroy <name> [--compose] [--workspace-root DIR]
             [--wipe-profile]
  routine add --name N --cron EXPR --computer NAME --goal TEXT
          [--notify URI] [--origin URL] [--shell] [--disabled] [--db PATH]
  routine ls|run|rm [id-or-name] [--db PATH]
  deploy [ssh|hetzner] [--name N] [--host H] [--user U] [--ssh-key PATH]
         [--tarball PATH] [--tailscale-authkey-file FILE]
         [--tailscale-serve] [--public-origin https://HOST]
         [--systemd-credential /REMOTE/PATH.cred]
         [--token-env E] [--region R] [--arch amd64|arm64]
         [--server-type T] [--image I] [--ipv4] [--dry-run] [--yes]
         [--suggest-signup]
  deploy destroy <name> [--yes] [--dry-run] [--token T] [--token-env E]
  version | --version | -V

Global:
  --help | -h     Show this help
  --version | -V  Print version

Docs: docs/CLI.md (generated), docs/QUICKSTART.md, docs/CONFIG.md
```

## Notes

- Bind defaults to loopback (`127.0.0.1`). Public bind requires an explicit unsafe flag.
- Harness mode: `modelbot connect <codex|claude|gemini|…>` writes official MCP config; subscriptions stay inside those harnesses.
- Standalone mode: provider keys live in the host vault; never mounted into sandbox containers.
- Remote mode: `modelbot deploy` targets a VM you own; never expose the live-view port publicly (use Tailscale / SSH).

## See also

- Quickstart: `docs/QUICKSTART.md`
- Config: `docs/CONFIG.md`
- Troubleshooting: `docs/TROUBLESHOOTING.md`
