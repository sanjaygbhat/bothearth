#!/usr/bin/env bash
# Egress bypass suite. Asserts internal-net + sidecar proxy containment
# against REAL images: modelbot/computer:dev, modelbot/shell:dev, modelbot/proxy:dev.
# Does not build or pull images.
#
# Best-effort / out of scope (document, do not claim "firewall"):
# - Proxy abuse via *allowed* hosts (exfil to attacker-controlled public origin)
# - QUIC/HTTP3 bypass (Chromium disables QUIC when HTTP proxy configured)
# - Compromised proxy process itself
# - Host/Docker daemon misconfig that attaches sandbox to a non-internal network
# - DNS rebinding race narrower than our connect-time re-check window
# - Raw TCP to an allowed public IP:port that is not HTTP(S) (ports ≠ 80/443 denied)
#
# Cases 1–7, 9–13 must PASS. Case 8 may SKIP if no public WS echo reachable.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.egress-test.yml"
PROJECT="modelbot-egress-test"
PASS_N=0
FAIL_N=0
SKIP_N=0
LOCK_PID=""
EGRESS_WORKSPACE=""

# DESTRUCTIVE-COMMAND BAN: do not rm -rf workspace; compose down -v is the
# documented stack teardown (named volumes + this project's containers only).
cleanup() {
  if [[ -n "${LOCK_PID}" ]]; then
    kill "${LOCK_PID}" >/dev/null 2>&1 || true
    wait "${LOCK_PID}" 2>/dev/null || true
    LOCK_PID=""
  fi
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

result() {
  local name="$1" status="$2" detail="${3:-}"
  if [[ "$status" == "PASS" ]]; then
    echo "PASS: $name${detail:+ ($detail)}"
    PASS_N=$((PASS_N + 1))
  elif [[ "$status" == "SKIP" ]]; then
    echo "SKIP: $name${detail:+ ($detail)}"
    SKIP_N=$((SKIP_N + 1))
  else
    echo "FAIL: $name${detail:+ ($detail)}"
    FAIL_N=$((FAIL_N + 1))
  fi
}

echo "== WP05/O-M8 egress-bypass: acquire docker-int lock =="
LOCK_LOG="${TMPDIR:-/tmp}/modelbot-egress-lock.$$.log"
node --input-type=module -e "
import { acquireDockerLock } from 'file://${ROOT}/tests/docker-int/lock.ts';
const h = await acquireDockerLock();
process.stdout.write('LOCKED\n');
process.stdin.resume();
const rel = () => { try { h.release(); } finally { process.exit(0); } };
process.on('SIGTERM', rel);
process.on('SIGINT', rel);
process.on('SIGHUP', rel);
" >"$LOCK_LOG" 2>&1 &
LOCK_PID=$!
for _i in $(seq 1 3000); do
  if grep -q '^LOCKED$' "$LOCK_LOG" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "FAIL: docker-int lock holder exited"
    cat "$LOCK_LOG" || true
    exit 1
  fi
  sleep 0.2
done
if ! grep -q '^LOCKED$' "$LOCK_LOG" 2>/dev/null; then
  echo "FAIL: docker-int lock timeout"
  exit 1
fi

for img in modelbot/proxy:dev modelbot/computer:dev modelbot/shell:dev; do
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    echo "FAIL: missing image $img (do not pull/rebuild in this suite)"
    exit 1
  fi
done

EGRESS_WORKSPACE="$(mktemp -d "${TMPDIR:-/tmp}/modelbot-egress-ws.XXXXXX")"
export EGRESS_WORKSPACE
chmod 0777 "$EGRESS_WORKSPACE"

echo "== egress-bypass: starting real-image stack (no build) =="
cleanup_stack() {
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
}
cleanup_stack
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --no-build --pull never

for i in $(seq 1 30); do
  if docker compose -p "$PROJECT" -f "$COMPOSE_FILE" exec -T browser \
      curl -sf --noproxy '*' "http://proxy:3129/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

browser() {
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" exec -T browser "$@"
}
shell() {
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" exec -T shell "$@"
}

PROXY_URL="http://proxy:3128"

# (1) curl https://example.com via proxy → 200
code="$(browser curl -sS -o /dev/null -w '%{http_code}' -m 30 -x "$PROXY_URL" https://example.com || true)"
if [[ "$code" == "200" ]]; then
  result "1-proxy-https-example" PASS "http_code=$code"
else
  result "1-proxy-https-example" FAIL "http_code=$code"
fi

# (2) metadata IP via proxy → denied (403 from proxy)
out2="$(browser curl -sS -o /dev/null -w '%{http_code}' -m 3 -x "$PROXY_URL" http://169.254.169.254/ 2>/dev/null || true)"
if [[ "$out2" == "403" ]]; then
  result "2-deny-metadata" PASS "http_code=$out2"
else
  result "2-deny-metadata" FAIL "expected 403 got http_code=$out2"
fi

# (3) RFC1918 via proxy → denied
out3="$(browser curl -sS -o /dev/null -w '%{http_code}' -m 3 -x "$PROXY_URL" http://10.0.0.1/ 2>/dev/null || true)"
if [[ "$out3" == "403" ]]; then
  result "3-deny-rfc1918" PASS "http_code=$out3"
else
  result "3-deny-rfc1918" FAIL "expected 403 got http_code=$out3"
fi

# (4) direct https without proxy → no route on internal network
if browser curl -sS -m 3 --noproxy '*' https://example.com >/dev/null 2>&1; then
  result "4-direct-https-blocked" FAIL "unexpected success without proxy"
else
  result "4-direct-https-blocked" PASS "no route / connect fail"
fi

# (5) direct DNS/UDP or raw to 8.8.8.8 → fails
if browser curl -sS -m 3 --noproxy '*' http://8.8.8.8/ >/dev/null 2>&1; then
  result "5-direct-dns-udp-blocked" FAIL "unexpected reachability to 8.8.8.8"
else
  result "5-direct-dns-udp-blocked" PASS "no route to 8.8.8.8"
fi

# (6) IPv6 direct → fails
if browser curl -6 -sS -m 3 --noproxy '*' https://example.com >/dev/null 2>&1; then
  result "6-direct-ipv6-blocked" FAIL "unexpected IPv6 egress"
else
  result "6-direct-ipv6-blocked" PASS "no IPv6 route"
fi

# (7) hostname resolving to 127.0.0.1 → proxy deny
out7="$(browser curl -sS -o /dev/null -w '%{http_code}' -m 10 -x "$PROXY_URL" http://localtest.me/ 2>/dev/null || true)"
if [[ "$out7" == "403" ]]; then
  result "7-deny-loopback-hostname" PASS "localtest.me http_code=$out7"
else
  out7b="$(browser curl -sS -o /dev/null -w '%{http_code}' -m 10 -x "$PROXY_URL" http://127.0.0.1.nip.io/ 2>/dev/null || true)"
  if [[ "$out7b" == "403" ]]; then
    result "7-deny-loopback-hostname" PASS "127.0.0.1.nip.io http_code=$out7b"
  else
    result "7-deny-loopback-hostname" FAIL "localtest.me=$out7 nip.io=$out7b"
  fi
fi

# (8) WebSocket over CONNECT to allowed host — SKIP if unreachable
ws_hdr="$(browser curl -sS -i --http1.1 -m 20 -x "$PROXY_URL" \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://echo.websocket.org 2>/dev/null | LC_ALL=C tr -d '\r' | grep -a -iE '^HTTP/' | tail -n 1 || true)"
if echo "$ws_hdr" | grep -qiE ' 101 |HTTP/1\.1 101'; then
  result "8-websocket-connect" PASS "upgrade ok"
elif echo "$ws_hdr" | grep -qiE 'HTTP/[0-9.]+ (200|400|426)'; then
  result "8-websocket-connect" PASS "CONNECT tunnel reachable ($ws_hdr)"
else
  ws2="$(browser curl -sS -o /dev/null -w '%{http_code}' -m 15 -x "$PROXY_URL" https://www.example.com 2>/dev/null || true)"
  if [[ "$ws2" == "200" ]]; then
    result "8-websocket-connect" SKIP "echo.websocket.org unreachable; CONNECT elsewhere ok"
  else
    result "8-websocket-connect" SKIP "no public WS echo reachable"
  fi
fi

# (9) DoH attempt direct to 1.1.1.1 → fails (no route)
if browser curl -sS -m 3 --noproxy '*' https://1.1.1.1/dns-query >/dev/null 2>&1; then
  result "9-doh-direct-blocked" FAIL "unexpected DoH reachability"
else
  result "9-doh-direct-blocked" PASS "no route to 1.1.1.1"
fi

# --- O-M8 additions ---

HEX="$(browser node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
SHORT="${HEX}.exfil-test.invalid"
LONG="aaaaaaaaaa.bbbbbbbbbb.cccccccccc.dddddddddd.eeeeeeeeee.${HEX}.exfil-test.invalid"

cat > "$EGRESS_WORKSPACE/dns-probe.mjs" << 'EOF'
import dns from "node:dns/promises";
import { spawnSync } from "node:child_process";
const name = process.argv[2];
if (!name) {
  process.stdout.write("RESOLVED missing-name");
  process.exit(2);
}
let resolved = false;
const bits = [];
try {
  const r = await dns.lookup(name);
  if (r && r.address && netLike(r.address)) {
    resolved = true;
    bits.push("node=" + r.address);
  } else {
    bits.push("node=empty");
  }
} catch (e) {
  bits.push("node=" + (e && e.code ? e.code : "fail"));
}
function netLike(s) {
  return /^\d+\.\d+\.\d+\.\d+$/.test(s) || s.includes(":");
}
for (const [bin, args] of [
  ["getent", ["hosts", name]],
  ["dig", ["+time=2", "+tries=1", name]],
  ["nslookup", ["-timeout=2", name]],
]) {
  const found = spawnSync("sh", ["-c", "command -v " + bin], { encoding: "utf8" });
  if (found.status !== 0) {
    bits.push(bin + "=absent");
    continue;
  }
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 4000 });
  const out = (r.stdout || "") + (r.stderr || "");
  if (
    r.status === 0 &&
    /\d+\.\d+\.\d+\.\d+/.test(out) &&
    !/NXDOMAIN|REFUSED|not found/i.test(out)
  ) {
    resolved = true;
    bits.push(bin + "=A");
  } else {
    bits.push(bin + "=fail");
  }
}
process.stdout.write((resolved ? "RESOLVED " : "BLOCKED ") + bits.join(","));
process.exit(resolved ? 2 : 0);
EOF

