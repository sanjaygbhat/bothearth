#!/usr/bin/env python3
"""WP23g — Claude/Codex golden runner with UI-session human stand-in. Never prints tokens."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from http.cookiejar import MozillaCookieJar
from pathlib import Path
from urllib.parse import quote, urlparse
from urllib.request import Request, build_opener, HTTPCookieProcessor

ROOT = Path(__file__).resolve().parents[1]
OWNER_HOME = Path.home()
CODEX_HOME = OWNER_HOME / ".codex4"
TASK_TIMEOUT = 360
MAX_ATTEMPTS = 2
# One grant→relay→release per attempt. Leftover sensitive after that is FAIL, not another grant.
STAND_IN_MAX_INTERVENTIONS = 1
STAND_IN_CAP_EXHAUSTED = "stand_in_cap_exhausted"
THE_INTERNET_AUTH_TASK = "the-internet-auth-download"
THE_INTERNET_LOGIN_SETTLE_SEC = 7.0
HEALTHZ_RETRIES = 6
HEALTHZ_WAIT_SEC = 300
FLAVOUR = ROOT / "flavours" / "codex-modelbot"

SCOREBOARD = ROOT / "docs" / "internal" / "scoreboard.md"
RESULTS = ROOT / "docs" / "internal" / "build" / "golden-last.json"
MEASUREMENTS = ROOT / "docs" / "internal" / "measurements.md"
REPORT_WP23C = ROOT / "docs" / "internal" / "build" / "wp23c-report.md"
REPORT_WP23D = ROOT / "docs" / "internal" / "build" / "wp23d-report.md"
TASKS_PATH = ROOT / "tests" / "golden" / "tasks.json"
PROMPT_PATH = ROOT / "tests" / "golden" / "prompt-template.md"
GOLDEN_RUN = ROOT / "scripts" / "golden-run.ts"

TOOL_NAMES = [
    "browser_navigate", "browser_snapshot", "browser_click", "browser_type",
    "browser_press", "browser_scroll", "browser_select", "browser_upload",
    "browser_tabs", "browser_screenshot", "browser_wait", "computer_mouse",
    "computer_key", "computer_type", "shell_exec", "files_list", "files_read",
    "files_write", "files_delete", "request_takeover", "takeover_status",
    "connector_call", "done",
]
TOOL_NAME_SET = set(TOOL_NAMES)

NODE = ["node", "--experimental-strip-types"]
MB = NODE + [str(ROOT / "src/cli/index.ts")]
BOOTSTRAP_RE = re.compile(r"#bootstrap=([A-Za-z0-9_-]+)")
CODEX_MODEL_RE = re.compile(r"^model:\s*(\S+)", re.M)
QUOTA_RE = re.compile(
    r"You've hit your usage limit|usage limit|try again at .+",
    re.I,
)


def parse_argv(argv: list[str]):
    harness = "claude"
    only: list[str] = []
    bootstrap_only = False
    keep_home = False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--bootstrap-only":
            bootstrap_only = True
        elif a == "--keep-home":
            keep_home = True
        elif a == "--harness":
            i += 1
            if i >= len(argv):
                raise SystemExit("--harness needs claude|codex")
            harness = argv[i]
        elif a.startswith("--harness="):
            harness = a.split("=", 1)[1]
        elif a == "--only":
            i += 1
            if i >= len(argv):
                raise SystemExit("--only needs a task id")
            only.extend(x.strip() for x in argv[i].split(",") if x.strip())
        elif a.startswith("--only="):
            only.extend(x.strip() for x in a.split("=", 1)[1].split(",") if x.strip())
        else:
            raise SystemExit(f"unknown flag: {a}")
        i += 1
    if harness not in ("claude", "codex"):
        raise SystemExit(f"unknown --harness {harness}")
    return harness, only, bootstrap_only, keep_home


HARNESS, ONLY_IDS, BOOTSTRAP_ONLY, KEEP_HOME = parse_argv(sys.argv[1:])


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def step(msg: str) -> None:
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] step {msg}", flush=True)


def redact_secrets(text: str) -> str:
    out = text
    out = re.sub(r"#bootstrap=[A-Za-z0-9._~+/=-]+", "#bootstrap=***", out)
    out = re.sub(r"bootstrap_url:\s*\S+", "bootstrap_url: ***", out)
    out = re.sub(r'"bootstrap_url"\s*:\s*"[^"]*"', '"bootstrap_url":"[redacted]"', out)
    out = re.sub(r"Bearer\s+\S+", "Bearer ***", out, flags=re.I)
    out = re.sub(r"\bsk-[A-Za-z0-9_-]+", "sk-***", out)
    out = re.sub(r"\bAKIA[0-9A-Z]{16}\b", "AKIA***", out)
    out = re.sub(
        r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b",
        "eyJ***.***.***",
        out,
    )
    out = re.sub(
        r"(MODELBOT_(?:MCP_)?TOKEN|CLAUDE_CODE_OAUTH_TOKEN|csrf)\s*[:=]\s*\S+",
        r"\1=***",
        out,
        flags=re.I,
    )
    out = re.sub(r'"mcp_token"\s*:\s*"[^"]*"', '"mcp_token":"[redacted]"', out)
    out = re.sub(r'"token"\s*:\s*"[^"]*"', '"token":"[redacted]"', out)
    out = re.sub(r'"csrf"\s*:\s*"[^"]*"', '"csrf":"[redacted]"', out)
    return out


def extract_bootstrap_token(text: str) -> str | None:
    m = BOOTSTRAP_RE.search(text)
    return m.group(1) if m else None


def daemon_log_tail(path: Path, n: int = 40) -> str:
    if not path.exists():
        return "(daemon.log missing)"
    lines = path.read_text(errors="replace").splitlines()
    return redact_secrets("\n".join(lines[-n:]))


def clip(text: str, n: int = 220) -> str:
    text = re.sub(r"Bearer\s+\S+", "Bearer ***", text, flags=re.I)
    text = re.sub(r"sk-[A-Za-z0-9]+", "sk-***", text)
    return re.sub(r"\s+", " ", text).strip()[:n]


def scrub_retained_credentials(run_dir: Path, mb_home: Path) -> None:
    for path in (
        mb_home / "tokens.json",
        mb_home / "data" / "tokens.json",
        run_dir / "claude.mcp.json",
    ):
        path.unlink(missing_ok=True)
    log(
        "WARNING --keep-home scrubbed bearer credentials from home/tokens.json, "
        "home/data/tokens.json, and claude.mcp.json; retained audit, logs, and "
        "workspaces may still contain sensitive data."
    )


def run_cmd(argv, env=None, timeout=None, input_text=None):
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            env=env or os.environ.copy(),
            timeout=timeout,
            cwd=str(ROOT),
            input=input_text,
        )
        return proc.returncode, proc.stdout or "", proc.stderr or "", False
    except subprocess.TimeoutExpired as exc:
        out = exc.stdout if isinstance(exc.stdout, str) else (exc.stdout or b"").decode(errors="replace")
        err = exc.stderr if isinstance(exc.stderr, str) else (exc.stderr or b"").decode(errors="replace")
        return 124, out or "", err or "", True


def mb(args, env=None, timeout=60):
    return run_cmd(MB + args, env=env, timeout=timeout)


def load_suite():
    return json.loads(TASKS_PATH.read_text())


def site_origins(suite) -> list[str]:
    seen: list[str] = []
    for t in suite.get("tasks") or []:
        for s in t.get("sites") or []:
            try:
                u = urlparse(s)
            except Exception:
                continue
            if not u.scheme or not u.netloc:
                continue
            origin = f"{u.scheme}://{u.netloc}"
            if origin not in seen:
                seen.append(origin)
    return seen


def patch_home_yaml(cfg_path: Path, origins: list[str], commands: list[str]) -> None:
    yaml = cfg_path.read_text()
    patched = yaml.replace("gpt-5.6-sol", "gpt-5.5")
    if patched != yaml:
        commands.append("patched modelbot.yaml gpt-5.6-sol → gpt-5.5")
        step("init yaml: gpt-5.6-sol → gpt-5.5 (Completions start path)")
    block = "strict_allowlist:\n" + "".join(f"    - {o}\n" for o in origins)
    new, n = re.subn(r"strict_allowlist:\s*\[\s*\]", block.rstrip(), patched, count=1)
    if n != 1:
        raise RuntimeError("strict_allowlist: [] not found in modelbot.yaml")
    commands.append(f"seeded policy.strict_allowlist ({len(origins)} origins)")
    step(f"init yaml: strict_allowlist {len(origins)} origins")
    cfg_path.write_text(new if new.endswith("\n") else new + "\n")
    os.chmod(cfg_path, 0o600)


def expect_outcome(task) -> str:
    exp = task.get("expect")
    if isinstance(exp, str):
        return exp
    if isinstance(exp, dict):
        ev = exp.get("event") or ""
        if ev in ("takeover_request", "takeover.requested"):
            return "takeover"
        if ev == "spend_cap":
            return "spend_cap"
    return "complete"


def render_prompt(suite, task, computer_name: str) -> str:
    defaults = suite.get("defaults", {})
    max_steps = task.get("max_steps", defaults.get("max_steps", 60))
    timeout_sec = task.get("timeout_sec", defaults.get("timeout_sec", 300))
    spend = task.get("spend_cap_usd", defaults.get("spend_cap_usd", 2.0))
    sites = "\n".join(f"- {s}" for s in task.get("sites", [])) or "- (none)"
    tmpl = PROMPT_PATH.read_text()
    return (
        tmpl.replace("{{task_id}}", task["id"])
        .replace("{{computer_name}}", computer_name)
        .replace("{{max_steps}}", str(max_steps))
        .replace("{{timeout_sec}}", str(timeout_sec))
        .replace("{{spend_cap_usd}}", str(spend))
        .replace("{{goal}}", task["goal"])
        .replace("{{sites}}", sites)
        .replace("{{acceptance}}", task["acceptance"])
        .replace("{{expect}}", expect_outcome(task))
    )


def read_claude_oauth():
    code, out, _, _ = run_cmd(
        ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
        timeout=10,
    )
    if code != 0:
        return None
    try:
        doc = json.loads(out)
        tok = (doc.get("claudeAiOauth") or {}).get("accessToken") or ""
        exp = (doc.get("claudeAiOauth") or {}).get("expiresAt") or 0
        if not tok:
            return None
        if exp and exp < time.time() * 1000:
            return None
        return tok
    except Exception:
        return None


def http_json(opener, method, url, body=None, headers=None, timeout=180):
    from urllib.error import HTTPError, URLError

    data = None if body is None else json.dumps(body).encode()
    req = Request(url, data=data, method=method)
    req.add_header("content-type", "application/json")
    req.add_header("origin", "http://127.0.0.1:7777")
    req.add_header("host", "127.0.0.1:7777")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with opener.open(req, timeout=timeout) as resp:
            raw = resp.read().decode()
            return resp.status, json.loads(raw) if raw else {}
    except HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            parsed = json.loads(raw) if raw else {}
        except Exception:
            parsed = {"raw": raw}
        return e.code, parsed
    except (URLError, TimeoutError, OSError) as e:
        return 0, {"error": type(e).__name__}


UI_ORIGIN = "http://127.0.0.1:7777"
UI_HOST = "127.0.0.1"
UI_PORT = 7777
STAND_IN_ENDPOINTS = [
    "GET /api/v1/takeovers",
    "GET /api/v1/audit",
    "GET /api/v1/computers/:id/quarantine",
    "POST /api/v1/computers/:id/quarantine/:item_id/promote",
    "GET /api/v1/takeover/:id/status",
    "POST /api/v1/takeover/:id/acquire",
    "WS /api/v1/live/:computer_id (t=pointer|text|key, type live.pointer|live.text|live.key)",
    "POST /api/v1/takeover/:id/release",
]


class StandInTracker:
    def __init__(self):
        self.used = False
        self.reason = None
        self.handled: set[str] = set()
        self.busy = False
        self.audit_types: list[str] = []
        self.interventions = 0
        self.promotions = 0
        self.fail_reason = None


def cookie_header(jar) -> str:
    return "; ".join(f"{c.name}={c.value}" for c in jar)


LIVE_RELAY_JS = r"""
const fs = require("node:fs");
const raw = fs.readFileSync(0, "utf8");
const { cookie, computerId, messages, epoch: seedEpoch } = JSON.parse(raw);
let epoch = Number(seedEpoch) > 0 ? Number(seedEpoch) : 0;
const ws = new WebSocket(
  `ws://127.0.0.1:7777/api/v1/live/${encodeURIComponent(computerId)}`,
  { headers: { Cookie: cookie, Origin: "http://127.0.0.1:7777" } },
);
function ingest(data) {
  if (typeof data !== "string") return;
  try {
    const m = JSON.parse(data);
    if (m && (m.t === "hello" || m.t === "mode") && Number(m.epoch) > 0) {
      epoch = Number(m.epoch);
    }
  } catch {}
}
ws.addEventListener("message", (ev) => ingest(ev.data));
ws.addEventListener("error", () => process.exit(2));
ws.addEventListener("open", async () => {
  const t0 = Date.now();
  while (epoch <= 0 && Date.now() - t0 < 2500) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 500));
  for (const m of messages) {
    const delay = Number(m._delay_ms) || 400;
    const { _delay_ms, ...rest } = m;
    if (epoch > 0) rest.epoch = epoch;
    ws.send(JSON.stringify(rest));
    await new Promise((r) => setTimeout(r, delay));
  }
  await new Promise((r) => setTimeout(r, 800));
  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(3), 45000);
