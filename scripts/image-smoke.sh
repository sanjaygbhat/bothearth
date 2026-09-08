#!/usr/bin/env bash
# Hardening smoke for modelbot/computer:dev (WP06).
# Proves: Chromium launches under ARCH §9 flags; agent uid cannot read browser profile.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-modelbot/computer:dev}"
cd "$ROOT"

export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# final = base + computer-server (needed by docker-int / mcp-smoke); smoke still valid
echo "==> building ${IMAGE} (--target final)"
docker build -f Dockerfile.computer --target final -t "${IMAGE}" .

HARDENING=(
  --rm
  --network none
  --tmpfs /home/browser/.cache:rw,uid=1001,gid=1001,mode=0755
  --tmpfs /home/browser/profile:rw,uid=1001,gid=1001,mode=0700
  --tmpfs /workspace:rw,uid=1002,gid=1002,mode=0755
)
while IFS= read -r flag; do HARDENING+=("$flag"); done < <(
  node --input-type=module -e 'import { resolve } from "node:path"; import { browserRuntimeFlags } from "./src/sandbox/flags.ts"; console.log(browserRuntimeFlags(resolve("sandbox/seccomp-chromium.json")).join("\n"))'
)

CHROMIUM_SCRIPT='
import { chromium } from "playwright";
import { writeFileSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const configHome = mkdtempSync(join(tmpdir(), "modelbot-chromium-"));
assert.equal(statSync(configHome).mode & 0o777, 0o700);
const browser = await chromium.launch({
  headless: true,
  channel: "chromium",
  chromiumSandbox: true,
  env: { ...process.env, XDG_CONFIG_HOME: configHome },
  ignoreDefaultArgs: ["--disable-dev-shm-usage"],
});
const cdp = await browser.newBrowserCDPSession();
const command = await cdp.send("Browser.getBrowserCommandLine");
assert.ok(!command.arguments.some(arg => ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"].includes(arg)), "forbidden Chromium launch flag");
assert.ok(!command.arguments[0].includes("headless_shell"), "full Chromium required");
console.log("CHROMIUM_SANDBOX_ENABLED");
const page = await browser.newPage();
await page.goto("about:blank");
await page.screenshot({ path: "/tmp/smoke.png" });
const version = browser.version();
writeFileSync("/tmp/chromium-version.txt", version + "\n");
console.log("CHROMIUM_OK");
console.log(version);
await browser.close();
'

echo "==> chromium smoke as uid browser (1001)"
CHROMIUM_OUT="$(docker run "${HARDENING[@]}" --user 1001:1001 -w /opt/playwright "${IMAGE}" \
  node --input-type=module -e "${CHROMIUM_SCRIPT}")"
echo "${CHROMIUM_OUT}"

echo "${CHROMIUM_OUT}" | grep -q 'CHROMIUM_OK'

echo "==> profile isolation as uid agent (1002)"
set +e
AGENT_OUT="$(docker run "${HARDENING[@]}" --user 1002:1002 "${IMAGE}" \
  ls /home/browser/profile 2>&1)"
AGENT_EC=$?
set -e
echo "${AGENT_OUT}"
if [[ "${AGENT_EC}" -eq 0 ]]; then
  echo "FAIL: agent uid listed /home/browser/profile" >&2
  exit 1
fi
echo "${AGENT_OUT}" | grep -qi 'Permission denied'
echo "PROFILE_ISOLATED"

echo "==> smoke PASS"
