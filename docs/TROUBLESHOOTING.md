# Troubleshooting

Most of what goes wrong happens before the first task runs, and BotHearth tells you about it on the home screen. This page covers what to do when it does not clear on its own.

Command-line examples use `bothearth <command>`, which is on your PATH after `npm ci && npm run build && npm link`. Without the link, run them as `node dist/cli/index.js <command>` from the checkout. Public npm installation is not a verified path yet.

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

### AI not connected

Open **Settings → AI connection** and sign in with Claude Code or Codex. Install the CLI on the host first — BotHearth uses the one you already have, it does not ship its own. If sign-in opens a browser, finish it there and come back; BotHearth connects on its own. A connection that is already configured is rechecked without another sign-in.

If it says **Found on this Mac · not signed in**, the CLI is installed but has no login. Sign in with that CLI directly, then use the sign-in button here.

## No notification when your bot needs you

Expected on any build that is not properly code-signed, which includes every build from this checkout. macOS refuses notification permission to an ad-hoc signed app, and the log records `notifications denied by the user — not posting`. No entitlement or code change fixes it; it needs a Developer ID certificate, and [apps/macos/README.md](../apps/macos/README.md) explains how to build with one.

Everything else in that loop still works: the dock badge, the dock bounce, the menu-bar item flipping to **Needs you**, and the card in the window. An approval you never answer times out after 15 minutes and pauses the task, so a backgrounded window costs you a wait rather than the work — press **Resume** and it carries on. Until signing is in place, keep the window visible for tasks you expect to be asked about.

In a plain browser the fallback is Web Notifications, which need no signature.

## "This browser or app may not be secure" when you sign in to Google

Should not happen any more. Your bot's browser is a real Chrome build launched without the automation switches Google looks for, so signing in to Google by hand under **Take control** works.

If you do see it, do not work around it with a different browser or an app password — report it, saying which account type and which step it appeared on, and paste the URL from the address line above the frame. Nothing on your side is misconfigured.

Two things that will not work regardless: passkeys and hardware security keys, which need a real device attached to your own machine, not to the container. Use a code-based second factor for anything your bot signs into.

## While a task is running

| What you see | What to do |
|---|---|
| **Getting its computer ready** for a long time | Check the container runtime is running and the images built. Your draft is kept, so you can retry. |
| Browser connection closed, or `computer-server stream closed` | Check the runtime, then open the computer again. Review what already happened before restarting — a closed connection does not prove earlier actions had no effect. |
| Another task is using the browser | Open that task to continue or stop it, or pick a different computer for a one-off task under **Advanced**. |
| A site blocks it, or loops a CAPTCHA | Press **Take control** and do that step yourself. BotHearth does not bypass site defenses. |
| It asks you to take control and there is nothing to do | It guessed a field was a password or a one-time code and was wrong. Press **Not needed, continue** on the card and it carries on without you. |
| A link opens nothing | Initial popups are blocked before contact. Ask it to navigate directly, or take control. |
| Control will not go back | A page still showing a password field keeps human control until it is safe. Finish or leave that step, then press **Give control back** again. |
| **Couldn't finish**, or a stopped task with a partial result | Keep the result and check which actions already happened before starting another. A `fail` or `cancelled` outcome is not success. |
| It cannot write a file | Known gap in this pre-release: no file-write tool is available yet, so tasks that must produce a file will report that no tool can write one. |

Two known reporting bugs in this build: a finished task can show **Done in 0 seconds** regardless of how long it actually took, and the **What it did** counts (steps, sites visited) can change when you navigate away and back. The activity feed is the reliable record.

Browsers paused for inactivity wake on the next tool call or when you open the live view, including after a restart. Listing computers does not wake them.

### The task says it is paused

A pause is not a failure and nothing is lost: the task keeps its computer and its transcript, and **Resume** on the task carries on from the step it stopped at. The card names the reason. The common ones:

| Why it paused | What to do |
|---|---|
| You did not answer an approval | Answer it if it is still on screen, then **Resume**. Approvals time out after 15 minutes; change that with `policy.approval_ttl_sec` in `modelbot.yaml` |
| Human control lapsed | Takeover ends after 10 minutes with no input from you, and every click or keystroke you send resets that clock. Take control again, or **Resume** to give it back to the bot |
| It stopped making progress | 5 minutes with no progress pauses it (`agent.stall_sec`). Read the feed for what it was stuck on before resuming |
| It ran out of steps | The step ceiling is 400 (`agent.max_steps`). The task offers **Resume with more steps**; a task that keeps hitting this usually needs to be asked for something narrower |
| It repeated the same step | Three identical steps in a row pauses it (`agent.loop_identical`). Take control, get past the step, and hand back |
| It ran out of budget | A task gets $20 unless you change it. Press **Resume with a higher budget** and it carries on from where it stopped, with more to spend. To change it for future tasks, set the figure in **Settings → Usage** (or `agent.spend_cap_usd` in `modelbot.yaml`); one task can be given at most $100 (`agent.spend_cap_max_usd`), and asking for more is refused |

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

Task results over 16,000 characters show a marked preview. **Copy saved result** and **Download saved result** fetch the same saved summary, including partial ones from failed or stopped tasks; exports stop at 256,000 characters and say so when they are shortened.
