# BotHearth — native macOS shell

Swift + AppKit + WKWebView. No Xcode project, no SPM, no third-party dep. Shell owns
window/menus/notifications. Daemon stays Node; UI stays daemon-served.

Optional surface. The shipping path is the server version — `bothearth start` and a browser,
per [docs/QUICKSTART.md](../../docs/QUICKSTART.md). This app is a window over the same daemon.

## Build

    npm run app:mac              # dist/ then app
    npm run app:mac -- --no-js   # app only, dist/ already built (--arm64 skips universal)
    SIGN_IDENTITY="Developer ID Application: NAME (TEAMID)" npm run app:mac   # real signature

Need Xcode Command Line Tools + Node. Out `apps/macos/build/ModelBot.app`: universal (arm64 + x86_64), ad-hoc signed, ~1.3 MB vs Grok Bot 311 MB. Gitignored.

## Run in dev

    open -n --env MODELBOT_REPO=/path/to/repo -a apps/macos/build/ModelBot.app

| Env / arg | Meaning |
|---|---|
| `MODELBOT_REPO` / `--repo DIR` | repo root for `dist/cli/index.js`. Else `MBRepoRoot` baked at build. |
| `MODELBOT_PORT` / `--port N` | preferred port. Default 7777. Taken → next free. |
| `MODELBOT_NODE` | force node binary. Set + wrong = hard fail, no silent fallback. |
| `MODELBOT_DEBUG=1` / `--debug` | Debug menu + Web Inspector. |
| `MODELBOT_DRAG_HEIGHT` | page drag band, default 52. |

Data `~/Library/Application Support/ModelBot` (`--home`), workspace `.../ModelBot/data` —
NOT `~/ModelBot`, that is the CLI's. Log `~/Library/Logs/ModelBot/daemon.log`, token redacted.

## Files (`Sources/`)

`main` boot · `AppDelegate` lifecycle + menu actions + delegates ·
`DaemonSupervisor` spawn, ready handshake, backoff restart max 3, SIGTERM→5s→SIGKILL ·
`MainWindowController` window, WKWebView, same-origin policy, drag band, states ·
`NativeBridge` the 7 methods + the one dispatch · `ErrorStateView` calm error + Back + Cairn mark ·
`AboutPanel` About window, wordmark + version + provider context ·
`StatusItemController` menu-bar item · `MainMenu` menu bar · `Theme` Open Field tokens ·
`Paths` node / daemon / PATH / dirs ·
`NavigationPolicy` what a top-level response may do (pure, selftested) ·
`FileReveal` + `DownloadController` reveal-in-Finder and the download path.

## Bridge

Page → shell: `webkit.messageHandlers.modelbot.postMessage({method, args})` —
`setBadge` `notify` `setTitle` `openExternal` `requestAttention` `setAttention`
`revealFile`. Unknown method or wrong-origin frame dropped. Nothing injected; page CSP
`script-src 'self'` untouched.

`setAttention({waiting})` is how many things are blocked on a person right now. It is the
only thing that decides what the menu-bar item says — a badge alone cannot tell the shell
*why* it is set, so the item must not read "Working" while the bot is stopped and waiting.
`waiting > 0` → **Waiting for you**, filled mark, one dock bounce on the way in; `0` → back
to Idle and the outline mark.

`notify({id, title, body, taskId})` carries `id`, the page's own name for the ping. Posting
always succeeds; showing a banner does not (see *Notifications need a real signature*), so
a ping the shell could not deliver comes back as `notify-failed` and the page falls back to
its own alert.

`revealFile({url, path, resultsDir})` shows a file the bot saved. `resultsDir` + `path`
resolving to a real file on this Mac → `NSWorkspace.activateFileViewerSelecting`. No
`resultsDir` → the URL is fetched **through the web view's own session** (so it carries
the credentials the app already has), saved to Downloads, and revealed. `url` must be the
daemon's own origin and `path` may not traverse. The app is never navigated to it.

Shell → page: `window.dispatchEvent(new CustomEvent("modelbot:native",{detail}))`.
`detail.kind` = `notification-click` | `back` | `notify-failed` | `focus` | `open-settings`
| `new-task` | `open-palette` | `open-keys`. Only JS the shell ever evaluates.

## The main frame is the app, and the app is HTML

A `<a target="_blank">` at `/api/v1/computers/:id/files?path=…` comes back through
`createWebViewWith`, and because the URL *is* the daemon origin every other guard lets it
through — which replaces the whole app with `{"error":"E_IO"}`, no chrome and no way back.

`NavigationPolicy.disposition` decides every **top-level** response from the daemon:

| response | what happens |
|---|---|
| `text/html` on an app route | rendered — this is the app |
| anything else, or any `/api/` or `/files` route | `.download` → saved and revealed in Finder |
| status ≥ 400 | cancelled → the in-app error state, with **Back** as the default button |
| any subframe response | untouched; this rule is only about what would replace the app |

