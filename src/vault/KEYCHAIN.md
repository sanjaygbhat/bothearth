# Vault keychain ACL limits

ModelBot stores the vault **master key** (32 random bytes, hex) in:

| OS | Mechanism | Service | Account |
|---|---|---|---|
| macOS | Keychain via `security` CLI | `com.modelbot.vault` | `master-key:<sha256(realpath(vault.enc))[:16]>` |
| Linux | Secret Service via `secret-tool` | `com.modelbot.vault` | `master-key:<sha256(realpath(vault.enc))[:16]>` |
| CI | `MODELBOT_VAULT_KEY_HEX` | n/a | n/a |
| Fallback | Passphrase + scrypt in the vault file | n/a | n/a |

## One item per vault file

Every ModelBot home has its own `vault.enc` — the CLI's `~/.modelbot`, the Mac app's
Application Support home, and any scratch home a test or script creates. They used to share
the single account `master-key`, so minting or resetting a key for one home silently made
every other home's vault undecryptable.

The account now carries a digest of the vault file's real path. Scoping to the file rather
than the home is deliberate: two homes configured to share one `data_dir` share one vault,
and must therefore keep sharing one key.

The bare `master-key` account is still **read**, but only when the vault file already exists
— a vault created before the split can only be opened by it. The first time it actually
decrypts a vault, that key is copied to the vault's own account (verified by read-back) and
the legacy item is left in place, because other homes may still depend on it.
`modelbot init --reset-vault-key` deletes only the vault's own account, never the legacy one.

## Honest ACL limits (r2-opus-security M3)

`security add-generic-password -T /path/to/node` grants **every** Node process on the machine (including malicious `npm` postinstall scripts and host-side harnesses) non-interactive read of the vault master key. That is **not** a security boundary.

**Prefer:**

1. Passphrase mode (`vault.keychain: passphrase`) for highest honesty, or
2. A dedicated keychain with prompt-on-unlock (no broad `-T node` ACL).

ModelBot’s macOS provider intentionally does **not** pass `-T` by default. Non-interactive daemon use may prompt, or operators may choose passphrase / CI env key deliberately.

Do **not** put long-lived vault passphrases in environment variables as a production primary (`SECURITY.md`). `MODELBOT_VAULT_KEY_HEX` is for CI/tests only.

## Sandbox

The vault file path is never bind-mounted into browser or shell containers. See the sandbox flag builders and vault unit guarantees.

## Headless systemd credential

With `LoadCredentialEncrypted=modelbot-vault:PATH`, auto key selection can read the protected `modelbot-vault` file in systemd’s `CREDENTIALS_DIRECTORY`. This supports a dedicated host without a desktop keyring; no master key is put into a unit or environment value. See [remote setup](../../docs/REMOTE-DEPLOY.md#headless-vault-across-host-restart) for version, encryption, reboot and recovery requirements. The daemon refuses wrong keys, unsafe credential permissions and automatic rotation of this externally managed key. Service-account/root compromise remains outside this boundary.
