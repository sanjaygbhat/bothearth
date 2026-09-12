# Troubleshooting

Most of what goes wrong happens before the first task runs, and BotHearth tells you about it on the home screen. This page covers what to do when it does not clear on its own.

Command-line examples use `bothearth <command>`, which is on your PATH after `npm ci && npm run build && npm link`. Without the link, run them as `node dist/cli/index.js <command>` from the checkout. Public npm installation is not a verified path yet.

## Where are the logs

Structured daemon logs append to `<data_dir>/logs/daemon.log` (`~/ModelBot/logs/daemon.log` by default; `bothearth doctor` prints the resolved path).

## It will not start

### "BotHearth stopped and couldn't get going again. It tried 3 times."

Look at the last few lines of the daemon log — `~/.modelbot/daemon.log` from the command line, `~/Library/Logs/ModelBot/daemon.log` in the Mac app, where **Show log** opens it for you.

If it says `vault: decryption failed (wrong key or corrupt file)`, the encrypted vault and its keychain key are out of sync — the vault was encrypted under a key that no longer exists. **Try again** can never fix this. Discard the unreadable vault and start a new empty one:

```bash
bothearth init --home "$HOME/Library/Application Support/ModelBot" --reset-vault-key --skip-images
```

This moves the old vault aside to `vault.enc.unreadable-<timestamp>` rather than deleting it, and mints a new key. Anything that was in the vault — provider API keys — has to be entered again. Back the home folder up first if you want to keep the option of recovering it.

The app home and the command-line home are different: the app uses `~/Library/Application Support/ModelBot`, the CLI uses `~/.modelbot` with data under `~/ModelBot`. A vault problem in one does not affect the other, which is why the same build can start fine from a terminal and fail from the app. Pass the home you actually mean to `--home`.

`doctor` opens the vault rather than just checking the file is there. `vault: PASS … unlocked` means the master key really decrypted it; a vault the daemon cannot open reports `vault: FAIL` with the same message and the same recovery step the daemon prints.

### Port 7777 is busy

The Mac app handles this itself. If it finds the port held by an earlier BotHearth it started, it stops that one and takes the port back. If the port is held by something else, it leaves it alone, moves to the next free port, and logs both decisions. Look for `port 7777 is held by something we did not start` in the daemon log.

From the command line, `start --port 0` picks any free port, and `--port N` picks a specific one.

An orphaned daemon from an older build can survive a `kill -9` of the app. The current build records its process group at launch and reclaims the port next time, so this should not recur.

## The browser will not let you in

### "Your sign-in link expired"

The link `bothearth start` prints works for 10 minutes and once only. After that — or if you want BotHearth open in a second browser or on another device — you need a new one:

```bash
bothearth pair
```

That prints a fresh link without restarting the daemon or disturbing a running task. Anyone holding it has full operator access, so keep it to yourself. `bothearth pair --list` shows the device sessions that exist and `bothearth pair --revoke <device-id>` removes one.

A link that expired is not the same as being signed out. Once you are in, that browser stays signed in as long as it is used at least once every 7 days and for at most 30 days from pairing, and stopping and starting BotHearth does not end it — after that, run `bothearth pair` for a new link. If you are being asked to pair again after a restart, say so: that is a bug, not the design.

In the Mac app the same situation says to open BotHearth from your Applications folder instead. That is correct there — the app holds its own session, and relaunching it reconnects.

### The link never appeared

`bothearth start --daemon` prints the link on the terminal that launched it. If you have lost that output, do not go looking in `~/.modelbot/daemon.log` — run `bothearth pair` instead.

## The home screen is showing a card

These clear by themselves; the screen checks every couple of seconds and moves on. If one sticks:

### Docker

Your bot needs its own private computer, and Docker is what builds it. Start Docker Desktop or OrbStack and wait for it to finish starting — the whale or the menu-bar item stops animating. BotHearth picks it up without a restart.

### Images being prepared

The first run downloads Chromium and its Linux dependencies into the container images. It takes several minutes on a normal connection and needs a few GB of disk. It only happens once. If it fails, check disk space, then run the build yourself:

```bash
bothearth image build
```

That runs the same three builds the app runs, with the same stamps. Do not build the images with `docker build` by hand: BotHearth labels each image with a stamp of what went into it, a hand build has no stamp, and an unstamped image reads as out of date. There is nothing to `image pull` — no prebuilt images are published yet.

### "Its computer needs an update"

The images on this machine no longer match the sources they were built from — usually after you pulled a newer checkout, sometimes after a hand `docker build`. Some tasks will be turned down until it is fixed. Run `bothearth image build`, or take the offer on the home screen. Your bot's browser profile survives the rebuild; the container is recreated against the same volume, so logged-in sites stay logged in.

### "Its browser will not start"

Its computer is running, but Chromium inside it will not open, so there is nothing for a task to work in. BotHearth keeps trying on its own and the card clears when the browser comes back.

