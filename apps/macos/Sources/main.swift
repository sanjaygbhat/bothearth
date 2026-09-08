import AppKit

// `--selftest` asserts the shell's security-relevant pure paths and exits
// without opening a window. The shell is one binary with no test host, so this
// is the test target: `npm run app:mac -- --selftest`.
if CommandLine.arguments.contains("--selftest") {
  exit(SelfTest.run() ? 0 : 1)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