⌘[ is a real menu item (View → Back) bound to `MainWindowController.goBack`, which tries
three things in order: uncover a page an in-app error is sitting on top of, walk the web
view's own history, then hand the page a `back` event — which `native.ts` answers by
clicking the titlebar's own Back button, or going home when there is none. It works from
every state.

Every branch is asserted in `--selftest`.

Page side is `src/ui/native.ts` (`window.modelbotNative`, the typed event bus, the
attention loop, `back` and `notify-failed`) plus `src/ui/palette.ts`, which listens for
`new-task`, `open-settings`, `open-palette`, `open-keys`, `notification-click` and
`focus`. The menu bar claims ⌘N ⌘, ⌘K ⌘/, so those keystrokes never reach the page — the
shell sends the matching event and the page runs the same code path it would in Safari.

## Assets

Menu-bar glyph = `assets/brand/mark-mono.svg` → `Contents/Resources/mark.svg` as a
template image; swap by replacing that SVG (must stay monochrome). Absent → code-drawn
Cairn fallback. Icon = `assets/brand/ModelBot.icns` if present, else built without.

## Notifications need a real signature

The "your bot needs you" banner is `UNUserNotificationCenter`, and macOS refuses to
authorise it for an **ad-hoc signed** bundle — the default build here. Observed on macOS
15.6.1: `requestAuthorization` either errors with `Notifications are not allowed for this
application` or never calls the completion handler, and `authorizationStatus` settles on
`.denied`. This is not a code bug and no entitlement fixes it.

What it needs is a stable, trusted code-signing identity — in practice a **Developer ID
Application** certificate (Apple Developer Program, $99/yr), ideally with notarisation so
Gatekeeper is quiet too. With one in the login keychain:

    security find-identity -v -p codesigning          # find yours
    SIGN_IDENTITY="Developer ID Application: NAME (TEAMID)" npm run app:mac

`build.sh` then signs with `--options runtime --timestamp` instead of ad-hoc, and
`codesign -dv` reports the `Authority` chain rather than `flags=0x2(adhoc)`.

Because the ad-hoc build settles on `.denied`, the shell answers every `notify` it could
not deliver with a `notify-failed` event, and the page falls back to
`src/ui/takeover-pings.ts` — the same path a plain browser takes, which needs no signature
at all.

Everything else in the loop works ad-hoc and is what a contributor sees: the dock badge
(`setBadge`), the dock bounce, the window title becoming **● Needs you — BotHearth**, the
menu-bar item flipping to **Waiting for you** with a filled mark (`setAttention`), and the
in-window card.

## The daemon never outlives the shell

Three ways the shell can end, and the daemon goes with it in all three.

**Quit, or any signal the shell can catch.** `applicationWillTerminate` and a GCD signal
source on SIGTERM / SIGINT / SIGHUP both run the same `shutdownBlocking`: SIGTERM to the
daemon's **process group**, wait 5 s, SIGKILL the group, then a final sweep. The group
matters because `node` starts children of its own, and signalling only the leader could
leave one of them holding the port. `DaemonSupervisor.installExitHandlers()` is what makes
`pkill ModelBot` behave like Quit — before this, it left an orphaned daemon reparented to
launchd, and the next launch walked 7777 → 7778 → 7779 looking for a free port.

**`kill -9`, which nothing can catch.** At launch the shell writes
`shell-daemon.json` (pid, process group, port) into its application-support folder and
deletes it on a clean stop. The next launch reads it: if the preferred port is busy AND the
recorded pid is alive AND `ps` shows it running our own `dist/cli/index.js start`, the
shell stops it and takes its port back. All three conditions must hold — a pid can be
reused, so the name check is what makes it safe to signal.

**A port held by something else entirely.** Left strictly alone. The shell logs
`port 7777 is held by something we did not start — leaving it alone`, walks forward to the
next free port, and logs that too. It will never signal a process it did not start.

Verified end to end: clean Quit, `kill -TERM`, `kill -9` + relaunch (port reclaimed, no
walk-forward), and a foreign listener on the preferred port (untouched, shell moved to the
next port).

## The Dock shows an old icon

Only on a Mac that ran an **earlier build of this app**. macOS caches the icon per bundle
path in LaunchServices, and a rebuild in place does not invalidate it; a fresh install
elsewhere, or any other Mac, is unaffected. `touch`ing the bundle and `lsregister -f` do
not clear it either. What does, in one line:

    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -kill -r -domain local -domain system -domain user && killall Dock

That rebuilds the LaunchServices database and restarts the Dock (the Dock reappears by
itself in a second; nothing else is affected). The build script deliberately does not do
this — an app that restarts your Dock as a side effect of being built is worse than a stale
icon. `assets/brand/ModelBot.icns` in the built bundle is correct; only the cache is stale.

## Known gaps
- Global ⌘⇧M not implemented (optional in spec). Window title is set but
  `titleVisibility = .hidden`, since full-size content means the page owns the top band.