The usual cause is a lock left behind by a browser that was killed rather than closed — a container stopped hard, or the machine went down mid-task. BotHearth now clears that lock itself before it launches, and clears it once more and retries if Chromium still says the profile is in use, so this should heal without you.

If the card stays: read the sentence on it, which carries the browser's own reason. Then

- check the container runtime is running and has disk space left,
- run `bothearth image build` if the computer is also asking for an update,
- and if it still will not open, **Settings → Computers → Use a fresh one**. That throws the computer away, browser profile and all, and builds a clean one on your next task — every site it was signed into will need signing in again.

A message saying the profile is still in use after `SingletonLock`, `SingletonSocket` and `SingletonCookie` were removed means the self-healing already ran and did not work. Worth reporting with the daemon log.

### Model not connected or models not showing

Open **Settings → Model connection** and choose Codex or Claude Code. The computer image includes the official CLIs, and the built-in setup signs in inside that computer. A login on your laptop or host does not automatically connect a new computer. Historical tasks retain their original host login when resumed.

For Codex, use **Sign in with ChatGPT**, then **Copy code and open ChatGPT**. Complete the official device step and return to BotHearth; copy the code manually if your browser blocks clipboard access. If the code expires, start sign-in again. Claude Code shows its own private instructions and reply field in Settings. Enter account replies there, not in task chat.

Home refreshes the chosen connection after Settings and keeps your draft. If the model catalog could not load, use **Retry model choices**. The selected model remains visible even while sign-in is required; a listed model alone does not establish account access. If the provider reports a limit or unavailable model, follow that message or choose another model you can use. When **Use subagents** is checked, its selected provider must also be connected; uncheck it for direct execution.

The app recovers once from a stale session token rejected before a request is accepted. If an old tab still cannot sign in, reload it. Use `bothearth pair` only if the operator session has actually expired. Do not reset the vault, remove a computer, or repeatedly launch new browser windows to refresh model readiness.

### A task page will not open

Use the page’s retry action after a temporary connection failure. A failed load keeps the current view and draft available; later replies from another task cannot replace the task you opened. A sign-in error needs a valid operator session, while a missing task needs the correct task link. Reloading a task page does not start another copy of the task.

## No notification when your bot needs you

Expected on any build that is not properly code-signed, which includes every build from this checkout. macOS refuses notification permission to an ad-hoc signed app, and the log records `notifications denied by the user — not posting`. No entitlement or code change fixes it; it needs a Developer ID certificate, and [apps/macos/README.md](../apps/macos/README.md) explains how to build with one.

Everything else in that loop still works: the dock badge, the dock bounce, the menu-bar item flipping to **Needs you**, and the card in the window. Review prompts are off by default. Settings → Sensitive actions → **Ask before sensitive actions** turns them on or off and writes `policy.gates` in `modelbot.yaml`. Expand the section to choose which gates fire, and to set API-adapter max tool calls and spend cap (0 = no limit); native Codex and Claude Code tasks have no BotHearth cap. A yaml that still lists `policy.gates` from an earlier install keeps asking until you turn the checkbox off or empty the list. If those prompts are on, an unanswered one times out after 15 minutes and pauses the task, so a backgrounded window costs you a wait rather than the work — press **Resume** and it carries on. Password, OTP, passkey, CAPTCHA and payment-card fields always pause for Take control; they are not gates. Checkout steps without a card field are the optional payment prompt. Until signing is in place, keep the window visible for tasks you expect to be asked about.

In a plain browser the fallback is Web Notifications, which need no signature.

## "This browser or app may not be secure" when you sign in to Google

BotHearth's browser is configured so Google's sign-in accepts a person typing during Take control. If that message still appears, note the visible error and the site's hostname, do not share passwords, codes, cookies, or token URLs, and report it.

Passkeys and physical security keys generally are not available to the container desktop. Use another account-approved factor if the site offers one. Model-provider device sign-in in Settings is separate from signing into a website in the bot's browser.

## While a task is running

| What you see | What to do |
|---|---|
| **Getting its computer ready** for a long time | Check the container runtime is running and the images built. Your draft is kept, so you can retry. |
| Browser connection closed, or `computer-server stream closed` | Check the runtime, then open the computer again. Review what already happened before restarting — a closed connection does not prove earlier actions had no effect. |
| Take control shows a blank computer | Current builds initialize the desktop before acknowledging control and keep screen subscriptions across early start/stop transitions. Keep the task and profile, reopen its view, and check image readiness. If it persists, retain the task ID and visible error; do not erase the computer to hide the failure. |
| Another task is using the browser | Open that task to continue or stop it. Check **Settings → Computers** for the computer's status before starting another task. |
| A site blocks it, or loops a CAPTCHA | Press **Take control** and do that step yourself. BotHearth does not bypass site defenses. |
| It asks you to take control and there is nothing to do | Read the stated reason. If no private step is needed, press **Not needed, continue**. Review prompts are off by default; opening a public page does not require a destination prompt. |
| A link opens nothing | Initial popups are blocked before contact. Ask it to navigate directly, or take control. |
| Control will not go back | A page still showing a password field keeps human control until it is safe. Finish or leave that step, then press **Give control back** again. |
| **Couldn't finish**, or a stopped task with a partial result | Keep the result and check which actions already happened before starting another. A `fail` or `cancelled` outcome is not success. |
| It cannot write a file | Current computers can save files in `/workspace/out` using `write_file`. Check the reported path and error. If the computer says it predates file saving, keep the partial result and update that computer before retrying. Open the saved file to verify it. |

