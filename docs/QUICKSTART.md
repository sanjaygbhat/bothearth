# Quickstart

Give BotHearth a task, watch its computer, and open the files it saves. This guide takes you from a source install on Mac or Linux to your first task. You’ll connect your own model account and use BotHearth in a browser; the optional Mac window and paired phone access come later.

BotHearth is the public name of the project developed as ModelBot. The `bothearth` command and existing `modelbot` alias run the same CLI. Configuration files, environment variables, image names, local `ModelBot` directories, and `ModelBot.app` keep their existing names so installations continue to work.

This is a pre-release checkout. You build it from source; `npx modelbot` is not a verified path.

## Run it

You need macOS or Linux, Node.js 22.18 or newer, and either Claude Code or Codex installed and signed in on this machine.

### 1. Install Docker Desktop or OrbStack

Your bot works in separate containers. On macOS, install [OrbStack](https://orbstack.dev), [Docker Desktop](https://www.docker.com/products/docker-desktop/), or Colima. On Linux, use Docker Engine. Start the runtime and leave it running.

BotHearth offers one free business bot under its [business permission](../COMMERCIAL.md), with additional business bots at US$49 each, once. Outputs may be sold; reselling or hosting a copy of the BotHearth service is excluded from standard grants. Docker Desktop and OrbStack apply their own eligibility rules: [Docker Desktop license](https://docs.docker.com/subscription-billing/desktop-license/) and [OrbStack licensing](https://docs.orbstack.dev/licensing). Model accounts and optional rented servers are separate costs.

Docker Engine, OrbStack, Colima and Docker Desktop are all supported. Podman is experimental. Windows needs WSL2.

### 2. Build it

```bash
git clone https://github.com/sanjaygbhat/bothearth.git
cd bothearth
npm ci && npm run build
npm link
```

`npm link` puts both `bothearth` and the compatible `modelbot` alias on your PATH. If you would rather not link it globally, every `bothearth …` in these docs works as `node dist/cli/index.js …` from the checkout.

You do not need `npm ci --prefix computer-server` to build or run BotHearth. The container image installs Playwright itself and symlinks it in, so that install is only for the `computer-server` unit tests and its own typecheck.

### 3. Initialize

```bash
bothearth init
```

Press Enter at the `vault passphrase` prompt to use the OS keychain (macOS Keychain, or Secret Service on Linux). This writes `~/.modelbot/modelbot.yaml`, private tokens, and a vault under `~/ModelBot`. Keep a vault and its key together; `--force` overwrites initialization state and cannot recover encrypted data.

### 4. Start it and open the link

```bash
bothearth start
```

`start` binds `127.0.0.1:7777` and prints one line:

```text
Open http://127.0.0.1:7777/#bootstrap=…
This link works for 10 minutes. Lost it? Run: bothearth pair
```

On macOS it opens that link in your default browser for you; `--no-open` stops it. Keep the link to yourself — anyone holding it has full operator access.

**The link expires after 10 minutes**, and it is single use. If it expires, if you lose it, or if you want to open BotHearth in a second browser or on another device, run `bothearth pair` in another terminal for a fresh one.

That browser stays signed in as long as you use it at least once every 7 days and for at most 30 days from when you paired it, and stopping and starting BotHearth does not sign you out; after that, run `bothearth pair` for a new link.

Leave the terminal running, or use `bothearth start --daemon` and `bothearth stop`. `--daemon` prints the same link.

### 5. Connect your AI

The chip in the top right shows the connection. If it does not say **connected**, open **Settings** (the gear) and go to **AI connection**. Choose Claude Code or Codex and use its normal sign-in — **Sign in through Claude Code** or **Sign in with ChatGPT**. Install the CLI on the host first: [Codex](https://developers.openai.com/codex/cli/), or [Claude Code setup and terms](CLAUDE-CODE.md). BotHearth uses the CLI you already have; it does not ship its own.

BotHearth remembers the connection. Provider terms, plan eligibility, usage limits, and charges still apply. Read [provider requirements](PROVIDERS.md) before connecting; free BotHearth software does not include model access.

### 6. Your first task

Type what you want in plain language and press `⌘↩` (`Ctrl↩` on Linux), or click **Start task**. Pick something small you can check yourself the first time — one of the examples under **TRY** is a good start.

The task view puts the activity feed on the left and the live view of its computer on the right, under **ITS COMPUTER**. **Full screen** makes the live view bigger; `Esc` leaves it. Underneath, **Total cost**, **Steps so far** and **Files it has saved** update as it works. **Stop** ends the task.

### Building your bot's computer, once

The first task needs container images that do not exist yet, and there are no prebuilt ones to pull. The home screen offers to build them and gets on with it; from the terminal, the same build is:

```bash
bothearth image build
```

It downloads Chromium and its Linux dependencies, so it takes several minutes and a few GB of disk. Build again when a source update makes the images stale. Build the images this way rather than by hand — BotHearth stamps them at build time and treats an unstamped image as out of date.

## What the task cost means

The task view shows **Total cost**, an estimate of work recorded for that task. **Settings → Usage** shows recorded estimates by task and day. The normal task and settings views do not ask you to choose a spending maximum. Internal task limits remain and can pause work.

For Claude Code and Codex tasks, BotHearth counts each computer tool call as an estimated cent by default. This is a work estimate, not a reading of your provider bill. Standalone API estimates depend on reported usage and configured prices; an in-flight request can exceed an estimate. Provider spending controls must be configured with the provider.

When a task reaches its budget it **pauses**. Recorded task history and saved files remain available. The task offers **Resume with a higher budget** to permit more work; resumption is not a guarantee that every external website action continues exactly where it stopped. A task that runs out of steps offers **Resume with more steps** the same way.

### Long tasks

A long task runs into three other limits, all of them in `~/.modelbot/modelbot.yaml` and all of them ending in a pause you can resume:

| Limit | Default | Key |
|---|---|---|
| How long an approval card stays answerable | 15 minutes | `policy.approval_ttl_sec` |
| How long you can hold control with no input | 10 minutes | `takeover.ttl_sec` |
| How many steps one task may take | 400 | `agent.max_steps` |

`bothearth init` writes none of these, so you get the defaults until you set one yourself. Every key is listed in [configuration](CONFIG.md).

## When it asks you something

BotHearth asks for new destinations and detected sends, payments, uploads, and deletes. Expand the card to inspect the proposed action, then choose **Don't allow** or **Allow once**. Some site permissions can be remembered for the task. Ordinary interaction on approved sites and writing a result into the task workspace can proceed without another prompt. The policy does not identify every possible external effect; stay present for sensitive work. If you do not answer within 15 minutes, the task pauses — press **Resume** when you are ready.

## Taking control

When a site needs a password, a code or a CAPTCHA, your bot will not do it. Press **Take control** — or **Take control instead** on the card — and the live view fills the screen and says **You have control**. From then on the frame is yours: type and click in it as if it were your own browser. While you are driving, the model cannot see the screen or what you type. The site still receives it, exactly as it would normally. `⌘V` / `Ctrl+V` pastes into the page, so a password manager works.

A line above the frame counts down the lease. Ten minutes without input pauses control; it does not return capture to the agent automatically. Every click or keystroke resets that clock. Press **Give control back** (`⌘↩`) when the step is done and BotHearth validates the page before resuming. `Esc` leaves full screen without giving control back. A remaining sensitive-field signal can prevent handback.

If your bot is wrong about needing you — it thinks a search box is a one-time-code field, say — press **Not needed, continue** on the card and it goes on without you.

The optional `agent.max_runtime_sec` setting can also pause a long task; its default is zero, with no runtime ceiling. An expired approval or control lease leaves the task paused until you return.

### Your bot stays signed in

Sites you sign into stay signed in on your bot's computer, from one task to the next and across restarts — the browser profile lives with the computer, not with the task. That is what makes "check my mail" work a second time without signing in again. It also means the sign-in is sitting there until you remove it: **Settings → Computers → Use a fresh one** throws that computer away, browser profile and all, and your bot builds a clean one on your next task.

## Where files land

Files your bot saves stay on your machine. The command-line install keeps its data in `~/ModelBot`, with one workspace folder per computer under `~/ModelBot/computers`. The Mac app uses `~/Library/Application Support/ModelBot` instead, with workspaces under `.../ModelBot/data`. Both are configurable — see [`data_dir` and `sandbox.workspace_root`](CONFIG.md).

Anything the bot downloads stays in quarantine until you promote it.

## When it finishes

The done screen gives you the result, then **What it did**: the time, the cost against your budget, the sites it visited, what it asked you, and where it worked. **Open result** shows the saved copy, **Run again** repeats the task, **Start another task** returns you to the task box. Read the result before you act on it.

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

Everything above — connecting your AI, starting a task, approvals, taking control — works the same in the app. If something is not ready yet, the home screen says so in a card above the task box and keeps checking; you can type your task the whole time.

## Your phone

A phone can watch a task and take control while the daemon and computer remain on your host. Task content and live frames travel to the paired phone over the configured connection. Models and visited sites receive their normal task data; see [privacy](../PRIVACY.md).

First give the machine [private HTTPS access](REMOTE-DEPLOY.md) — your phone needs to reach it on its own, and an SSH tunnel on your laptop does not count. Then open **Settings → Devices → Connect a phone**. Scan the QR code with your phone's camera, or use **Copy connection link** and send it to yourself.

The link is one use only. Pairing grants full operator access, so send it only to your own phone. **Revoke access** removes a device you no longer have.

You can open the link in the phone browser, or use a [native Android or iOS build](../mobile/README.md). Native builds are pre-release: simulator acceptance does not establish physical-device, cellular, background-notification or store readiness.

## Driving BotHearth from your own harness

You can point your own Codex, Claude, Gemini, Cursor, OpenCode or Copilot harness at BotHearth over MCP. That is separate from the task runner above; see [harness connections](HARNESS-INTEGRATIONS.md).

Scheduled tasks currently need a standalone provider rather than Claude Code or Codex. The standalone Chat Completions adapter does not support GPT-5.6 or newer — use those through their official harness.

Stuck? [Troubleshooting](TROUBLESHOOTING.md) covers what usually goes wrong.
