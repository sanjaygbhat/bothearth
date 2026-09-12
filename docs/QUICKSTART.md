# Quickstart

Give BotHearth a task, watch its computer, and open the files it saves. This guide takes you from a source install on Mac or Linux to your first task. You’ll connect your own model account and use BotHearth in a browser; the optional Mac window and paired phone access come later.

This is a pre-release checkout. You build it from source; `npx bothearth` is not a verified path.

With Docker and Node already installed, expect about 15–40 minutes to a saved file. A cold Mac that still needs Docker is closer to an hour.

## Run it

You need macOS or Linux, Node.js 22.18 or newer, and an eligible Claude Code or Codex account. Codex is verified live; Claude Code is listed and not yet verified live. The bot’s computer image includes both official CLIs.

### 1. Install a container runtime

Allow 15–40 minutes if you still need Docker; skip this step if `docker info` already works.

Your bot works in separate containers. On macOS, install [OrbStack](https://orbstack.dev), [Docker Desktop](https://www.docker.com/products/docker-desktop/), or Colima. On Linux, use Docker Engine. Start the runtime, leave it running, and check `docker info`.

BotHearth offers one free business bot under its [business permission](../COMMERCIAL.md), with additional business bots at US$49 each, once. Outputs may be sold; reselling or hosting a copy of the BotHearth service is excluded from standard grants. Docker Desktop and OrbStack apply their own eligibility rules: [Docker Desktop license](https://docs.docker.com/subscription-billing/desktop-license/) and [OrbStack licensing](https://docs.orbstack.dev/licensing). Model accounts and optional rented servers are separate costs.

Docker Engine, OrbStack, Colima and Docker Desktop are all supported. Podman is experimental. Windows needs WSL2.

### 2. Clone the source

```bash
git clone https://github.com/sanjaygbhat/bothearth.git
cd bothearth
```

### 3. Build

About 2–8 minutes on a clean Node 22 install.

```bash
npm ci && npm run build
```

You do not need `npm ci --prefix computer-server` to build or run BotHearth. The container image installs Playwright itself and symlinks it in, so that install is only for the `computer-server` unit tests and its own typecheck.

### 4. Link the command

```bash
npm link
```

`npm link` puts both `bothearth` and the compatible `modelbot` alias on your PATH. If you would rather not link it globally, every `bothearth …` in these docs works as `node dist/cli/index.js …` from the checkout.

### 5. Initialize

```bash
bothearth init
```

Initialization uses the OS keychain automatically (macOS Keychain, or an unlocked Secret Service on Linux). This writes `~/.modelbot/modelbot.yaml`, private tokens, and an encrypted vault under `~/ModelBot`. A headless Linux server can use an [encrypted systemd credential](REMOTE-DEPLOY.md#headless-vault-across-host-restart). Keep a vault and its key together; `--force` overwrites initialization state and cannot recover encrypted data. CLI passphrase unlock is unavailable, so initialization does not offer a passphrase setup it cannot reopen.

### 6. Start BotHearth

```bash
bothearth start
```

`start` binds `127.0.0.1:7777` and prints one line:

```text
Open http://127.0.0.1:7777/#bootstrap=…
This link works for 10 minutes. Lost it? Run: bothearth pair
```

On macOS it opens that link in your default browser for you; `--no-open` stops it. Keep the link to yourself — anyone holding it has full operator access.

Leave the terminal running, or use `bothearth start --daemon` and `bothearth stop`. `--daemon` prints the same link. Stopping BotHearth pauses native Codex and Claude tasks and saves their conversation. After restarting, review the current page and choose **Resume**; computer control requires a fresh handoff. Use a task's **Stop** button to cancel it deliberately.

### 7. Open the pairing link

Init, start, and pair together usually take 1–3 minutes.

**The link expires after 10 minutes**, and it is single use. If it expires, if you lose it, or if you want to open BotHearth in a second browser or on another device, run `bothearth pair` in another terminal for a fresh one.

That browser stays signed in as long as you use it at least once every 7 days and for at most 30 days from when you paired it, and stopping and starting BotHearth does not sign you out; after that, run `bothearth pair` for a new link.

### 8. Sign in to a model inside the bot

Provider device sign-in is usually 2–8 minutes. The first image build is 8–25 minutes.

The chip in the top right identifies the selected model and its connection state. Open **Settings** (the gear) → **Model connection** and choose Claude Code or Codex. BotHearth prepares its computer and starts the official CLI there. **Sign in with ChatGPT** shows Codex’s device sign-in; **Copy code and open ChatGPT** opens the official page, with manual copying available if the clipboard is blocked. **Sign in through Claude Code** shows that CLI’s private sign-in instructions and reply field. The built-in setup does not copy host login files into the computer.

The first sign-in or task needs container images, and there are no prebuilt ones to pull. BotHearth offers to build them; from the terminal, the same build is:

```bash
bothearth image build
```

It downloads Chromium, the native CLIs and their Linux dependencies, so it takes several minutes and a few GB of disk. Build again when a source update makes the images stale. Build the images this way rather than by hand — BotHearth stamps them at build time and treats an unstamped image as out of date.

BotHearth keeps the CLI’s login and conversation history in that computer’s separate model home. Historical host tasks still use their original host CLI/login when resumed. Home rechecks the selected connection when you return from Settings. Your draft stays in place; completing sign-in does not start it automatically. Provider terms, plan eligibility, usage limits and charges apply; free BotHearth software does not include model access.

### 9. Run a first task

A small public-page task you can check yourself usually takes 3–10 minutes if the model cooperates.

Choose **Provider** and **Model** on Home. Model choices come from the installed CLI where available; cached or suggested choices are labelled, and the provider checks account access when the task starts. You can enter an exact **Custom model ID**. A saved model choice is kept; BotHearth does not silently switch a running task to another model.

**Use subagents** is a plain checkbox, unchecked for every new task. Leave it unchecked for direct execution. Checking it reveals **Subagent model**, where you can choose the provider and model used for delegated work. Reloading or starting another task does not retain this opt-in.

Type what you want in plain language and press `⌘↩` (`Ctrl↩` on Linux), or click **Start task**. Pick something small you can check yourself the first time — one of the examples under **TRY** is a good start. Replace its website placeholder with a real URL.

The task view puts the activity feed on the left and the live view of its computer on the right, under **ITS COMPUTER**. The selected model stays visible. **Model messages** shows or hides narration while keeping your messages, tool steps, requests for input and the final result available. **Take control** requests full screen; `Esc` leaves full screen without returning control. Underneath, the tool-use estimate, **Steps so far** and **Files it has saved** update as it works. **Stop** ends the task.

## What the task cost means

The task view shows an estimate of tool use, not a bill. **Settings → Usage** shows recorded estimates by task and day. There is no BotHearth spend cap or call cap. A task runs until it is done, until you stop it, or until your model subscription’s usage limit is reached; then it pauses and can resume.

For Claude Code and Codex tasks, BotHearth counts each MCP computer tool call as an estimated cent by default. Native shell commands and model requests are not fully counted by this meter; it is not your provider bill. Standalone API estimates depend on reported usage and configured prices; an in-flight request can exceed an estimate. Configure spending controls with the provider.

When a provider usage limit pauses the task, recorded task history and saved files remain available. **Resume** continues after the provider allows more work; an external website action may not continue exactly where it stopped.

### Long tasks

A long task can still pause for reasons you control, all of them in `~/.modelbot/modelbot.yaml` unless noted:

| Limit | Default | Key |
|---|---|---|
| How long an optional review prompt stays answerable | 15 minutes | `policy.approval_ttl_sec` |
| How long you can hold control with no input | 10 minutes | `takeover.ttl_sec` |

`bothearth init` writes none of these, so you get the defaults until you set one yourself. Every key is listed in [configuration](CONFIG.md).

## When it asks you something

Review prompts are off by default. Settings → Sensitive actions → **Ask before sensitive actions** turns them on or off and writes `policy.gates` in `modelbot.yaml` (the six optional classes, or empty). Expand the section to choose which gates fire, and to set API-adapter max tool calls and spend cap (0 = no limit); native Codex and Claude Code tasks have no BotHearth cap. A yaml that still lists `policy.gates` from an earlier install keeps asking until you turn the checkbox off or empty the list. Optional prompts cover detected sends, uploads, deletes, checkout steps and new-site form submits through BotHearth’s browser tools; expand the card, then choose **Don't allow** or **Allow once**. Some site permissions can be remembered for the task. Password, OTP, passkey, CAPTCHA and payment-card fields are not gates: they always pause for **Take control**. Checkout without a card field is the optional `payment` class. Strict mode also restricts destinations. Native CLI shell/network tools run inside the computer with their own capabilities and do not pass through these MCP action checks. If an optional review prompt goes unanswered for 15 minutes, the task pauses — press **Resume** when ready.

Use **Message BotHearth** to ask questions or redirect a running task. Messages reach the runner at its next opportunity; an in-progress action may finish first. You can leave messages during human control, but guest model processes remain frozen until you return it. Messages go to the chosen model, so enter passwords in the computer instead. Sending a message does not approve an action or return control.

## Taking control

When a site needs a password, a code, a CAPTCHA or a payment-card field, press **Take control** — or **Take control instead** on the card — to operate the bot’s full desktop: browser chrome, windows, files and a terminal. The conversation stays visible. Take control requests full screen; `Esc` leaves full screen without giving control back. Click inside the computer before typing. `Ctrl+Alt+T` opens Terminal and `Ctrl+Alt+E` opens Files. Before control is acknowledged, native model processes freeze and model capture is blocked; the operator desktop stays usable. The site receives your input normally. `⌘V` / `Ctrl+V` pastes into the page, so a password manager works.

A line above the frame counts down the lease. Ten minutes without input pauses control; it does not return capture to the agent automatically. Every click or keystroke resets that clock. Press **Give control back** (`⌘↩`) when the step is done and BotHearth validates the page before resuming. A remaining sensitive-field signal can prevent handback.

If your bot is wrong about needing you — it thinks a search box is a one-time-code field, say — press **Not needed, continue** on the card and it goes on without you.

The optional `agent.max_runtime_sec` setting can also pause a long task; its default is zero, with no runtime ceiling. An expired review prompt or control lease leaves the task paused until you return.

### Your bot stays signed in

Sites you sign into stay signed in on your bot's computer, from one task to the next and across restarts — the browser profile lives with the computer, not with the task. That is what makes "check my mail" work a second time without signing in again. It also means the sign-in is sitting there until you remove it: **Settings → Computers → Use a fresh one** throws that computer away, browser profile and all, and your bot builds a clean one on your next task.

## Where files land

Files your bot saves stay on your machine. The command-line install keeps its data in `~/ModelBot`, with one workspace folder per computer under `~/ModelBot/computers`. The Mac app uses `~/Library/Application Support/ModelBot` instead, with workspaces under `.../ModelBot/data`. Both are configurable — see [`data_dir` and `sandbox.workspace_root`](CONFIG.md).

Browser downloads stay in quarantine until you promote them. Native CLI commands can download directly into the shared workspace. Files saved under `/workspace/out` appear in task results.

## When it finishes

The done screen gives you the result, then **What it did**: the time, estimated tool use, sites visited, requests for input, and saved files. **Read full result** loads a shortened result from the saved record; **Copy result** copies the loaded text. Reports beyond the display limit remain marked as previews, so open their saved files for the rest. **Run again** repeats the task, and **Start another task** returns to Home with **Use subagents** unchecked. Read the result before acting on it or repeating work with external effects.

## Health and shutdown

```bash
curl -fsS http://127.0.0.1:7777/healthz
bothearth doctor
bothearth audit verify
bothearth stop
```

## The Mac app

Optional, and macOS only. It is the same BotHearth in a native window, with menus, a dock icon and keyboard shortcuts — no server to start, no URL to paste.

You need Xcode Command Line Tools as well as Node.

```bash
npm run app:mac
open apps/macos/build/ModelBot.app
```

This builds the daemon and then the app bundle at `apps/macos/build/ModelBot.app`. It is universal, ad-hoc signed and about 1.3 MB. Later rebuilds can skip the JavaScript with `npm run app:mac -- --no-js`.

Ad-hoc signing is why the app cannot post notifications — macOS refuses permission to an unsigned build. The dock badge, the dock bounce, the menu-bar item and the in-window card all still work. A Developer ID certificate fixes it; [apps/macos/README.md](../apps/macos/README.md) explains how.

Everything above — connecting your model, starting a task, optional review prompts, taking control — works the same in the app. If something is not ready yet, the home screen says so in a card above the task box and keeps checking; you can type your task the whole time.

## Your phone

A phone can watch a task and take control while the daemon and computer remain on your host. Task content and live frames travel to the paired phone over the configured connection. Models and visited sites receive their normal task data; see [privacy](../PRIVACY.md).

First give the machine [private HTTPS access](REMOTE-DEPLOY.md) — your phone needs to reach it on its own, and an SSH tunnel on your laptop does not count. Then open **Settings → Devices → Connect a phone**. Scan the QR code with your phone's camera, or use **Copy connection link** and send it to yourself.

The link is one use only. Pairing grants full operator access, so send it only to your own phone. **Revoke access** removes a device you no longer have.

You can open the link in the phone browser, or use a [native Android or iOS build](../mobile/README.md). Native builds are pre-release: simulator acceptance does not establish physical-device, cellular, background-notification or store readiness.

## Driving BotHearth from your own harness

You can point your own Codex, Claude, Gemini, Cursor, OpenCode or Copilot harness at BotHearth over MCP. That is separate from the task runner above; see [harness connections](HARNESS-INTEGRATIONS.md).

Scheduled tasks currently need a standalone provider rather than Claude Code or Codex. The standalone Chat Completions adapter does not support GPT-5.6 or newer — use those through their official harness.

Stuck? [Troubleshooting](TROUBLESHOOTING.md) covers what usually goes wrong.
