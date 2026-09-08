# ModelBot native clients

These pre-release Android and iOS clients connect to **your own ModelBot server**. Task entry, history, saved results, sharing, connection settings and notification permission are native screens. The computer view uses the existing authenticated control UI inside a restricted WebView; it shares the server’s HUMAN lease, input epoch and privacy checks.

## Connect

1. Set up a private HTTPS workspace using [Remote clients](../docs/REMOTE-CLIENT.md). For Tailscale Serve, connect the phone to the same private network with the Tailscale app first.
2. On the connected desktop dashboard, open **Settings → Connected devices → Connect a device**. Copy the connection link.
3. Paste that link into the native app and press **Connect**. Links expire after ten minutes and work once; keep the issuing desktop session signed in until pairing finishes.
4. Describe a task. Open its result or computer as needed. In human control, tap the remote field, open **Type on computer**, use the phone keyboard, then press **Type text**. Text is not submitted automatically.

Closing or backgrounding the computer view clears local pixels/input. It does not return HUMAN control to the agent. Foreground recovery needs a fresh authenticated connection and matching live frame. Revoking a device from desktop Settings closes its access and returns it to the connection screen. Tasks and the browser profile remain on the server.

The phone does not import AI-provider credentials. Configure the AI connection on the server; **Connection → Open workspace settings** keeps advanced features available. A VPS runs independently of the owner’s laptop, but real off-network/cellular acceptance has not been performed for these clients.

## Build

No application libraries or cross-platform framework are added. Android uses Java/native Views; iOS uses SwiftUI, Keychain, UserNotifications and WKWebView. Build artifacts are ignored and are not committed.

Android requires JDK17 or later, Android SDK 36 and its build tools. Set `JAVA_HOME` and `ANDROID_HOME` to your installed tools:

```sh
cd mobile/android
./gradlew :app:assembleDebug :app:assembleRelease
```

Outputs are `app/build/outputs/apk/debug/app-debug.apk` and `app/build/outputs/apk/release/app-release-unsigned.apk`. The wrapper pins Gradle 8.13 with a distribution checksum; the Android plugin is 8.13.0. The minimum supported OS is Android 9/API 28; compile and target SDK are 36. Configure your own release signing outside source control before distribution.

For iOS, open [ModelBot.xcodeproj](ios/ModelBot.xcodeproj) or build with an installed simulator runtime:

```sh
xcodebuild -project mobile/ios/ModelBot.xcodeproj -scheme ModelBot \
  -configuration Debug -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/modelbot-ios-build CODE_SIGN_IDENTITY=- build
```

The app is `/tmp/modelbot-ios-build/Build/Products/Debug-iphonesimulator/ModelBot.app`. Minimum OS is iOS 17. Simulator signing is ad hoc; running on a physical iPhone requires the owner’s Xcode signing configuration. No distribution certificate, enrollment, store submission or paid account is supplied.

An unsigned device-target compile can also check the installed iPhoneOS SDK without enrollment:

```sh
xcodebuild -project mobile/ios/ModelBot.xcodeproj -target ModelBot \
  -configuration Release -sdk iphoneos ARCHS=arm64 CODE_SIGNING_ALLOWED=NO \
  CONFIGURATION_BUILD_DIR=/tmp/modelbot-ios-device-products build
```

This produces an unsigned arm64 app, not an installable distribution package. Both this compile and the simulator XCTest passed; no physical-device run is implied.

## Security and platform limits

- Operator cookies are stored in Android Keystore-backed AES-GCM storage or iOS Keychain with `WhenUnlockedThisDeviceOnly`. Pairing tokens are consumed, cleared from the entry field, and never saved as durable credentials. Android backup is disabled; iOS storage does not synchronize to other devices.
- Release connections require HTTPS with platform certificate validation. Redirects never carry API authentication to another origin. WebViews have no native JavaScript bridge, block file/content and unrequested external navigation, and open explicit external HTTPS links in the system browser without forwarding session headers.
- Debug-only localhost/127.0.0.1 connections support disposable tests. Android’s debug configuration permits user-installed CAs **only for those loopback hostnames**. Release has no user-CA or cleartext override. Never install a test CA on a personal device.
- Notification permission is an explicit native action. The app implements foreground polling and local takeover notifications; APNs/FCM push and guaranteed background delivery are not implemented. The notification contains no page, task or email content. In-app task status remains available without permission.
- Operator text stays only in the control view until sent. It clears on send, disconnect, hide and authority changes; no clipboard, persisted draft or replay queue is used. The server remains the authority for input acceptance.

Build settings were checked against official requirements on 2026-09-06: Google Play requires API 36 for new ordinary phone apps/updates from August 31, 2026; Apple requires the iOS 26 SDK or newer for submissions from April 28, 2026. This source targets Android 36 and was built with Xcode 26.3/iOS 26.2 SDK. Meeting the SDK minimum is not store approval. [Google requirements](https://support.google.com/googleplay/android-developer/answer/11926878), [Apple requirements](https://developer.apple.com/news/?id=ueeok6yw).

Remaining distribution gates include physical phone/tablet and cellular testing, accessibility review with VoiceOver/TalkBack, developer signing, store privacy disclosures, and store-policy classification. Apple’s remote-client guideline 4.2.7 needs explicit assessment for this browser/VPS use case; no App Store eligibility is promised. No paid feature entitlement, billing or subscription sharing is implemented. [Apple review guidelines](https://developer.apple.com/app-store/review/guidelines/).

## Verification

Native acceptance uses a disposable local HTTPS proxy and real ModelBot daemon/Docker browser, with a scripted adapter. It does not contact a model provider or a personal mailbox. Android instrumentation and iOS XCTest cover native task/results, WebView keyboard input, foreground recovery and revocation. Tests use only synthetic text and verify the resulting remote DOM independently. These are emulator/simulator results, not physical-device or off-network proof.

See [test instructions](tests/README.md). Keep test certificates, invitation files, simulator screenshots and test logs outside the repository. Native foreground notification delivery and assistive-technology behavior require further device acceptance; compilation alone is not evidence for those behaviors.