Completed task timing and activity are reconstructed from saved task records and durable steps. Older tasks may lack some metadata; use their activity and saved files to check the outcome rather than assuming missing figures mean no work happened.

Browsers paused for inactivity wake on the next tool call or when you open the live view, including after a restart. Listing computers does not wake them.

### The task says it is paused

A paused task retains its computer, transcript and saved files. Read the reason, review the current page, then choose **Resume** when appropriate. External pages and unfinished actions may have changed; resumption is not an exact replay of a website step.

| Why it paused | What to do |
|---|---|
| You did not answer an optional review prompt | Answer it if it is still on screen, then **Resume**. Those prompts exist when **Settings → Sensitive actions → Ask before sensitive actions** is on, or when `modelbot.yaml` still lists `policy.gates`. Turn the checkbox off (or empty the list) to stop them. They time out after 15 minutes; change that with `policy.approval_ttl_sec` in `modelbot.yaml` |
| Human control lapsed | Ten minutes without input leaves control paused, with model capture blocked. Renew control to finish the private step, then explicitly give it back; an ordinary Resume does not approve exposing an unfinished private step. |
| It stopped making progress | Standalone adapters use `agent.stall_sec`. Native Codex/Claude tasks retain their CLI's own execution loop; do not assume quiet model output means a stalled task. Read its actual status before intervening. |
| Your model subscription reached a usage limit | There is no BotHearth spend cap or call cap. When the provider pauses the task, **Resume** after the account allows more work. **Settings → Usage** shows a tool-use estimate, not a bill. |
| It repeated the same step | Standalone adapters apply `agent.loop_identical`; native sessions use their own tool loop. Review the repeated action and message the bot or take control if the site needs you. |

A successful native turn can leave a conversation open for your answer. Reply in task chat when the model asks a question. During human control, guest model processes and their tool children stay frozen, so queued messages reach the model only after you return control. A startup interrupted by takeover can recover automatically only before a native thread or any native output exists; established work is not blindly restarted.

## Command line

| Symptom | Check |
|---|---|
| Missing CLI or UI assets | Run `npm run build`, not `tsc` alone — `tsc` omits the runtime assets |
| Connection refused | Check the start terminal or daemon log; the default is `http://127.0.0.1:7777` |
| Setup link expired or already used | Run `bothearth pair` for a fresh link. The link `start` prints lasts 10 minutes and is single use; the session it gives you lasts while that browser is used at least once every 7 days, for at most 30 days from pairing, and across daemon restarts, after which you run `bothearth pair` for a new link. Do not reinitialize the vault to refresh a session |
| Chromium sandbox fails to launch | Run `bash scripts/image-smoke.sh` on that host. Use the current seccomp profile and a kernel that allows user namespaces. Do not disable the Chromium sandbox |
| MCP tools unavailable | Check `connect <harness> --print`, restart the harness, and make `MODELBOT_TOKEN` available to it |
| MCP cannot reach approvals or the live view | Expected. Those routes need an operator session, not the MCP token |
| Tools return `E_TAKEOVER_BUSY` | Return human control through the interface |
| A GPT-5.6 or newer model is rejected | Standalone uses Chat Completions; use those models through their official harness |
| `security audit` exits nonzero | Read the findings. Development image tags fail digest pinning by design — that is not a production pass |

## Checking the audit log

```bash
bothearth audit verify
```

This reads the configured audit path and vault key. A mismatch can mean corruption, tampering, or simply the wrong key. Preserve the log and the chain-head file before investigating, and never regenerate either to make verification pass.

## Elsewhere

[Configuration](CONFIG.md) · [CLI reference](CLI.md) · [Privacy and retention](../PRIVACY.md) · [Security model](../SECURITY.md) · [Remote deployment](REMOTE-DEPLOY.md)

Task results over 16,000 characters show a marked preview. **Read full result** fetches the saved summary, including partial results from failed or stopped tasks; **Copy result** then copies the loaded text. The display stops at 256,000 characters and says when it remains shortened. **Copy preview** copies only the preview; open the saved output files for the rest.