"""


def run_live_relay(jar, computer_id: str, messages: list, epoch: int = 0) -> None:
    payload = {
        "cookie": cookie_header(jar),
        "computerId": computer_id,
        "messages": messages,
        "epoch": epoch,
    }
    proc = subprocess.run(
        ["node", "-e", LIVE_RELAY_JS],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=50,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"live ws relay exit {proc.returncode}")


def _relay_base(epoch: int = 0) -> dict:
    return {
        "v": 1,
        "epoch": epoch,
        "viewport": {"w": 1280, "h": 720, "dpr": 1},
        "dpr": 1,
    }


def msg_move(x: float, y: float, delay_ms: int = 80, epoch: int = 0) -> dict:
    return {
        **_relay_base(epoch),
        "t": "pointer",
        "type": "live.pointer",
        "kind": "move",
        "x": x,
        "y": y,
        "buttons": 0,
        "_delay_ms": delay_ms,
    }


def msg_click(x: float, y: float, delay_ms: int = 250, epoch: int = 0) -> list:
    extra = delay_ms // 2
    return [
        {
            **_relay_base(epoch),
            "t": "pointer",
            "type": "live.pointer",
            "kind": "down",
            "x": x,
            "y": y,
            "button": 0,
            "buttons": 1,
            "_delay_ms": extra,
        },
        {
            **_relay_base(epoch),
            "t": "pointer",
            "type": "live.pointer",
            "kind": "up",
            "x": x,
            "y": y,
            "button": 0,
            "buttons": 0,
            "_delay_ms": extra,
        },
    ]


def msg_key(key: str, delay_ms: int = 400, epoch: int = 0) -> dict:
    return {
        **_relay_base(epoch),
        "t": "key",
        "type": "live.key",
        "code": key,
        "key": key,
        "mods": 0,
        "_delay_ms": delay_ms,
    }


def msg_text(text: str, delay_ms: int = 400, epoch: int = 0) -> dict:
    return {
        **_relay_base(epoch),
        "t": "text",
        "type": "live.text",
        "text": text,
        "_delay_ms": delay_ms,
    }


def form_click_xy(sites: list, rnd: int = 0) -> dict:
    """CSS-px targets at 1280x720. saucedemo form is the right column; the-internet uses large-6 left."""
    joined = " ".join(sites)
    i = rnd % 3
    if "saucedemo" in joined:
        user = ((850.0, 325.0), (800.0, 310.0), (880.0, 340.0))
        pw = ((850.0, 385.0), (800.0, 370.0), (880.0, 400.0))
        btn = ((850.0, 445.0), (800.0, 430.0), (880.0, 460.0))
        return {"user": user[i], "pw": pw[i], "btn": btn[i]}
    if "the-internet" in joined:
        user = ((280.0, 220.0), (320.0, 240.0), (240.0, 200.0))
        pw = ((280.0, 290.0), (320.0, 310.0), (240.0, 270.0))
        btn = ((200.0, 360.0), (240.0, 380.0), (180.0, 340.0))
        return {"user": user[i], "pw": pw[i], "btn": btn[i]}
    return {"user": (640.0, 300.0), "pw": (640.0, 360.0), "btn": (640.0, 420.0)}


def stand_in_messages(task: dict, cfg: dict, rnd: int = 0, epoch: int = 0) -> list:
    pts = form_click_xy(task.get("sites") or [], rnd)
    user = str(cfg.get("username") or "")
    pw = str(cfg.get("password") or "")
    submit = str(cfg.get("submit") or "Enter")
    ux, uy = pts["user"]
    px, py = pts["pw"]
    bx, by = pts["btn"]
    msgs: list = []
    if rnd == 1:
        msgs.append(msg_key("Tab", 400, epoch))
        msgs.append(msg_text(user, 500, epoch))
        msgs.append(msg_key("Tab", 400, epoch))
        msgs.append(msg_text(pw, 500, epoch))
        msgs.append(msg_key(submit, 700, epoch))
        msgs.extend(msg_click(bx, by, 400, epoch))
        return msgs
    msgs.extend(msg_click(ux, uy, 400, epoch))
    msgs.append(msg_text(user, 500, epoch))
    msgs.extend(msg_click(px, py, 400, epoch))
    msgs.append(msg_text(pw, 500, epoch))
    msgs.append(msg_key(submit, 700, epoch))
    # Enter is the definitive submit for the-internet. A later coordinate click
    # can land on /secure after navigation and disturb the authenticated page.
    if task.get("id") != THE_INTERNET_AUTH_TASK:
        msgs.extend(msg_click(bx, by, 400, epoch))
    return msgs


def takeover_epoch_from_body(body) -> int:
    if not isinstance(body, dict):
        return 0
    candidates = [body]
    for key in ("takeover", "store", "data"):
        v = body.get(key)
        if isinstance(v, dict):
            candidates.append(v)
            inner = v.get("data")
            if isinstance(inner, dict):
                candidates.append(inner)
    for src in candidates:
        n = src.get("epoch")
        if isinstance(n, bool):
            continue
        if isinstance(n, (int, float)) and n > 0:
            return int(n)
        if isinstance(n, str) and n.isdigit() and int(n) > 0:
            return int(n)
    return 0


def computer_takeover_state(opener, tid: str) -> str:
    st, body = http_json(
        opener,
        "GET",
        f"http://127.0.0.1:7777/api/v1/takeover/{tid}/status",
        timeout=8,
    )
    if st != 200:
        return ""
    tk = body.get("takeover") if isinstance(body.get("takeover"), dict) else {}
    store = body.get("store") if isinstance(body.get("store"), dict) else {}
    return str(tk.get("state") or store.get("state") or "")


def parse_audit_body(rec: dict) -> dict:
    raw = rec.get("body_json") if rec.get("body_json") is not None else rec.get("body")
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw:
        try:
            parsed = json.loads(raw)
        except Exception:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def takeover_reason_from_audit(opener, tid: str) -> str:
    st, body = http_json(opener, "GET", "http://127.0.0.1:7777/api/v1/audit?limit=80", timeout=8)
    if st != 200:
        return ""
    for rec in body.get("records") or []:
        if not isinstance(rec, dict) or rec.get("type") != "takeover.requested":
            continue
        raw = parse_audit_body(rec)
        if str(raw.get("takeover_id") or "") == tid:
            return str(raw.get("reason") or "")
    return ""


def collect_takeover_audit_types(opener) -> list[str]:
    st, body = http_json(opener, "GET", "http://127.0.0.1:7777/api/v1/audit?limit=60", timeout=8)
    if st != 200:
        return []
    out: list[str] = []
    for rec in body.get("records") or []:
        if not isinstance(rec, dict):
            continue
        typ = rec.get("type")
        if isinstance(typ, str) and typ.startswith("takeover."):
            out.append(typ)
    return out


def wait_takeover_state(opener, tid: str, want: str, timeout: float = 20) -> bool:
    aliases = {
        "human": {"human"},
        "agent": {"agent", "released"},
        "requested": {"requested", "takeover_requested"},
    }.get(want, {want})
    t0 = time.time()
    while time.time() - t0 < timeout:
        st, body = http_json(
            opener,
            "GET",
            f"http://127.0.0.1:7777/api/v1/takeover/{tid}/status",
            timeout=8,
        )
        if st == 200:
            tk = body.get("takeover") if isinstance(body.get("takeover"), dict) else {}
            store = body.get("store") if isinstance(body.get("store"), dict) else {}
            state = str(tk.get("state") or store.get("state") or "")
            if state in aliases:
                return True
        time.sleep(0.3)
    return False


def perform_stand_in(opener, csrf: str, jar, computer_id: str, task: dict, tid: str, cfg: dict, tracker: StandInTracker) -> bool:
    try:
        st, body = http_json(
            opener,
            "POST",
            f"http://127.0.0.1:7777/api/v1/takeover/{tid}/acquire",
            headers={"x-csrf-token": csrf},
            timeout=45,
        )
        if st != 200:
            log(f"stand_in acquire → {st}")
            return False
        # Count the grant immediately. Cap bounds grants, not full relay/release success.
        tracker.interventions += 1
        epoch = takeover_epoch_from_body(body)
        step("stand_in granted via POST /api/v1/takeover/:id/acquire")
        if not wait_takeover_state(opener, tid, "human", 25):
            log("stand_in wait human timeout")
            return False
        time.sleep(0.6)
        # the-internet has deterministic corrected coordinates. Sending its Tab
        # fallback after Enter can activate /secure links and lose the login page.
        rounds = range(1) if task.get("id") == THE_INTERNET_AUTH_TASK else range(3)
        for rnd in rounds:
            st_s, status_body = http_json(
                opener,
                "GET",
                f"http://127.0.0.1:7777/api/v1/takeover/{tid}/status",
                timeout=8,
            )
            if st_s == 200:
                refreshed = takeover_epoch_from_body(status_body)
                if refreshed > 0:
                    epoch = refreshed
            run_live_relay(
                jar,
                computer_id,
                stand_in_messages(task, cfg, rnd, epoch),
                epoch,
            )
            tracker.used = True
            time.sleep(
                THE_INTERNET_LOGIN_SETTLE_SEC
                if task.get("id") == THE_INTERNET_AUTH_TASK
                else 3.5
            )
        st, _body = http_json(
            opener,
            "POST",
            f"http://127.0.0.1:7777/api/v1/takeover/{tid}/release",
            headers={"x-csrf-token": csrf},
            timeout=45,
        )
        if st != 200:
            log(f"stand_in release → {st}")
            return False
        if wait_takeover_state(opener, tid, "agent", 8):
            tracker.audit_types = collect_takeover_audit_types(opener)
            step("stand_in released via POST /api/v1/takeover/:id/release")
            return True
        state = computer_takeover_state(opener, tid)
        log(f"stand_in still {state or 'unknown'} after release")
        return False
    except Exception as exc:
        log(f"stand_in failed: {clip(str(exc))}")
        return False


def poll_stand_in(opener, csrf: str, jar, computer_id: str, task: dict, tracker: StandInTracker) -> None:
    if tracker.busy or not computer_id or tracker.fail_reason:
        return
    cfg = task.get("stand_in") if isinstance(task.get("stand_in"), dict) else None
    st, body = http_json(opener, "GET", "http://127.0.0.1:7777/api/v1/takeovers", timeout=8)
    if st != 200:
        return
    for row in body.get("takeovers") or []:
        if not isinstance(row, dict):
            continue
        if row.get("computer_id") and row.get("computer_id") != computer_id:
            continue
        tid = row.get("id")
        state = str(row.get("state") or "")
        if not isinstance(tid, str) or not tid or tid in tracker.handled:
            continue
        if state not in ("takeover_requested", "requested"):
            continue
        reason = takeover_reason_from_audit(opener, tid)
        if not cfg or cfg.get("on") != "password_field":
            continue
        if reason != "password_field":
            continue
        tracker.reason = reason
        if tracker.interventions >= STAND_IN_MAX_INTERVENTIONS:
            tracker.fail_reason = STAND_IN_CAP_EXHAUSTED
            log(STAND_IN_CAP_EXHAUSTED)
            return
        tracker.busy = True
        tracker.handled.add(tid)
        granted_before = tracker.interventions
        try:
            perform_stand_in(opener, csrf, jar, computer_id, task, tid, cfg, tracker)
            if tracker.interventions == granted_before:
                tracker.handled.discard(tid)
        finally:
            tracker.busy = False
        return


def poll_download_promotion(opener, csrf: str, computer_id: str, task: dict, tracker: StandInTracker) -> None:
    if task.get("id") != THE_INTERNET_AUTH_TASK or not computer_id or tracker.promotions:
        return
    base = f"http://127.0.0.1:7777/api/v1/computers/{quote(computer_id, safe='')}"
    st, body = http_json(opener, "GET", f"{base}/quarantine", timeout=8)
    if st != 200:
        return
    items = body.get("items") if isinstance(body, dict) else []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        item_id = item.get("id")
        name = str(item.get("name") or "")
        if not isinstance(item_id, str) or not item_id or not name.lower().endswith(".txt"):
            continue
        st, _ = http_json(
            opener,
            "POST",
            f"{base}/quarantine/{quote(item_id, safe='')}/promote",
            headers={"x-csrf-token": csrf},
            timeout=20,
        )
        if st == 200:
            tracker.promotions += 1
            step("stand_in approved download via UI quarantine promotion route")
            return


def run_agent_with_stand_in(
    argv,
    env,
    timeout,
    opener,
    csrf,
    jar,
    computer_id,
    task,
    run_dir: Path,
    input_text=None,
):
    tracker = StandInTracker()
    out_path = run_dir / f"agent-{task['id']}.out"
    err_path = run_dir / f"agent-{task['id']}.err"
    stdin_arg = subprocess.PIPE if input_text is not None else subprocess.DEVNULL
    with out_path.open("w") as so, err_path.open("w") as se:
        proc = subprocess.Popen(
            argv,
            stdout=so,
            stderr=se,
            env=env or os.environ.copy(),
            cwd=str(ROOT),
            stdin=stdin_arg,
        )
        if input_text is not None:
            try:
                raw = input_text.encode() if isinstance(input_text, str) else input_text
                proc.stdin.write(raw)
            except Exception:
                pass
            try:
                proc.stdin.close()
            except Exception:
                pass
        t0 = time.time()
        timed = False
        rc = 1
        while True:
            polled = proc.poll()
            if polled is not None:
                rc = polled
                break
            if time.time() - t0 > timeout:
                proc.terminate()
                try:
                    proc.wait(5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                timed = True
                rc = 124
                break
            try:
                poll_stand_in(opener, csrf, jar, computer_id, task, tracker)
                poll_download_promotion(opener, csrf, computer_id, task, tracker)
            except Exception as exc:
                log(f"stand_in poll: {clip(str(exc))}")
            if tracker.fail_reason:
                proc.terminate()
                try:
                    proc.wait(5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                rc = proc.poll()
                if rc is None:
                    rc = 1
                break
            time.sleep(0.4)
    so_text = out_path.read_text(errors="replace")
    se_text = err_path.read_text(errors="replace")
    if not tracker.reason:
        leftover = takeover_reason_from_audit(opener, next(iter(tracker.handled), ""))
        if leftover:
            tracker.reason = leftover
        elif not tracker.reason:
            types_now = collect_takeover_audit_types(opener)
            if types_now and not tracker.audit_types:
                tracker.audit_types = types_now
    return rc, so_text, se_text, timed, tracker


def load_last():
    if not RESULTS.exists():
        return {}
    try:
        return json.loads(RESULTS.read_text())
    except Exception:
        return {}


def healthz_ok() -> bool:
    c, _, _, _ = run_cmd(
        ["curl", "-sf", "--max-time", "1", "http://127.0.0.1:7777/healthz"],
        timeout=3,
    )
    return c == 0


def snapshot_workspace(src: Path, dest: Path) -> Path:
    dest.mkdir(parents=True, exist_ok=True)
    if not src.exists() or not src.is_dir():
        return dest
    for item in src.iterdir():
        target = dest / item.name
        if item.is_file():
            shutil.copy2(item, target)
        elif item.is_dir():
            shutil.copytree(item, target, dirs_exist_ok=True)
    return dest


def audit_seq(path: Path) -> int:
    if not path.exists():
        return 0
    last = 0
    for line in path.read_text(errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        seq = rec.get("seq")
        if isinstance(seq, int):
            last = seq
    return last


def audit_slice(path: Path, seq0: int):
    events: list[str] = []
    tool_calls = 0
    takeover = False
    spend = False
    last = seq0
    if not path.exists():
        return events, tool_calls, takeover, spend, last
    for line in path.read_text(errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        seq = rec.get("seq")
        if isinstance(seq, int):
            if seq <= seq0:
                continue
            last = seq
        typ = str(rec.get("type") or "")
        if not typ:
            continue
        events.append(typ)
        if typ == "tool.call":
            tool_calls += 1
        if typ in ("takeover.requested", "takeover_request"):
            takeover = True
        body = rec.get("body") if isinstance(rec.get("body"), dict) else {}
        reason = str(body.get("reason") or "")
        if typ in ("spend_cap", "audit_spend") or (
            typ == "policy.denied" and reason == "spend_cap"
        ):
            spend = True
        tool = str(body.get("tool") or rec.get("tool") or "")
        if is_request_takeover_tool(tool):
            takeover = True
    return events, tool_calls, takeover, spend, last


def audit_cap_records(path: Path, seq0: int) -> list[tuple[str, str]]:
    """Return cap-related record types/reasons in the current attempt window."""
    found: list[tuple[str, str]] = []
    if not path.exists():
        return found
    for line in path.read_text(errors="replace").splitlines():
        try:
            rec = json.loads(line)
        except Exception:
            continue
        seq = rec.get("seq")
        if isinstance(seq, int) and seq <= seq0:
            continue
        typ = str(rec.get("type") or "")
        if typ not in ("policy.denied", "spend_cap", "audit_spend"):
            continue
        body = rec.get("body") if isinstance(rec.get("body"), dict) else {}
        found.append((typ, str(body.get("reason") or "")))
    return found


CLAUDE_PROVIDER_BUDGET_FLOOR_USD = 3.0  # Avoid provider truncation before daemon cap evidence.


def claude_provider_budget_usd(task_cap: float, suite_default_cap: float) -> float:
    """Keep Claude alive long enough for the daemon's MCP proxy cap to observe a call."""
    return max(float(task_cap), float(suite_default_cap), CLAUDE_PROVIDER_BUDGET_FLOOR_USD)


