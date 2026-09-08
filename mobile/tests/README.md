# Native acceptance fixtures

Use only disposable simulators/emulators and the locally built image. The fixture creates its own browser, database, one-day localhost CA and single-use invitations. It never uses a saved personal profile. Ports 7791/7792 must be free.

```sh
npm run build
MODELBOT_NATIVE_ACCEPTANCE=1 node mobile/tests/fixture.mjs
```

The fixture prints a private `fixture.json` path. Keep this file private: it contains the synthetic fixture owner’s session. It prints no pairing token. `SIGTERM` stops the fixture and removes its owned browser; wait for shutdown before starting another instance.

Install the fixture’s `cert.pem` into **only the disposable device’s** trusted test CA store. Android debug trust is restricted to localhost/127.0.0.1; the release APK has no override. Map emulator port 7792 to host 7792 with `adb reverse`. iOS Simulator can reach host localhost directly and accepts a root using `xcrun simctl keychain SIMULATOR_ID add-root-cert CERT_PATH`. Never disable certificate verification.

Before each platform run:

```sh
node mobile/tests/control.mjs FIXTURE_JSON reset
node mobile/tests/control.mjs FIXTURE_JSON issue
```

`issue` uses the real authenticated pairing API and saves the invitation to `pairing.json` beside the private fixture state. Read its `url` into the test invocation without printing it or committing test logs.

Android:

```sh
cd mobile/android
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest
adb -s EMULATOR_SERIAL install -r app/build/outputs/apk/debug/app-debug.apk
adb -s EMULATOR_SERIAL install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s EMULATOR_SERIAL shell am instrument -w -e link "$TEST_PAIRING_URL" \
  org.modelbot.mobile.test/org.modelbot.mobile.NativeAcceptance
```

Require `INSTRUMENTATION_CODE: -1` and no `failure` result: adb’s process exit status alone does not establish success. The test clears only its own app’s synthetic session, creates a task, types through a real WebView `InputConnection`, backgrounds/foregrounds, and deletes its own device session.

For iOS, run the shared ModelBot scheme’s tests with a disposable simulator destination, `MODELBOT_NATIVE_LINK=TEST_PAIRING_URL` as an xcodebuild build setting, and a private derived-data/log directory. The scheme expands this setting into the test runner’s environment. When its log emits `NATIVE_REVOCATION_READY`, a separate host test controller must run:

```sh
node mobile/tests/control.mjs FIXTURE_JSON revoke 'iPhone / iPad'
```

This calls DELETE using the separate owner session. XCTest waits for the real app to remove the control view and show native reconnection; local sign-out is not substituted for remote revocation.

After each successful run, verify exact remote text and retained HUMAN privacy state:

```sh
node mobile/tests/control.mjs FIXTURE_JSON verify 'demo.user@example.test · नमस्ते' # Android
node mobile/tests/control.mjs FIXTURE_JSON verify 'demo.user@example.test · é'       # iOS
```

The iOS test attaches synthetic connected/result/control/keyboard/revoked screenshots to its `.xcresult`. Export them with `xcrun xcresulttool export attachments`; do not commit the result bundle. Stop owned emulators/simulators and the fixture afterward. If Xcode’s preferred runtime build differs from the installed official runtime, use `simctl runtime match` for that test run and restore `--default` afterward; do not call a build-only fallback a passed XCTest.
