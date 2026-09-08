#!/usr/bin/env bash
# Hardening smoke for modelbot/shell:dev (WP06b).
# Proves: agent toolchain present; workspace bind writable; rootfs read-only.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-modelbot/shell:dev}"
cd "$ROOT"

export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

echo "==> building ${IMAGE} (--target final, no provenance/sbom)"
BUILD_START="$(date +%s)"
docker build -f Dockerfile.shell --provenance=false --sbom=false \
  --target final -t "${IMAGE}" .
BUILD_END="$(date +%s)"
echo "==> build wall $((BUILD_END - BUILD_START))s"

WS="$(mktemp -d "${TMPDIR:-/tmp}/modelbot-shell-ws.XXXXXX")"
cleanup() { rm -rf "${WS}"; }
trap cleanup EXIT
chmod 0777 "${WS}"

HARDENING=(
  --rm
  --user 1002:1002
  --cap-drop ALL
  --security-opt no-new-privileges
  --read-only
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777
  --pids-limit 512
  --memory 512m
  --network none
  -v "${WS}:/workspace:rw"
  -w /workspace
)

echo "==> toolchain versions as uid agent (1002)"
NODE_OUT="$(docker run "${HARDENING[@]}" "${IMAGE}" node -v)"
PY_OUT="$(docker run "${HARDENING[@]}" "${IMAGE}" python3 --version)"
GIT_OUT="$(docker run "${HARDENING[@]}" "${IMAGE}" git --version)"
echo "${NODE_OUT}"
echo "${PY_OUT}"
echo "${GIT_OUT}"
[[ -n "${NODE_OUT}" ]]
[[ -n "${PY_OUT}" ]]
[[ -n "${GIT_OUT}" ]]

echo "==> workspace bind write OK"
docker run "${HARDENING[@]}" "${IMAGE}" \
  sh -c 'echo shell-ws-ok > /workspace/smoke.txt'
test -f "${WS}/smoke.txt"
grep -q 'shell-ws-ok' "${WS}/smoke.txt"

echo "==> rootfs write must fail"
set +e
ROOT_OUT="$(docker run "${HARDENING[@]}" "${IMAGE}" \
  sh -c 'echo no > /should-fail 2>&1')"
ROOT_EC=$?
set -e
echo "${ROOT_OUT}"
if [[ "${ROOT_EC}" -eq 0 ]]; then
  echo "FAIL: write to / succeeded under read-only rootfs" >&2
  exit 1
fi

echo "SHELL_OK"
