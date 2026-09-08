#!/usr/bin/env bash
# Real-image egress checks. Node is present in every shipped image; curl is not.
# Optional: MODELBOT_TEST_{COMPUTER,SHELL,PROXY}_IMAGE, EGRESS_PROJECT,
# INTERNAL_SUBNET / INTERNAL_PROXY_IP. Never build or pull images here.
# Allowed-host abuse, proxy compromise, host misconfiguration and timing races
# remain outside these probes. A passing suite is not a firewall guarantee.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.egress-test.yml"
export EGRESS_PROJECT="${EGRESS_PROJECT:-modelbot-egress-test-$$}"
export MODELBOT_TEST_COMPUTER_IMAGE="${MODELBOT_TEST_COMPUTER_IMAGE:-modelbot/computer:dev}"
export MODELBOT_TEST_SHELL_IMAGE="${MODELBOT_TEST_SHELL_IMAGE:-modelbot/shell:dev}"
export MODELBOT_TEST_PROXY_IMAGE="${MODELBOT_TEST_PROXY_IMAGE:-modelbot/proxy:dev}"
[[ "$EGRESS_PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo "invalid EGRESS_PROJECT" >&2; exit 2; }
export EGRESS_WORKSPACE="$(mktemp -d "${TMPDIR:-/tmp}/modelbot-egress-ws.XXXXXX")"
chmod 0777 "$EGRESS_WORKSPACE"
PASS_N=0 FAIL_N=0 SKIP_N=0 STACK_CREATED=0
compose() { docker compose -p "$EGRESS_PROJECT" -f "$COMPOSE_FILE" "$@"; }
cleanup() {
  if [[ "$STACK_CREATED" == 1 ]]; then compose down -v --remove-orphans >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

# Refuse to delete or reuse someone else's stack, even with an explicit project.
[[ -z "$(compose ps -aq)" ]] || { echo "refusing existing project $EGRESS_PROJECT" >&2; exit 1; }
for image in "$MODELBOT_TEST_COMPUTER_IMAGE" "$MODELBOT_TEST_SHELL_IMAGE" "$MODELBOT_TEST_PROXY_IMAGE"; do
  docker image inspect "$image" --format 'IMAGE {{.RepoTags}} {{.Id}}'
done
STACK_CREATED=1
compose up -d --no-build --pull never
for role in browser shell proxy; do
  case "$role" in
    browser) expected="$MODELBOT_TEST_COMPUTER_IMAGE" ;;
    shell) expected="$MODELBOT_TEST_SHELL_IMAGE" ;;
    proxy) expected="$MODELBOT_TEST_PROXY_IMAGE" ;;
  esac
  expected_id="$(docker image inspect "$expected" --format '{{.Id}}')"
  actual="$(docker inspect "$(compose ps -q "$role")" --format '{{.Config.Image}} {{.Image}}')"
  [[ "$actual" == "$expected $expected_id" ]] || { echo "unexpected $role image: $actual" >&2; exit 1; }
  echo "RUNNING $role $actual"
done

probe() {
  local name="$1" role="$2" output status
  shift 2
  if output="$(compose exec -T -e CI=1 -e MODELBOT_NO_OPEN=1 "$role" node --input-type=module - "$@" < "$ROOT/scripts/egress-probe.mjs" 2>&1)"; then
    if ! status="$(printf '%s' "$output" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);if(!["PASS","SKIP"].includes(j.status))process.exit(1);process.stdout.write(j.status)})')"; then
      echo "FAIL: $name (invalid probe receipt) $output"; FAIL_N=$((FAIL_N + 1)); return
    fi
    if [[ "$status" == SKIP ]]; then SKIP_N=$((SKIP_N + 1)); else PASS_N=$((PASS_N + 1)); fi
    echo "$status: $name $output"
  else
    echo "FAIL: $name (probe did not pass) $output"
    FAIL_N=$((FAIL_N + 1))
  fi
}

probe 1-proxy-https-example browser request https://example.com/ 200
probe 2-deny-metadata browser request http://169.254.169.254/ 403
probe 3-deny-rfc1918 browser request http://10.0.0.1/ 403
probe 4-direct-https-blocked browser blocked-tcp example.com 443
probe 5-direct-dns-udp-blocked browser blocked-udp
probe 6-direct-ipv6-blocked browser blocked-tcp 2606:4700:4700::1111 443 6
probe 7-deny-loopback-hostname browser request http://localtest.me/ 403
probe 8-websocket-connect browser websocket
probe 9-doh-direct-blocked browser blocked-tcp 1.1.1.1 443

HEX="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
SHORT="${HEX}.exfil-test.invalid"
LONG="aaaaaaaaaa.bbbbbbbbbb.cccccccccc.dddddddddd.eeeeeeeeee.${HEX}.exfil-test.invalid"
probe 10-dns-label-browser browser dns "$SHORT" "$LONG"
probe 10-dns-label-shell shell dns "$SHORT" "$LONG"
probe 10-chromium-dns-denied browser chromium-dns "$SHORT"
probe 10-sinkhole-observed-no-forward proxy dns-stats "$SHORT" "$LONG"

for port in 22 25 3389 5900; do probe "11-connect-denied-$port" browser connect "$port" 403; done
probe 11-connect-443 browser request https://example.com/ 200
probe 12-raw-tcp-browser browser blocked-tcp 1.1.1.1 22
probe 12-raw-tcp-shell shell blocked-tcp 1.1.1.1 22
probe 13-dnsz-hidden-from-shell shell dns-private

echo "SUMMARY: PASS=$PASS_N FAIL=$FAIL_N SKIP=$SKIP_N"
[[ "$FAIL_N" == 0 ]]
