#!/usr/bin/env bash
# WP21 — MVP Definition of Done gate.
# Unattended ordered checks; PASS/FAIL + wall time per item.
# Exits nonzero on first FAIL (set MODELBOT_TEST_DOD_KEEP_GOING=1 to continue).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="${PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:-1}"
export MODELBOT_TEST_GOLDEN_MOCK="${MODELBOT_TEST_GOLDEN_MOCK:-1}"

KEEP_GOING="${MODELBOT_TEST_DOD_KEEP_GOING:-0}"
PASS_N=0
FAIL_N=0
DOD_TMP=""

cleanup() {
  # Only remove the temp HOME this script created (name prefix + outside repo).
  if [[ -n "${DOD_TMP}" && -d "${DOD_TMP}" ]]; then
    if [[ "${DOD_TMP}" == *"/modelbot-dod-home."* && "${DOD_TMP}" != "${ROOT}"* ]]; then
      rm -rf "${DOD_TMP}"
    fi
  fi
}
trap cleanup EXIT

now_ms() {
  python3 -c 'import time; print(int(time.time()*1000))'
}

fmt_ms() {
  python3 -c "print(f'{int("$1")/1000:.1f}s')"
}

run_item() {
  local name="$1"
  shift
  local t0 t1 elapsed rc
  echo ""
  echo "==> ${name}"
  t0="$(now_ms)"
  set +e
  "$@"
  rc=$?
  set -e
  t1="$(now_ms)"
  elapsed=$((t1 - t0))
  if [[ "$rc" -eq 0 ]]; then
    echo "PASS: ${name} ($(fmt_ms "$elapsed"))"
    PASS_N=$((PASS_N + 1))
    return 0
  fi
  echo "FAIL: ${name} exit=${rc} ($(fmt_ms "$elapsed"))"
  FAIL_N=$((FAIL_N + 1))
  if [[ "$KEEP_GOING" != "1" ]]; then
    echo ""
    echo "mvp-dod STOPPED: ${FAIL_N} FAIL / ${PASS_N} PASS"
    exit 1
  fi
  return 0
}

doctor_fresh_init() {
  DOD_TMP="$(mktemp -d "${TMPDIR:-/tmp}/modelbot-dod-home.XXXXXX")"
  export MODELBOT_HOME="$DOD_TMP"
  export MODELBOT_DATA_DIR="$DOD_TMP/data"
  export MODELBOT_VAULT_KEY_HEX
  MODELBOT_VAULT_KEY_HEX="$(openssl rand -hex 32)"
  node --experimental-strip-types src/cli/index.ts init \
    --home "$DOD_TMP" \
    --data-dir "$DOD_TMP/data" \
    --skip-detect \
    --skip-images \
    --quiet \
    --force
  local out
  out="$(node --experimental-strip-types src/cli/index.ts doctor --home "$DOD_TMP")"
  printf '%s\n' "$out"
  printf '%s\n' "$out" | grep -q 'RESULT: PASS'
}

echo "ModelBot mvp-dod (WP21) — root=${ROOT}"
echo "started $(date -u +%Y-%m-%dT%H:%M:%SZ)"

run_item "typecheck" npm run typecheck
run_item "unit-tests" npm run test:unit
run_item "contract-tests" npm run test:contracts
run_item "image-smoke-browser" bash scripts/image-smoke.sh
run_item "image-smoke-shell" bash scripts/shell-image-smoke.sh
egress_with_proxy_image() {
  docker build -f Dockerfile.proxy -t modelbot/proxy:dev . && bash scripts/egress-bypass.sh
}
run_item "egress-bypass" egress_with_proxy_image
# Drop docker-int lock when recorded holder is dead (killed/hung run leftover).
if [[ -f "${ROOT}/tests/docker-int/.lock" ]]; then
  python3 - "${ROOT}/tests/docker-int/.lock" <<'PY'
import json, os, sys
path = sys.argv[1]
try:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    pid = int(data["pid"])
except (FileNotFoundError, OSError, json.JSONDecodeError, KeyError, TypeError, ValueError):
    # Empty/malformed leftover from pre-WP33 wx locks: no live holder.
    try:
        os.unlink(path)
    except OSError:
        pass
    sys.exit(0)
try:
    os.kill(pid, 0)
except ProcessLookupError:
    try:
        os.unlink(path)
    except OSError:
        pass
except OSError:
    pass
PY
fi
run_item "docker-int" npm run test:docker-int
run_item "mcp-smoke" node --experimental-strip-types scripts/mcp-smoke.ts
run_item "golden-mock" env MODELBOT_TEST_GOLDEN_MOCK=1 \
  node --experimental-strip-types scripts/golden-run.ts --mock
# The mock run rewrites the tracked scoreboard/golden-last.json; restore the committed
# harness-real results so a verification run never clobbers the published evidence.
git restore --quiet docs/internal/scoreboard.md docs/internal/build/golden-last.json 2>/dev/null || true
run_item "doctor-fresh-init" doctor_fresh_init
run_item "memory-gate" node --experimental-strip-types scripts/memory-gate.ts
run_item "claims-lint" npm run claim-scan

echo ""
echo "mvp-dod SUMMARY: ${PASS_N} PASS / ${FAIL_N} FAIL"
echo "finished $(date -u +%Y-%m-%dT%H:%M:%SZ)"
[[ "$FAIL_N" -eq 0 ]]