cat > "$EGRESS_WORKSPACE/connect-probe.mjs" << 'EOF'
import net from "node:net";
const port = Number(process.argv[2]);
const s = net.connect(3128, "proxy");
s.setTimeout(5000);
let buf = "";
s.on("connect", () => {
  s.write(
    "CONNECT example.com:" + port + " HTTP/1.1\r\nHost: example.com:" + port + "\r\n\r\n",
  );
});
s.on("data", (c) => {
  buf += c.toString("utf8");
  s.end();
});
s.on("timeout", () => {
  process.stdout.write("TIMEOUT");
  s.destroy();
});
s.on("error", () => {
  process.stdout.write("ERR");
});
s.on("close", () => {
  const m = buf.match(/HTTP\/1\.[01] (\d+)/);
  process.stdout.write(m ? m[1] : buf ? "NOSTATUS" : "EMPTY");
});
EOF

cat > "$EGRESS_WORKSPACE/chrom-probe.mjs" << 'EOF'
import { createRequire } from "node:module";
const require = createRequire("/opt/playwright/package.json");
const { chromium } = require("playwright");
const host = process.argv[2];
const url = "http://" + host + "/";
try {
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: false,
    proxy: { server: process.env.MODELBOT_PROXY_SERVER || "http://proxy:3128" },
    ignoreDefaultArgs: ["--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  let leaked = false;
  let detail = "none";
  try {
    const resp = await page.goto(url, { timeout: 8000, waitUntil: "domcontentloaded" });
    const status = resp ? resp.status() : 0;
    leaked = Boolean(resp && resp.ok());
    detail = "status=" + status + " url=" + page.url();
  } catch (e) {
    leaked = false;
    detail = "throw=" + String(e && e.message ? e.message : e);
  }
  await browser.close();
  process.stdout.write((leaked ? "CHROM_NAV_OK " : "CHROM_NAV_FAIL ") + detail);
} catch (e) {
  process.stdout.write("CHROM_ERR " + String(e && e.message ? e.message : e));
}
EOF

dnsz() {
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" exec -T proxy \
    node -e "fetch('http://127.0.0.1:3129/dnsz').then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())}).catch(()=>process.exit(1))" \
    2>/dev/null || echo '{"queries":0,"forwarded":-1,"names":[]}'
}

