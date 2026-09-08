# seccomp-chromium.json

Derived from **moby v27.3.1** `profiles/seccomp/default.json`.

## Why not Docker default?

With `--cap-drop ALL` (no `CAP_SYS_ADMIN`), Docker’s default profile:

1. Allows `clone` only when namespace bits are clear (`SCMP_CMP_MASKED_EQ` mask `0x7E020000` → blocks `CLONE_NEWUSER|NEWNS|NEWCGROUP|NEWUTS|NEWIPC|NEWPID|NEWNET`).
2. Allows `unshare` only when `CAP_SYS_ADMIN` is present.

Chromium’s process sandbox needs those user-namespace syscalls. Without them, people reach for `--no-sandbox` — **forbidden** (ARCHITECTURE §5, DECISIONS R2).

## What we change

1. **Remove** the two `clone` + `args` MASKED_EQ rules.
2. **Add** `SCMP_ACT_ALLOW` for `clone`, `unshare`, and `chroot` when `CAP_SYS_ADMIN` is absent. Chromium creates its user namespace and chroots inside it. Docker's conditional `CAP_SYS_CHROOT` rule is otherwise omitted by `--cap-drop ALL`, even though the kernel permits the operation inside the new namespace. No outer-container capability is added.
3. **Keep** `clone3` → `ENOSYS` (errno 38) so libc falls back to `clone` (Docker’s intentional design).

## Verification

`bash scripts/image-smoke.sh` uses the production `browserRuntimeFlags`, launches full Chromium with `chromiumSandbox: true`, takes a screenshot, and rejects `--no-sandbox`, `--disable-setuid-sandbox`, and `--disable-dev-shm-usage` in the actual browser command line.

Measured on Docker Desktop aarch64: the old profile failed at `sys_chroot("/proc/self/fdinfo/")`; allowing `chroot` in the user-namespace rule passed without adding capabilities or weakening the outer seccomp policy. Unsupported kernels must fail the launch check; there is no automatic no-sandbox fallback.