def tool_base_name(name: str) -> str:
    n = str(name or "").strip()
    if n.startswith("mcp__modelbot__"):
        return n[len("mcp__modelbot__"):]
    if "." in n and n.split(".", 1)[0] in ("modelbot", "mcp"):
        return n.split(".", 1)[1]
    return n


def is_request_takeover_tool(name: str) -> bool:
    return tool_base_name(name) == "request_takeover"


def walk_tool_names(obj):
    if isinstance(obj, dict):
        for k in ("name", "tool", "tool_name"):
            v = obj.get(k)
            if isinstance(v, str) and v:
                yield v
        for v in obj.values():
            yield from walk_tool_names(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from walk_tool_names(v)


def parse_claude_stream(text: str):
    tool_calls = 0
    final_text = ""
    model = None
    takeover = False
    spend = False
    usd_est = None
    num_turns = None
    for line in text.splitlines():
        s = line.strip()
        if not s.startswith("{"):
            continue
        try:
            obj = json.loads(s)
        except Exception:
            continue
        if not isinstance(obj, dict):
            continue
        typ = obj.get("type")
        if typ == "assistant":
            msg = obj.get("message") if isinstance(obj.get("message"), dict) else {}
            if isinstance(msg.get("model"), str) and msg["model"]:
                model = msg["model"]
            content = msg.get("content") or []
            if isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "text":
                        txt = block.get("text")
                        if isinstance(txt, str) and txt.strip():
                            final_text = txt
                    if block.get("type") == "tool_use":
                        tool_calls += 1
                        name = str(block.get("name") or "")
                        if is_request_takeover_tool(name):
                            takeover = True
            elif isinstance(content, str) and not final_text:
                final_text = content
        elif typ == "result":
            blob = str(obj.get("result") or "")
            if isinstance(obj.get("result"), str):
                final_text = obj["result"]
            if isinstance(obj.get("num_turns"), int):
                num_turns = obj["num_turns"]
            if isinstance(obj.get("total_cost_usd"), (int, float)):
                usd_est = float(obj["total_cost_usd"])
            if isinstance(obj.get("modelUsage"), dict):
                keys = list(obj["modelUsage"].keys())
                if keys and not model:
                    model = keys[0]
            if re.search(
                r"spend_cap|max-budget|budget.{0,40}(exceed|reached|limit)",
                blob,
                re.I,
            ):
                spend = True  # informational; scoring uses audit_slice only
            if re.search(r"request_takeover", blob):
                takeover = True
        name = str(obj.get("name") or "")
        if is_request_takeover_tool(name) and typ == "tool_use":
            takeover = True
    if not final_text:
        final_text = ""
    return {
        "tool_calls": tool_calls,
        "final_text": final_text,
        "model": model,
        "takeover": takeover,
        "spend": spend,
        "usd_est": usd_est,
        "num_turns": num_turns,
    }


def extract_codex_model(text: str) -> str | None:
    m = CODEX_MODEL_RE.search(text)
    return m.group(1) if m else None


def quota_text(text: str) -> str | None:
    if not QUOTA_RE.search(text):
        return None
    lines = []
    for line in text.splitlines():
        if QUOTA_RE.search(line):
            lines.append(line.strip())
    if lines:
        return " | ".join(lines[:4])
    return clip(text, 400)


def parse_codex_stream(text: str):
    tool_calls = 0
    final_text = ""
    model = extract_codex_model(text)
    takeover = False
    spend = False
    usd_est = None
    num_turns = None
    seen_tools: set[int] = set()
    for line in text.splitlines():
        s = line.strip()
        if not s.startswith("{"):
            continue
        try:
            obj = json.loads(s)
        except Exception:
            continue
        if not isinstance(obj, dict):
            continue
        if isinstance(obj.get("model"), str) and obj["model"] and not model:
            model = obj["model"]
        item = obj.get("item") if isinstance(obj.get("item"), dict) else {}
        usage = obj.get("usage") if isinstance(obj.get("usage"), dict) else {}
        if isinstance(usage.get("cost_usd"), (int, float)):
            usd_est = float(usage["cost_usd"])
        typ = str(obj.get("type") or "")
        if typ in ("item.completed", "agent_message", "turn.completed"):
            for key in ("text", "message", "last_agent_message"):
                v = obj.get(key) or item.get(key)
                if isinstance(v, str) and v.strip():
                    final_text = v
        for name in walk_tool_names(obj):
            base = tool_base_name(name)
            if base in TOOL_NAME_SET:
                h = hash((typ, name, id(obj)))
                if h not in seen_tools:
                    seen_tools.add(h)
                    tool_calls += 1
            if is_request_takeover_tool(name):
                takeover = True
        if item.get("type") in ("mcp_tool_call", "function_call", "tool_call"):
            iname = str(item.get("name") or item.get("tool") or "")
            if iname and tool_base_name(iname) in TOOL_NAME_SET:
                tool_calls += 1
            if is_request_takeover_tool(iname):
                takeover = True
    if re.search(
        r"spend_cap|max-budget|budget.{0,40}(exceed|reached|limit)",
        text,
        re.I,
    ):
        spend = True
    if not final_text:
        parts = re.split(r"^codex:\s*$", text, flags=re.M)
        if len(parts) > 1:
            final_text = parts[-1].strip()
    return {
        "tool_calls": tool_calls,
        "final_text": final_text,
        "model": model,
        "takeover": takeover,
        "spend": spend,
        "usd_est": usd_est,
        "num_turns": num_turns,
    }


def node_json(flag: str, path: Path, timeout=30):
    code, out, err = run_cmd(NODE + [str(GOLDEN_RUN), flag, str(path)], timeout=timeout)[:3]
    return code, out, err


def score_attempt(run_dir: Path, payload: dict) -> dict:
    path = run_dir / f"score-{payload['task_id']}-{payload.get('attempt', 0)}.json"
    path.write_text(json.dumps(payload) + "\n")
    code, out, err = node_json("--score-row", path)
    if code != 0:
        raise RuntimeError(f"score-row exit {code}: {clip(err or out)}")
    return json.loads(out)


def ingest_doc(run_dir: Path, doc: dict) -> tuple:
    path = run_dir / "ingest.json"
    path.write_text(json.dumps(doc, indent=2) + "\n")
    return node_json("--ingest", path, timeout=30)


STUCK_TAKEOVER_STATES = frozenset({
    "takeover_requested",
    "requested",
    "paused",
    "expired",
})


def release_takeovers(opener, csrf: str) -> None:
    try:
        status, body = http_json(opener, "GET", "http://127.0.0.1:7777/api/v1/takeovers")
    except Exception:
        return
    if status != 200:
        return
    for row in body.get("takeovers") or []:
        tid = row.get("id")
        state = str(row.get("state") or "")
        if not tid:
            continue
        if state in ("agent", "released", "expired", "terminated"):
            continue
        # requested/paused: /release is E_POLICY; decline is the FSM abort to agent.
        action = "decline" if state in ("takeover_requested", "requested", "paused") else "release"
        try:
            http_json(
                opener,
                "POST",
                f"http://127.0.0.1:7777/api/v1/takeover/{tid}/{action}",
                headers={"x-csrf-token": csrf},
            )
        except Exception:
            pass


def ephemeral_computer_name(task_id: str) -> str:
    safe = re.sub(r"[^a-z0-9_-]+", "-", str(task_id).lower()).strip("-")[:24]
    return f"g23i{os.getpid()}-{safe}"[:48]


def resolve_workspace(data_dir: Path, computer_id: str, computer_name: str) -> Path:
    ws = data_dir / "computers" / computer_id / "workspace"
    if ws.exists():
        return ws
    alt = data_dir / "computers" / computer_name / "workspace"
    return alt if alt.exists() else ws


def create_ephemeral_computer(opener, csrf: str, name: str, data_dir: Path):
    t0 = time.time()
    status, body = http_json(
        opener,
        "POST",
        "http://127.0.0.1:7777/api/v1/computers",
        {"name": name, "capabilities": ["browser", "shell"]},
        headers={"x-csrf-token": csrf},
    )
    computer_id = (body.get("computer") or {}).get("id")
    create_ms = int((time.time() - t0) * 1000)
    if status not in (200, 201) or not computer_id:
        raise RuntimeError(f"computer create failed ({status}): {clip(json.dumps(body))}")
    ws_host = resolve_workspace(data_dir, computer_id, name)
    return computer_id, ws_host, create_ms


def bind_harness_task(
    opener,
    csrf: str,
    task_id: str,
    computer_id: str,
    spend_cap_usd: float,
    max_steps: int,
) -> None:
    step(
        f"harness binding POST task={task_id} computer={computer_id} "
        f"spend_cap_usd={spend_cap_usd} max_steps={max_steps}"
    )
    status, body = http_json(
        opener,
        "POST",
        "http://127.0.0.1:7777/api/v1/harness-bindings",
        {
            "task_id": task_id,
            "computer_id": computer_id,
            "execution": "harness",
            "spend_cap_usd": spend_cap_usd,
            "max_steps": max_steps,
        },
        headers={"x-csrf-token": csrf},
    )
    step(f"harness binding status={status} task={task_id}")
    if status not in (200, 201):
        raise RuntimeError(f"harness binding failed ({status}): {clip(json.dumps(body))}")


def destroy_ephemeral_computer(opener, csrf: str, computer_id: str) -> int:
    if not computer_id:
        return 0
    t0 = time.time()
    try:
        http_json(
            opener,
            "DELETE",
            f"http://127.0.0.1:7777/api/v1/computers/{computer_id}",
            headers={"x-csrf-token": csrf},
        )
    except Exception:
        pass
    return int((time.time() - t0) * 1000)


def cleanup_stuck_takeover(opener, csrf: str, computer_id: str) -> bool:
    """Abort leftover requested/paused leases via /decline (agent). Grant+release bounces still_sensitive→human."""
    if not computer_id:
        return False
    try:
        status, body = http_json(
            opener, "GET", "http://127.0.0.1:7777/api/v1/takeovers", timeout=8
        )
    except Exception:
        return False
    if status != 200:
        return False
    used = False
    for row in body.get("takeovers") or []:
        if not isinstance(row, dict):
            continue
        if row.get("computer_id") and row.get("computer_id") != computer_id:
            continue
        tid = row.get("id")
        listed = str(row.get("state") or "")
        if not isinstance(tid, str) or not tid:
            continue
        if listed not in STUCK_TAKEOVER_STATES:
            continue
        try:
            st, _body = http_json(
                opener,
                "POST",
                f"http://127.0.0.1:7777/api/v1/takeover/{tid}/decline",
                headers={"x-csrf-token": csrf},
                timeout=45,
            )
            wait_takeover_state(opener, tid, "agent", 8)
            post = computer_takeover_state(opener, tid) or listed
            log(f"takeover_cleanup used decline={st} listed={listed} state={post}")
            if st == 200:
                used = True
        except Exception as exc:
            log(f"takeover_cleanup failed: {clip(str(exc))}")
    return used


def lifecycle_evidence(create_ms: int, destroy_ms: int, cleanup_used: bool) -> list:
    extra = []
    if cleanup_used:
        extra.append(
            {
                "clause": "takeover_cleanup",
                "status": "used",
                "detail": "decline",
            }
        )
    extra.append(
        {
            "clause": "computer_lifecycle",
            "status": "ok",
            "detail": f"create_ms={create_ms} destroy_ms={destroy_ms}",
        }
    )
    return extra


def append_row_evidence(row: dict, extra: list) -> None:
    ev = list(row.get("evidence") or [])
    seen = {(e.get("clause"), e.get("status")) for e in extra if isinstance(e, dict)}
    ev = [
        e
        for e in ev
        if not (isinstance(e, dict) and (e.get("clause"), e.get("status")) in seen)
    ]
    ev.extend(extra)
    row["evidence"] = ev


def append_measurements(rss, rows, label, harness: str):
    stamp = datetime.now(timezone.utc).isoformat()
    active = [r for r in rows if r.get("harness") == harness]
    heading = f"## WP23f golden harness ({harness}, criteria=v2-artefact)"
    lines = [
        "",
        heading,
        "",
        f"Captured: {stamp}",
        f"Mode: harness-real · active={harness} · {label}",
        "",
        "| Task | Verdict | Exit0 | Steps | Tool calls | Time ms | Evidence |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in active:
        ev = r.get("notes", "")
        if r.get("evidence"):
            ev = "; ".join(
                f"{e.get('clause')}:{e.get('status')}" for e in r["evidence"]
            )
        lines.append(
            f"| {r.get('task_id')} | {r.get('status')} | "
            f"{'yes' if r.get('exit0') else 'no'} | {r.get('steps', 0)} | "
            f"{r.get('tool_calls', 0)} | {r.get('time_ms', 0)} | {str(ev).replace('|', '/')} |"
        )
    lines += [
        "",
        "| Metric | Value |",
        "| --- | --- |",
        f"| Daemon RSS (KB) | {rss.get('daemon_rss_kb', 'n/a')} |",
        f"| Container MemUsage | {rss.get('container_rss', 'n/a')} |",
        "",
    ]
    block = "\n".join(lines)
    MEASUREMENTS.parent.mkdir(parents=True, exist_ok=True)
    if MEASUREMENTS.exists():
        cur = MEASUREMENTS.read_text()
        esc = re.escape(heading)
        if heading in cur:
            cur = re.sub(
                esc + r"[\s\S]*?(?=\n## |\n*$)",
                block.strip() + "\n\n",
                cur,
            )
            MEASUREMENTS.write_text(cur)
        else:
            MEASUREMENTS.write_text(cur.rstrip() + "\n" + block)
    else:
        MEASUREMENTS.write_text("# Measurements\n" + block)


def evidence_summary(row: dict) -> str:
    ev = row.get("evidence") or []
    if ev:
        return "; ".join(f"{e.get('clause')}:{e.get('status')}" for e in ev)
    return str(row.get("notes") or "")


def write_column_report(path: Path, title: str, verdict, files, commands, probes, rows, harness, follow_ups, spec_issues):
    active = [r for r in rows if r.get("harness") == harness]
    table = [
        "| task | verdict | exit0 | steps | tool_calls | evidence summary |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for r in active:
        table.append(
            f"| {r.get('task_id')} | {r.get('status')} | "
            f"{'yes' if r.get('exit0') else 'no'} | {r.get('steps', 0)} | "
            f"{r.get('tool_calls', 0)} | {evidence_summary(r).replace('|', '/')} |"
        )
    fails = [
        f"- {r['task_id']}: {r.get('status')} · {evidence_summary(r)}"
        for r in active
        if r.get("status") != "PASS"
    ]
    lines = [
        title,
        "",
        verdict,
        "",
        "## Files created/changed",
        "",
        *[f"- {f}" for f in files],
        "",
        "## Commands (exit codes)",
        "",
        *[f"- {c}" for c in commands],
        "",
        "## Probes",
        "",
        *[f"- {p['harness']}: {'OK' if p.get('ok') else 'NO'} — {p.get('detail', '')}" for p in probes],
        "",
        f"## {harness} rows",
        "",
        *table,
        "",
        "## Non-PASS reasons",
        "",
        *(fails or ["- (none)"]),
        "",
        "## Spec issues",
        "",
        *[f"- {s}" for s in spec_issues],
        "",
        "## Follow-ups",
        "",
        *[f"- {f}" for f in follow_ups],
        "",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines))


def skip_quota_row(task_id: str, harness: str, notes: str) -> dict:
    return {
        "task_id": task_id,
        "harness": harness,
        "status": "SKIP",
        "verdict": "SKIP",
        "exit0": False,
        "steps": 0,
        "tool_calls": 0,
        "time_ms": 0,
        "takeover": False,
        "notes": f"SKIP(quota) {notes}",
        "evidence": [],
    }


def seed_codex_skill() -> None:
    src = FLAVOUR / "skills" / "modelbot-computer" / "SKILL.md"
    dst = CODEX_HOME / "skills" / "modelbot-computer" / "SKILL.md"
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def merge_results(base: list, active_rows: list) -> list:
    replaced = {(r.get("task_id"), r.get("harness")) for r in active_rows}
    kept = [r for r in base if (r.get("task_id"), r.get("harness")) not in replaced]
    return kept + active_rows


def merge_probes(base: list, new_probe: dict) -> list:
    out = [p for p in base if p.get("harness") != new_probe.get("harness")]
    out.append(new_probe)
    return out


def score_and_collect(
    run_dir: Path,
    task: dict,
    harness: str,
    parsed: dict,
    audit_path: Path,
    seq0: int,
    ws_host: Path,
    attempt: int,
    rc: int,
    timed: bool,
    t0: float,
    se: str,
    so: str,
    stand_in: StandInTracker | None = None,
) -> dict:
    events, audit_tools, audit_tk, audit_spend, _ = audit_slice(audit_path, seq0)
    cap_records = audit_cap_records(audit_path, seq0)
    cap_detail = ",".join(
        f"{typ}(reason={reason or '-'})" for typ, reason in cap_records
    ) or "none"
    step(
        f"audit slice task={task['id']} attempt={attempt} "
        f"parsed_tool_calls={parsed['tool_calls']} audit_tool_calls={audit_tools} "
        f"cap_records={cap_detail}"
    )
    snap = snapshot_workspace(ws_host, run_dir / "ws" / task["id"] / f"a{attempt}")
    tool_calls = max(parsed["tool_calls"], audit_tools)
    takeover = bool(parsed["takeover"] or audit_tk)
    spend_hit = bool(audit_spend)
    if spend_hit and "spend_cap" not in events:
        events.append("spend_cap")
    if takeover and "takeover.requested" not in events:
        events.append("takeover.requested")
    steps = parsed["num_turns"] if parsed["num_turns"] is not None else tool_calls
    exit0 = rc == 0 and not timed
    reason = None
    if spend_hit:
        reason = "spend_cap"
    elif takeover:
        reason = "takeover"
    if timed:
        notes = f"timeout after {TASK_TIMEOUT}s"
    else:
        notes = clip(parsed["final_text"] or se or so, 180)
    if parsed.get("spend") and not spend_hit:
        notes = clip(f"{notes} [transcript spend mention informational]", 180)
    stand = stand_in or StandInTracker()
    stand_status = "used" if stand.used else "unused"
    stand_cfg = task.get("stand_in") if isinstance(task.get("stand_in"), dict) else None
    stand_reason = stand.reason or "" if (stand.used or stand_cfg) else ""
    if stand.fail_reason:
        reason = stand.fail_reason
        notes = stand.fail_reason
        exit0 = False
    scored = score_attempt(
        run_dir,
        {
            "task_id": task["id"],
            "harness": harness,
            "exit0": exit0,
            "processExit0": exit0,
            "steps": steps,
            "tool_calls": tool_calls,
            "time_ms": int((time.time() - t0) * 1000),
            "usd_est": parsed["usd_est"],
            "takeover": takeover,
            "notes": notes,
            "reason": reason,
            "events": events,
            "final_text": parsed["final_text"],
            "workspaceRoot": str(snap),
            "attempt": attempt,
        },
    )
    ev = [
        e
        for e in (scored.get("evidence") or [])
        if not (isinstance(e, dict) and e.get("clause") in ("stand_in", "takeover_cleanup"))
    ]
    ev.append(
        {
            "clause": "stand_in",
            "status": stand_status,
            "detail": stand_reason,
        }
    )
    scored["evidence"] = ev
    scored["stand_in"] = stand_status
    scored["stand_in_interventions"] = stand.interventions
    scored["stand_in_download_promotions"] = stand.promotions
    if stand.used and stand_reason:
        scored["takeover_reason"] = stand_reason
    if stand.used and stand.audit_types:
        scored["stand_in_audit"] = list(stand.audit_types)
    if stand.fail_reason:
        scored["reason"] = stand.fail_reason
        scored["status"] = "FAIL"
        scored["verdict"] = "FAIL"
        scored["exit0"] = False
    return scored


def main() -> int:
    date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    suite = load_suite()
    all_tasks = suite["tasks"]
    ids = {t["id"] for t in all_tasks}
    if ONLY_IDS:
        unknown = [i for i in ONLY_IDS if i not in ids]
        if unknown:
            raise SystemExit(f"unknown --only id: {unknown}")
        tasks = [t for t in all_tasks if t["id"] in ONLY_IDS]
    else:
        tasks = all_tasks
    origins = site_origins(suite)
    commands = []
    follow_ups = []
    spec_issues = [
        "CLI `computer create` does not insert into daemon MCP store; used POST /api/v1/computers (mcp-smoke path).",
        "Headless Claude: CLAUDE_CODE_OAUTH_TOKEN from keychain; HOME=owner; temp --mcp-config only.",
        "Claude 2.1.259 help omits --max-turns; flag still passed. The daemon gets the real task MCP proxy cap; Claude's independent provider guard uses at least the suite default so it cannot stop before the first MCP call.",
        "Harness-mode Codex golden uses the ChatGPT account default model (no -m); column label = session-header `model:`.",
        "flavours/codex-modelbot skill copied into $CODEX_HOME/skills; owner AGENTS.md not overwritten.",
    ]
    files = [
        "docs/internal/scoreboard.md",
        "docs/internal/build/golden-last.json",
        "docs/internal/measurements.md",
        "scripts/golden_run_real.py",
        "scripts/golden-run.ts",
        "tests/golden/tasks.json",
    ]
    last = load_last()
    base_results = list(last.get("results") or [])
    probes = list(last.get("probes") or [])
    models = dict(last.get("models") or {})
    models.setdefault("mock-standalone", "mock-golden")
    if "codex" in (last.get("models") or {}) and HARNESS != "codex":
        models["codex"] = last["models"]["codex"]
    if "claude" in (last.get("models") or {}) and HARNESS != "claude":
        models["claude"] = last["models"]["claude"]
    codex_quota = last.get("codexQuota")
    if not base_results:
        spec_issues.append("golden-last.json missing prior rows; merge base empty.")

    step("init: create temp MODELBOT_HOME")
    run_dir = Path(tempfile.mkdtemp(prefix="mb-wp23f-"))
    mb_home = run_dir / "home"
    data_dir = mb_home / "data"
    data_dir.mkdir(parents=True)
    if KEEP_HOME:
        step(f"keep-home enabled home={mb_home}")
    vault_key = os.urandom(32).hex()
    env_base = {**os.environ, "MODELBOT_VAULT_KEY_HEX": vault_key}
    log_path = mb_home / "daemon.log"
    active_rows: list = []
    connected_codex = False
    env_codex = None

    def persist_partial(rows, extra_probes=None, rss=None, versions=None):
        ingest_payload = {
            "date": date,
            "mode": "harness-real",
            "active": HARNESS,
            "criteria": "v2-artefact",
            "models": models,
            "versions": versions or {"claude": None, "node": None, "codex": None},
            "probes": extra_probes if extra_probes is not None else probes,
            "results": merge_results(base_results, rows),
            "rss": rss or {},
            "codexQuota": codex_quota,
        }
        ic, iout, ierr = ingest_doc(run_dir, ingest_payload)
        commands.append(f"golden-run --ingest (partial) → exit {ic}")
        if ic != 0:
            follow_ups.append(f"partial ingest failed: {clip(ierr or iout)}")
        return ic

    code, out, err, _ = mb(
        [
            "init",
            "--home",
            str(mb_home),
            "--data-dir",
            str(data_dir),
            "--skip-images",
            "--quiet",
            "--force",
        ],
        env=env_base,
        timeout=60,
    )
    commands.append(f"modelbot init → exit {code}")
    step(f"init done exit={code}")
    cfg_path = mb_home / "modelbot.yaml"
    if code == 0 and cfg_path.exists():
        try:
            patch_home_yaml(cfg_path, origins, commands)
        except Exception as exc:
            write_column_report(
                REPORT_WP23D if HARNESS == "claude" else REPORT_WP23C,
                "# WP23f yaml patch",
                f"VERDICT: FAIL yaml patch: {clip(str(exc))}",
                files,
                commands,
                probes,
                base_results,
                HARNESS,
                ["fix yaml patch"],
                spec_issues,
            )
            return 1
    if code != 0:
        write_column_report(
            REPORT_WP23D if HARNESS == "claude" else REPORT_WP23C,
            "# WP23f init",
            f"VERDICT: FAIL init: {clip(err or out)}",
            files,
            commands,
            probes,
            base_results,
            HARNESS,
            ["fix init"],
            spec_issues,
        )
        return 1

    tokens = json.loads((mb_home / "tokens.json").read_text())
    mcp_token = tokens["mcp_token"]
    env_home = {
        **env_base,
        "HOME": str(mb_home),
        "MODELBOT_TOKEN": mcp_token,
        "MODELBOT_MCP_TOKEN": mcp_token,
    }

    start_out = start_err = ""
    healthy = False
    last_curl = ""
    for attempt in range(1, HEALTHZ_RETRIES + 1):
        if healthz_ok():
            step(f"port 7777 occupied; wait {HEALTHZ_WAIT_SEC}s ({attempt}/{HEALTHZ_RETRIES})")
            if attempt == HEALTHZ_RETRIES:
                last_curl = "port 7777 still occupied"
                break
            time.sleep(HEALTHZ_WAIT_SEC)
            continue
        step("start: modelbot start --daemon")
        code, start_out, start_err, _ = mb(
            ["start", "--daemon", "--no-open", "--home", str(mb_home)], env=env_home, timeout=30
        )
        commands.append(f"modelbot start --daemon → exit {code}")
        step(f"start done exit={code} {clip(start_out + start_err, 80)}")
        step("healthz: poll http://127.0.0.1:7777/healthz")
        for _ in range(80):
            if healthz_ok():
                healthy = True
                last_curl = "curl exit 0"
                break
            last_curl = "curl miss"
            time.sleep(0.25)
        commands.append(f"healthz → {'ok' if healthy else 'FAIL'} try {attempt}")
        step(f"healthz {'ok' if healthy else 'FAIL'} {last_curl}")
        if healthy:
            break
        mb(["stop", "--home", str(mb_home)], env=env_home, timeout=15)
        if attempt < HEALTHZ_RETRIES:
            step(f"healthz fail; wait {HEALTHZ_WAIT_SEC}s ({attempt}/{HEALTHZ_RETRIES})")
            time.sleep(HEALTHZ_WAIT_SEC)

    if not healthy:
        tail = daemon_log_tail(log_path)
        print(tail, flush=True)
        if not BOOTSTRAP_ONLY:
            write_column_report(
                REPORT_WP23D if HARNESS == "claude" else REPORT_WP23C,
                "# WP23f healthz",
                "VERDICT: FAIL healthz: " + clip(start_out + start_err) + f" ({last_curl})",
                files,
                commands,
                probes,
                base_results,
                HARNESS,
                ["check daemon.log / port 7777"],
                spec_issues,
            )
        return 1

    step("bootstrap: scrape one-time token from daemon.log (R5-9 mint on start)")
    bootstrap_token = extract_bootstrap_token(start_out + "\n" + start_err)
    for _ in range(40):
        if bootstrap_token:
            break
        if log_path.exists():
            bootstrap_token = extract_bootstrap_token(log_path.read_text(errors="replace"))
            if bootstrap_token:
                break
        time.sleep(0.25)
    if not bootstrap_token:
        tail = daemon_log_tail(log_path)
        print(tail, flush=True)
        if not BOOTSTRAP_ONLY:
            write_column_report(
                REPORT_WP23D if HARNESS == "claude" else REPORT_WP23C,
                "# WP23f bootstrap",
                "VERDICT: FAIL bootstrap token not found",
                files,
                commands,
                probes,
                base_results,
                HARNESS,
                ["inspect daemon.log; start must print bootstrap_url"],
                spec_issues,
            )
        mb(["stop", "--home", str(mb_home)], env=env_home, timeout=15)
        return 1
    commands.append("bootstrap token scraped from daemon.log")
    step("bootstrap token scraped")

    _, pid_out, _, _ = mb(["status", "--pid", "--home", str(mb_home)], env=env_home, timeout=10)
    m = re.search(r"(\d+)", pid_out)
    daemon_pid = int(m.group(1)) if m else None

    computer_name = ""
    cookie_jar_path = run_dir / "cookies.txt"
    jar = MozillaCookieJar(str(cookie_jar_path))
    opener = build_opener(HTTPCookieProcessor(jar))
    computer_id = None
    csrf = ""
    audit_path = data_dir / "audit.jsonl"
    harness_label = HARNESS
    claude_ver = ""
    seen_model = None

    try:
        step("session bootstrap POST /api/v1/session/bootstrap")
        status, body = http_json(
            opener,
            "POST",
            "http://127.0.0.1:7777/api/v1/session/bootstrap",
            {"token": bootstrap_token},
        )
        commands.append(f"session bootstrap → {status}")
        step(f"session bootstrap → {status}")
        if status != 200:
            raise RuntimeError(f"session bootstrap {status}: {clip(json.dumps(body))}")
        csrf = body.get("csrf") or ""
        jar.save(ignore_discard=True, ignore_expires=True)
        os.chmod(cookie_jar_path, 0o600)

        env_claude = None
        mcp_cfg = None
        allowed = None

        if HARNESS == "codex":
            env_codex = {
                **os.environ,
                "HOME": str(OWNER_HOME),
                "CODEX_HOME": str(CODEX_HOME),
                "MODELBOT_TOKEN": mcp_token,
                "MODELBOT_MCP_TOKEN": mcp_token,
            }
            seed_codex_skill()
            commands.append("copied flavours/codex-modelbot skill → $CODEX_HOME/skills")
            cc, cout, cerr, _ = mb(
                ["connect", "codex", "--codex-home", str(CODEX_HOME)],
                env=env_codex,
                timeout=30,
            )
            connected_codex = True
            commands.append(f"modelbot connect codex --codex-home → exit {cc}")
            if cc != 0:
                raise RuntimeError(f"connect codex failed: {clip(cerr or cout)}")
            step("codex probe")
            _, vo, _, _ = run_cmd(["codex", "--version"], timeout=10)
            pc, po, pe, _ = run_cmd(
                ["codex", "exec", "reply with exactly: PONG"],
                env=env_codex,
                timeout=45,
                input_text="",
            )
            text = po + "\n" + pe
            q = quota_text(text)
            seen_model = extract_codex_model(text)
            if q:
                codex_quota = q
                commands.append(f"codex probe → SKIP(quota) model={seen_model or 'n/a'}")
                step(f"codex probe SKIP(quota) model={seen_model or 'n/a'}")
                probes[:] = merge_probes(
                    probes,
                    {
                        "harness": "codex",
                        "ok": False,
                        "detail": q,
                        "model": seen_model or "n/a",
                    },
                )
                models["codex"] = seen_model or "quota"
                if not BOOTSTRAP_ONLY:
                    for t in tasks:
                        active_rows.append(skip_quota_row(t["id"], "codex", q))
                    persist_partial(active_rows, probes)
                    write_column_report(
                        REPORT_WP23C,
                        "# WP23c report — Codex golden (criteria=v2-artefact)",
                        f"VERDICT: FAIL quota during probe — {q}",
                        files + ["docs/internal/build/wp23c-report.md"],
                        commands,
                        probes,
                        merge_results(base_results, active_rows),
                        "codex",
                        ["re-run Codex column after quota resets"],
                        spec_issues,
                    )
                step("bootstrap phase SKIP(quota)")
                return 0
            codex_ok = bool(re.search(r"\bPONG\b", text)) and not re.search(
                r"ERROR:|invalid_request_error|not supported", text, re.I
            )
            harness_label = seen_model or "codex-default"
            commands.append(
                f"codex probe → {'ok' if codex_ok else 'no'} model={seen_model or 'n/a'} exit {pc}"
            )
            step(f"codex probe → {'ok' if codex_ok else 'no'} model={seen_model or 'n/a'}")
            probes[:] = merge_probes(
                probes,
                {
                    "harness": "codex",
                    "ok": codex_ok,
                    "detail": clip(vo if codex_ok else text, 400),
                    "model": seen_model or "n/a",
                },
            )
            models["codex"] = harness_label
            if BOOTSTRAP_ONLY:
                step("bootstrap-only: skip harness tasks")
                step("bootstrap phase PASS")
                return 0
            if not codex_ok:
                for t in tasks:
                    active_rows.append(
                        {
                            "task_id": t["id"],
                            "harness": "codex",
                            "status": "FAIL",
                            "verdict": "FAIL",
                            "exit0": False,
                            "steps": 0,
                            "tool_calls": 0,
                            "time_ms": 0,
                            "takeover": False,
                            "notes": clip(text, 180),
                            "evidence": [],
                        }
                    )
                    persist_partial(active_rows, probes)
                    step(f"task {t['id']} FAIL (no codex)")
        else:
            if BOOTSTRAP_ONLY:
                step("bootstrap-only: skip harness tasks")
                step("bootstrap phase PASS")
                return 0
            oauth = read_claude_oauth()
            env_claude = {
                **os.environ,
                "HOME": str(OWNER_HOME),
                "CLAUDE_CODE_OAUTH_TOKEN": oauth or "",
                "MODELBOT_TOKEN": mcp_token,
            }
            claude_ok = False
            claude_detail = "Not logged in · Please run /login"
            step("claude probe")
            _, vo, _, _ = run_cmd(["claude", "--version"], timeout=10)
            claude_ver = clip(vo, 80)
            if oauth:
                if ONLY_IDS:
                    claude_ok = True
                    claude_detail = clip(vo, 400)
                    commands.append("claude probe skipped (--only)")
                    step("claude probe skipped (--only)")
                else:
                    _, po, pe, _ = run_cmd(
                        [
                            "claude",
                            "-p",
                            "reply with exactly: PONG",
                            "--output-format",
                            "text",
                            "--max-turns",
                            "1",
                        ],
                        env=env_claude,
                        timeout=45,
                    )
                    text = po + "\n" + pe
                    claude_ok = bool(re.search(r"\bPONG\b", text)) and not re.search(
                        r"Not logged in", text, re.I
                    )
                    claude_detail = clip(vo if claude_ok else text, 400)
                    commands.append(f"claude probe → {'ok' if claude_ok else 'no'}")
                    step(f"claude probe → {'ok' if claude_ok else 'no'}")
            probes[:] = merge_probes(
                probes,
                {
                    "harness": "claude",
                    "ok": claude_ok,
                    "detail": claude_detail,
                    "model": "claude-code",
                },
            )
            mcp_cfg = run_dir / "claude.mcp.json"
            mcp_cfg.write_text(
                json.dumps(
                    {
                        "mcpServers": {
                            "modelbot": {
                                "type": "http",
                                "url": "http://127.0.0.1:7777/mcp",
                                "headers": {"Authorization": f"Bearer {mcp_token}"},
                            }
                        }
                    },
                    indent=2,
                )
                + "\n"
            )
            os.chmod(mcp_cfg, 0o600)
            allowed = ",".join(f"mcp__modelbot__{n}" for n in TOOL_NAMES)
            if not claude_ok:
                for t in tasks:
                    active_rows.append(
                        {
                            "task_id": t["id"],
                            "harness": "claude",
                            "status": "FAIL",
                            "verdict": "FAIL",
                            "exit0": False,
                            "steps": 0,
                            "tool_calls": 0,
                            "time_ms": 0,
                            "takeover": False,
                            "notes": claude_detail,
                            "evidence": [],
                        }
                    )
                    persist_partial(active_rows, probes, versions={"claude": claude_ver, "node": None})
                    step(f"task {t['id']} FAIL (no claude)")

        defaults = suite.get("defaults", {})
        remaining = [t for t in tasks if not any(r.get("task_id") == t["id"] for r in active_rows)]
        for t in remaining:
            step(f"task {t['id']} start")
            computer_name = ephemeral_computer_name(t["id"])
            prompt = render_prompt(suite, t, computer_name)
            spend = t.get("spend_cap_usd", defaults.get("spend_cap_usd", 2.0))
            provider_spend = claude_provider_budget_usd(
                spend, defaults.get("spend_cap_usd", 2.0)
            )
            max_steps = t.get("max_steps", defaults.get("max_steps", 60))
            step(
                f"harness budgets task={t['id']} mcp_proxy_cap_usd={spend} "
                f"claude_provider_cap_usd={provider_spend}"
            )
            last_row = None
            quota_hit = None
            create_ms = 0
            destroy_ms = 0
            cleanup_used = False
            ws_host = data_dir / "computers" / computer_name / "workspace"
            try:
                step(f"computer create name={computer_name}")
                computer_id, ws_host, create_ms = create_ephemeral_computer(
                    opener, csrf, computer_name, data_dir
                )
                bind_harness_task(
                    opener, csrf, t["id"], computer_id, spend, max_steps
                )
                commands.append(f"API computer create {t['id']} → id set create_ms={create_ms}")
                step(f"computer create → id=set create_ms={create_ms}")
                log(f"computer {computer_id}")
                commands.append(f"workspace host {t['id']} → {ws_host.exists()}")
                for attempt in range(1, MAX_ATTEMPTS + 1):
                    release_takeovers(opener, csrf)
                    seq0 = audit_seq(audit_path)
                    t0 = time.time()
                    if HARNESS == "claude":
                        argv = [
                            "claude",
                            "-p",
                            prompt,
                            "--output-format",
                            "stream-json",
                            "--verbose",
                            "--mcp-config",
                            str(mcp_cfg),
                            "--strict-mcp-config",
                            "--max-turns",
                            "40",
                            "--max-budget-usd",
                            str(provider_spend),
                            "--permission-mode",
                            "bypassPermissions",
                            "--allowedTools",
                            allowed,
                        ]
                        rc, so, se, timed, tracker = run_agent_with_stand_in(
                            argv,
                            env=env_claude,
                            timeout=TASK_TIMEOUT,
                            opener=opener,
                            csrf=csrf,
                            jar=jar,
                            computer_id=computer_id,
                            task=t,
                            run_dir=run_dir,
                        )
                        text = so + "\n" + se
                        parsed = parse_claude_stream(text)
                    else:
                        argv = [
                            "codex",
                            "exec",
                            "--json",
                            "-s",
                            "workspace-write",
                            "--skip-git-repo-check",
                            "-c",
                            'approval_policy="never"',
                            prompt,
                        ]
                        rc, so, se, timed, tracker = run_agent_with_stand_in(
                            argv,
                            env=env_codex,
                            timeout=TASK_TIMEOUT,
                            opener=opener,
                            csrf=csrf,
                            jar=jar,
                            computer_id=computer_id,
                            task=t,
                            run_dir=run_dir,
                            input_text="",
                        )
                        text = so + "\n" + se
                        quota_hit = quota_text(text)
                        parsed = parse_codex_stream(text)
                        if parsed["model"]:
                            seen_model = parsed["model"]
                        if quota_hit:
                            break
                    if parsed.get("model"):
                        seen_model = parsed["model"]
                    scored = score_and_collect(
                        run_dir, t, HARNESS, parsed, audit_path, seq0, ws_host,
                        attempt, rc, timed, t0, se, so, stand_in=tracker,
                    )
                    if cleanup_stuck_takeover(opener, csrf, computer_id):
                        cleanup_used = True
                    last_row = scored
                    log(
                        f"{HARNESS} {t['id']} try{attempt} {scored.get('status')} "
                        f"exit0={scored.get('exit0')} tc={scored.get('tool_calls')} "
                        f"{scored.get('time_ms')}ms stand_in={scored.get('stand_in')}"
                    )
                    if scored.get("status") == "PASS":
                        break
            finally:
                if computer_id:
                    destroy_ms = destroy_ephemeral_computer(opener, csrf, computer_id)
                    commands.append(
                        f"API computer destroy {t['id']} → destroy_ms={destroy_ms}"
                    )
                    step(f"computer destroy {t['id']} destroy_ms={destroy_ms}")
                    computer_id = None
            if quota_hit:
                skip = skip_quota_row(t["id"], "codex", quota_hit)
                append_row_evidence(skip, lifecycle_evidence(create_ms, destroy_ms, cleanup_used))
                active_rows.append(skip)
                codex_quota = quota_hit
                commands.append(f"codex quota at {t['id']}: {clip(quota_hit, 180)}")
                rest = remaining[remaining.index(t) + 1:]
                for rt in rest:
                    active_rows.append(skip_quota_row(rt["id"], "codex", quota_hit))
                persist_partial(active_rows, probes)
                step(f"task {t['id']} SKIP(quota); remaining marked")
                break
            if last_row is None:
                last_row = skip_quota_row(t["id"], HARNESS, "no attempt")
            append_row_evidence(
                last_row, lifecycle_evidence(create_ms, destroy_ms, cleanup_used)
            )
            active_rows.append(last_row)
            persist_partial(
                active_rows,
                probes,
                versions={"claude": claude_ver or None, "node": None, "codex": seen_model},
            )
            step(f"task {t['id']} {last_row.get('status') if last_row else 'FAIL'} attempts done")
            release_takeovers(opener, csrf)

        if HARNESS == "claude":
            harness_label = seen_model or "claude-code"
            if claude_ver:
                harness_label = f"{harness_label} · {claude_ver}"
            models["claude"] = harness_label
        else:
            harness_label = seen_model or models.get("codex") or "codex-default"
            models["codex"] = harness_label

        if BOOTSTRAP_ONLY:
            return 0

        rss = {}
        if daemon_pid:
            _, po, _, _ = run_cmd(["ps", "-o", "rss=", "-p", str(daemon_pid)], timeout=5)
            try:
                rss["daemon_rss_kb"] = int(po.strip())
            except Exception:
                pass
        _, po, _, _ = run_cmd(
            ["docker", "stats", "--no-stream", "--format", "{{.Name}} {{.MemUsage}}"],
            timeout=15,
        )
        lines = [
            l.strip()
            for l in po.splitlines()
            if computer_name in l or (computer_id and computer_id in l) or "modelbot" in l.lower()
        ]
        if lines:
            rss["container_rss"] = "; ".join(lines[:8])

        all_rows = merge_results(base_results, active_rows)
        if not ONLY_IDS:
            append_measurements(rss, all_rows, harness_label, HARNESS)
        ingest_payload = {
            "date": date,
            "mode": "harness-real",
            "active": HARNESS,
            "criteria": "v2-artefact",
            "models": models,
            "versions": {"claude": claude_ver or None, "node": None, "codex": seen_model},
            "probes": probes,
            "results": all_rows,
            "rss": rss,
            "codexQuota": codex_quota,
        }
        ic, iout, ierr = ingest_doc(run_dir, ingest_payload)
        commands.append(f"golden-run --ingest → exit {ic}")
        step(f"ingest done exit={ic}")
        if ic != 0:
            follow_ups.append(f"ingest failed: {clip(ierr or iout)}")

        judged = [r for r in active_rows if r.get("harness") == HARNESS]
        p = sum(1 for r in judged if r.get("status") == "PASS")
        if ONLY_IDS:
            verdict = (
                f"VERDICT: PASS ({p}/{len(judged)} evidence-based PASS, --only)"
                if p == len(judged) and p > 0
                else f"VERDICT: FAIL {p}/{len(judged)} evidence-based PASS (--only)"
            )
            return 0 if p == len(judged) and p > 0 else 1
        if HARNESS == "codex":
            verdict = (
                f"VERDICT: PASS ({p}/12 evidence-based PASS)"
                if p >= 8
                else f"VERDICT: FAIL {p}/12 evidence-based PASS (need ≥8)"
            )
            if codex_quota and p < 8:
                verdict = f"VERDICT: FAIL {p}/12 evidence-based PASS (quota: {codex_quota})"
            write_column_report(
                REPORT_WP23C,
                "# WP23c report — Codex golden (criteria=v2-artefact)",
                verdict,
                files + ["docs/internal/build/wp23c-report.md"],
                commands,
                probes,
                all_rows,
                "codex",
                follow_ups or ["None if PASS; else collect missing artefacts and re-run failing rows."],
                spec_issues,
            )
            return 0 if p >= 8 else (0 if codex_quota else 1)
        verdict = (
            f"VERDICT: PASS ({p}/12 evidence-based PASS)"
            if p >= 8
            else f"VERDICT: FAIL {p}/12 evidence-based PASS (need ≥8)"
        )
        write_column_report(
            REPORT_WP23D,
            "# WP23d report — Claude golden re-run (criteria=v2-artefact)",
            verdict,
            files + ["docs/internal/build/wp23d-report.md"],
            commands,
            probes,
            all_rows,
            "claude",
            follow_ups or ["None if PASS; else collect missing artefacts and re-run failing rows."],
            spec_issues,
        )
        return 0 if p >= 8 else 1

    except Exception as exc:
        step(f"FAIL {clip(str(exc))}")
        tail = daemon_log_tail(log_path)
        print(tail, flush=True)
        if not BOOTSTRAP_ONLY:
            write_column_report(
                REPORT_WP23D if HARNESS == "claude" else REPORT_WP23C,
                "# WP23f exception",
                f"VERDICT: FAIL {clip(str(exc))}",
                files,
                commands,
                probes,
                merge_results(base_results, active_rows),
                HARNESS,
                follow_ups + ["see exception"],
                spec_issues,
            )
        return 1
    finally:
        step("teardown: destroy computer + stop daemon")
        if connected_codex:
            try:
                rc, _, _, _ = mb(
                    ["connect", "codex", "--remove", "--codex-home", str(CODEX_HOME)],
                    env=env_codex or {**os.environ, "CODEX_HOME": str(CODEX_HOME)},
                    timeout=30,
                )
                commands.append(f"modelbot connect codex --remove → exit {rc}")
            except Exception as exc:
                commands.append(f"connect --remove failed: {clip(str(exc))}")
        if computer_id:
            try:
                http_json(
                    opener,
                    "DELETE",
                    f"http://127.0.0.1:7777/api/v1/computers/{computer_id}",
                    headers={"x-csrf-token": csrf},
                )
            except Exception:
                pass
        mb(["stop", "--home", str(mb_home)], env=env_home, timeout=15)
        try:
            if cookie_jar_path.exists():
                cookie_jar_path.unlink()
        except OSError:
            pass
        step("teardown done")
        if KEEP_HOME:
            scrub_retained_credentials(run_dir, mb_home)
            step(f"keep-home retained home={mb_home}")
        else:
            shutil.rmtree(run_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