try_resolve_in() {
  local svc="$1" name="$2"
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" exec -T "$svc" \
    node /workspace/dns-probe.mjs "$name"
}

dns_ok=1
dns_detail=""
before="$(dnsz)"
for svc in browser shell; do
  for name in "$SHORT" "$LONG"; do
    out="$(try_resolve_in "$svc" "$name" || true)"
    dns_detail="${dns_detail}${svc}:${name}:$(echo "$out" | tr '\n' ' '); "
    if echo "$out" | grep -q '^RESOLVED'; then
      dns_ok=0
    fi
  done
done

chrom_out="$(browser node /workspace/chrom-probe.mjs "$SHORT" || true)"
dns_detail="${dns_detail}chromium:${chrom_out}; "
if echo "$chrom_out" | grep -q 'CHROM_NAV_OK'; then
  dns_ok=0
fi

after="$(dnsz)"
fwd="$(echo "$after" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.forwarded??-1)+" "+String(j.queries??0)+" "+JSON.stringify(j.names||[]))}catch{process.stdout.write("-1 0 []")}})')"
fwd_n="$(echo "$fwd" | awk '{print $1}')"
q_n="$(echo "$fwd" | awk '{print $2}')"
if [[ "$fwd_n" != "0" ]]; then
  dns_ok=0
  dns_detail="${dns_detail}forwarded=${fwd_n}; "
fi
if ! echo "$after" | grep -q "$HEX"; then
  dns_ok=0
  dns_detail="${dns_detail}sinkhole-missed-hex; "
fi

if [[ "$dns_ok" -eq 1 ]]; then
  result "10-dns-label-exfil" PASS "sinkhole queries=${q_n} forwarded=0; ${dns_detail}"
else
  result "10-dns-label-exfil" FAIL "$dns_detail after=$after before=$before"
fi

# (11) CONNECT :22/:25/:3389/:5900 → 403; :443 allowed host succeeds
connect_code() {
  local port="$1"
  browser node /workspace/connect-probe.mjs "$port"
}

c22="$(connect_code 22 || true)"
c25="$(connect_code 25 || true)"
c3389="$(connect_code 3389 || true)"
c5900="$(connect_code 5900 || true)"
c443="$(browser curl -sS -o /dev/null -w '%{http_code}' -m 20 -x "$PROXY_URL" https://example.com || true)"
if [[ "$c22" == "403" && "$c25" == "403" && "$c3389" == "403" && "$c5900" == "403" && "$c443" == "200" ]]; then
  result "11-connect-denied-ports" PASS "22/25/3389/5900=403 443=$c443"
else
  result "11-connect-denied-ports" FAIL "22=$c22 25=$c25 3389=$c3389 5900=$c5900 443=$c443"
fi

# (12) raw TCP to public IP:22 from both containers must fail
raw_tcp22() {
  local svc="$1"
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" exec -T "$svc" node --input-type=module -e '
import net from "node:net";
const s = net.connect({ host: "1.1.1.1", port: 22 });
s.setTimeout(3000);
s.on("connect", () => { process.stdout.write("CONNECTED"); s.destroy(); process.exit(2); });
s.on("timeout", () => { process.stdout.write("TIMEOUT"); s.destroy(); process.exit(0); });
s.on("error", (e) => { process.stdout.write(String(e.code || e.message)); process.exit(0); });
'
}

b22="$(raw_tcp22 browser || true)"
s22="$(raw_tcp22 shell || true)"
if echo "$b22" | grep -q '^CONNECTED' || echo "$s22" | grep -q '^CONNECTED'; then
  result "12-raw-tcp-public-22" FAIL "browser=$b22 shell=$s22"
else
  result "12-raw-tcp-public-22" PASS "browser=$b22 shell=$s22"
fi

# (13) R5-4: shell on the internal net must not read /dnsz (404 or curl -sf fail).
# Production compose never sets PROXY_DNSZ; this stack enables it for case 10 on loopback only.
if shell curl -sf --noproxy '*' -m 5 "http://proxy:3129/dnsz" >/dev/null 2>&1; then
  result "13-dnsz-hidden-from-shell" FAIL "shell read /dnsz"
else
  result "13-dnsz-hidden-from-shell" PASS "curl -sf http://proxy:3129/dnsz failed"
fi

echo "== summary: PASS=$PASS_N FAIL=$FAIL_N SKIP=$SKIP_N =="
echo "== sub-checks: 1-proxy-https-example 2-deny-metadata 3-deny-rfc1918 4-direct-https-blocked 5-direct-dns-udp-blocked 6-direct-ipv6-blocked 7-deny-loopback-hostname 8-websocket-connect 9-doh-direct-blocked 10-dns-label-exfil 11-connect-denied-ports 12-raw-tcp-public-22 13-dnsz-hidden-from-shell =="
if [[ "$FAIL_N" -gt 0 ]]; then
  exit 1
fi
exit 0
