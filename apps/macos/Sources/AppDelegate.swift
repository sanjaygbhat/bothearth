import AppKit
import UserNotifications
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, DaemonSupervisorDelegate,
                         NativeBridgeDelegate, UNUserNotificationCenterDelegate {
  private let bridge = NativeBridge()
  private var windowController: MainWindowController!
  private var supervisor: DaemonSupervisor!
  private var statusItem: StatusItemController!
  private var notificationsRequested = false
  /// In-flight downloads, kept alive until WebKit finishes with them.
  private var downloads: Set<DownloadController> = []
  /// How many things the page says are waiting on a person right now.
  private var waitingCount = 0
  private var badgeText: String?
  private lazy var aboutPanel: AboutPanelController = {
    let panel = AboutPanelController()
    panel.onOpenExternal = { [weak self] url in self?.bridgeOpenExternal(url) }
    panel.onShowLog = { [weak self] in self?.showLog() }
    return panel
  }()

  /// The reason we give macOS, and the person, for wanting to notify them.
  private static let notificationReason =
    "BotHearth notifies you when a task finishes or when your bot needs you to sign in to something."

  // MARK: - Lifecycle

  func applicationDidFinishLaunching(_ notification: Notification) {
    Log.shared.open()
    Log.shared.write("[shell] BotHearth shell launched (debug=\(AppFlags.debugEnabled))")

    bridge.delegate = self

    windowController = MainWindowController(bridge: bridge)
    windowController.onRetry = { [weak self] in
      self?.windowController.showLoading()
      self?.supervisor.retry()
    }
    windowController.onShowLog = { [weak self] in self?.showLog() }
    windowController.onOpenExternal = { [weak self] url in self?.bridgeOpenExternal(url) }
    windowController.onFocus = { [weak self] in
      NativeEvent.dispatch(["kind": "focus"], into: self?.windowController.webView)
    }
    windowController.onDownload = { [weak self] download, name in
      self?.adopt(download, preferredName: name)
    }

    statusItem = StatusItemController()
    statusItem.onOpen = { [weak self] in self?.activate() }
    statusItem.onNewTask = { [weak self] in self?.newTask() }
    statusItem.onQuit = { [weak self] in self?.quit() }

    NSApp.mainMenu = MainMenu.build(target: self)
    UNUserNotificationCenter.current().delegate = self

    supervisor = DaemonSupervisor(preferredPort: Self.resolvePreferredPort())
    supervisor.delegate = self
    // Quit is not the only way out: a `pkill`, a `killall` or a logout all send
    // a signal that AppKit never turns into applicationWillTerminate, and the
    // daemon would be left running and holding the port.
    supervisor.installExitHandlers()
    supervisor.start()

    windowController.show()
    NSApp.activate(ignoringOtherApps: true)
    scheduleDebugAction()
  }

  /// Debug-only. `--debug --debug-open <about|palette|keys|settings|badge|error>`
  /// runs one Debug-menu action a few seconds after launch.
  ///
  /// Clicking a menu from a script needs Accessibility permission, which this
  /// app never asks for, so this is how the native surfaces get screenshotted.
  /// Gated on `MODELBOT_DEBUG` like the Debug menu itself.
  private func scheduleDebugAction() {
    guard AppFlags.debugEnabled, let action = Paths.argument("--debug-open") else { return }
    let delay = Double(Paths.argument("--debug-delay") ?? "") ?? 6.0
    Log.shared.write("[shell] debug-open \(action) in \(delay)s")
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
      guard let self else { return }
      switch action {
      case "about": self.showAbout()
      case "palette": self.openPalette()
      case "keys": self.openKeys()
      case "settings": self.openSettings()
      case "error": self.showErrorState()
      case "badge", "needsyou", "resume":
        // The calls the attention loop makes when a task starts — or, for
        // `resume`, stops — waiting on a person, made from the page's own world.
        let waiting = action == "resume" ? 0 : 1
        let title = waiting > 0 ? "● Needs you — BotHearth" : "BotHearth"
        self.windowController.webView.evaluateJavaScript(
          """
          window.modelbotNative.setBadge(\(waiting));
          window.modelbotNative.setAttention(\(waiting));
          window.modelbotNative.setTitle("\(title)");
          \(waiting > 0 ? "window.modelbotNative.requestAttention(true);" : "")
          "sent"
          """
        ) { result, error in
          Log.shared.write(
            "[shell] debug \(action): page returned \(result ?? "nil") error=\(error?.localizedDescription ?? "none")")
          DispatchQueue.main.async {
            Log.shared.write(
              "[shell] dockTile.badgeLabel=\(NSApp.dockTile.badgeLabel ?? "nil") statusItem=\(self.statusItem.status.rawValue) windowTitle=\(self.windowController.window.title)")
          }
        }
      default:
        Log.shared.write("[shell] debug-open: unknown action \(action)")
      }
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  func applicationShouldHandleReopen(
    _ sender: NSApplication, hasVisibleWindows flag: Bool
  ) -> Bool {
    activate()
    return true
  }

  func applicationWillTerminate(_ notification: Notification) {
    statusItem?.set(.stopped)
    supervisor?.shutdownBlocking()
    Log.shared.write("[shell] shell terminated")
  }

  private static func resolvePreferredPort() -> Int {
    if let raw = Paths.argument("--port"), let value = Int(raw) { return value }
    if let raw = ProcessInfo.processInfo.environment["MODELBOT_PORT"], let value = Int(raw) {
      return value
    }
    return 7777
  }

  // MARK: - Daemon state

  func daemonStateChanged(_ state: DaemonState) {
    switch state {
    case .idle, .preparing, .starting:
      statusItem.set(.starting)
      windowController.showLoading()
    case .ready(let ready):
      statusItem.set(.idle)
      windowController.load(bootstrapURL: ready.bootstrapURL)
    case .failed(let reason, let detail, let recovery, let technical):
      statusItem.set(.stopped)
      // The daemon's own fix, offered as the primary button. `onRecover` is
      // re-bound each time, so it can never run a stale action from an earlier
      // failure.
      windowController.onRecover = recovery.map { action in
        { [weak self] in self?.startRecovery(action) }
      }
      windowController.showError(
        headline: reason, detail: detail, recoveryLabel: recovery?.label, technical: technical)
    }
  }

  // MARK: - Native bridge (page → shell)

  /// A recovery action the person must agree to before it runs. "Set up a new
  /// key" deletes the OS-stored master key, renames the vault aside and rotates
  /// the tokens, on a screen reached because something already went wrong, so
  /// anything the table flags destructive is confirmed first — and the sheet
  /// names what is lost and what is kept.
  private func startRecovery(_ action: RecoveryAction) {
    guard action.destructive else {
      if action.arguments.isEmpty {
        // `open_settings` runs nothing; it just opens Settings in the page.
        NativeEvent.dispatch(["kind": "open-settings"], into: windowController.webView)
        return
      }
      supervisor?.runRecovery(action)
      return
    }
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "Set up a new key for BotHearth?"
    alert.informativeText = action.confirmBody
    alert.addButton(withTitle: action.label)
    alert.addButton(withTitle: "Cancel")
    let run: (NSApplication.ModalResponse) -> Void = { [weak self] response in
      guard response == .alertFirstButtonReturn else {
        Log.shared.write("[shell] recovery cancelled by the person: \(action.label)")
        return
      }
      self?.supervisor?.runRecovery(action, confirmed: true)
    }
    if windowController.window.isVisible {
      alert.beginSheetModal(for: windowController.window, completionHandler: run)
    } else {
      run(alert.runModal())
    }
  }

  func bridgeSetBadge(_ text: String?) {
    NSApp.dockTile.badgeLabel = text
    // Setting the label alone can leave a cached tile on screen; asking for a
    // redraw is the documented way to make the badge appear immediately.
    NSApp.dockTile.display()
    badgeText = text
    refreshStatus()
  }

  /// A badge alone cannot say whether the bot is working or blocked on a
  /// person. The page says which, and this is the only place that decides what
  /// the menu bar shows.
  func bridgeSetAttention(waiting: Int) {
    let changed = waiting > 0 && waitingCount == 0
    waitingCount = waiting
    refreshStatus()
    if changed {
      // One bounce on the way in, never on every reconcile.
      NSApp.requestUserAttention(.criticalRequest)
    }
  }

  private func refreshStatus() {
    if waitingCount > 0 {
      statusItem.set(.needsYou)
    } else if badgeText != nil {
      statusItem.set(.working)
    } else {
      statusItem.set(.idle)
    }
  }

  /// Two routes and no third: reveal the real file when the daemon says where
  /// it is, otherwise fetch it through the app's own session and reveal what
  /// landed. The app is never navigated to it.
  func bridgeRevealFile(resultsDir: String?, path: String?, url: URL?) {
    if let resultsDir, let path, FileReveal.revealLocal(resultsDir: resultsDir, path: path) {
      Log.shared.write("[shell] revealed a saved file in Finder")
      return
    }
    guard let url else {
      Log.shared.write("[shell] revealFile: nothing to open")
      return
    }
    windowController.startDownload(url)
  }

  private func adopt(_ download: WKDownload, preferredName: String?) {
    let controller = DownloadController(preferredName: preferredName) { [weak self] done, _ in
      DispatchQueue.main.async { self?.downloads.remove(done) }
    }
    downloads.insert(controller)
    download.delegate = controller
  }

  /// macOS refuses notification authorization to an ad-hoc signed bundle, which
  /// is every build without a Developer ID, so a banner asked for here may never
  /// appear. `id` is the page's name for this ping: when nothing was delivered
  /// the page is told, and it falls back to its own alert.
  func bridgeNotify(title: String, body: String, taskId: String?, id: String?) {
    let center = UNUserNotificationCenter.current()
    let undelivered = { [weak self] in
      guard let id else { return }
      DispatchQueue.main.async {
        NativeEvent.dispatch(
          ["kind": "notify-failed", "notifyId": id], into: self?.windowController.webView)
      }
    }
    let post = {
      let content = UNMutableNotificationContent()
      content.title = title
      content.body = body
      if let taskId { content.userInfo = ["taskId": taskId] }
      content.sound = .default
      let request = UNNotificationRequest(
        identifier: UUID().uuidString, content: content, trigger: nil)
      center.add(request) { error in
        guard let error else { return }
        Log.shared.write("[shell] notification failed: \(error.localizedDescription)")
        undelivered()
      }
    }
    center.getNotificationSettings { settings in
      Log.shared.write("[shell] notification settings: status=\(settings.authorizationStatus.rawValue) alert=\(settings.alertSetting.rawValue)")
      switch settings.authorizationStatus {
      case .authorized, .provisional, .ephemeral:
        post()
      case .denied:
        Log.shared.write("[shell] notifications denied — handing the ping back to the page")
        undelivered()
      default:
        guard !self.notificationsRequested else { post(); return }
        self.notificationsRequested = true
        Log.shared.write("[shell] requesting notification authorization — \(Self.notificationReason)")
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
          if let error {
            Log.shared.write("[shell] notification authorization error: \(error.localizedDescription)")
          }
          Log.shared.write("[shell] notification authorization granted=\(granted)")
          if granted { post() } else { undelivered() }
        }
      }
    }
  }

  func bridgeSetTitle(_ text: String) {
    windowController.window.title = text.isEmpty ? "BotHearth" : text
  }

  func bridgeOpenExternal(_ url: URL) {
    Log.shared.write("[shell] opening externally: \(url.host ?? "?")")
    NSWorkspace.shared.open(url)
  }

  func bridgeRequestAttention(critical: Bool) {
    NSApp.requestUserAttention(critical ? .criticalRequest : .informationalRequest)
  }

  // MARK: - Notification delegate

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let taskId = response.notification.request.content.userInfo["taskId"] as? String
    DispatchQueue.main.async { [weak self] in
      self?.activate()
      var detail: [String: Any] = ["kind": "notification-click"]
      if let taskId { detail["taskId"] = taskId }
      NativeEvent.dispatch(detail, into: self?.windowController.webView)
    }
    completionHandler()
  }

  // MARK: - Menu actions

  @objc func activate() {
    NSApp.unhide(nil)
    windowController.show()
    NSApp.activate(ignoringOtherApps: true)
  }

  @objc func openSettings() {
    activate()
    NativeEvent.dispatch(["kind": "open-settings"], into: windowController.webView)
  }

  @objc func newTask() {
    activate()
    NativeEvent.dispatch(["kind": "new-task"], into: windowController.webView)
  }

  /// ⌘K. The menu owns the keystroke, so the page is told rather than typed at.
  @objc func openPalette() {
    activate()
    NativeEvent.dispatch(["kind": "open-palette"], into: windowController.webView)
  }

  /// ⌘/ — the keyboard map, which the page draws from one list (ux-spec §2.7).
  @objc func openKeys() {
    activate()
    NativeEvent.dispatch(["kind": "open-keys"], into: windowController.webView)
  }

  @objc func showAbout() {
    aboutPanel.present()
  }

  @objc func reload() {
    windowController.webView.reload()
  }

  @objc func goBack() {
    activate()
    windowController.goBack()
  }

  @objc func zoomActual() { windowController.webView.pageZoom = 1.0 }
  @objc func zoomIn() {
    windowController.webView.pageZoom = min(3.0, windowController.webView.pageZoom + 0.1)
  }
  @objc func zoomOut() {
    windowController.webView.pageZoom = max(0.5, windowController.webView.pageZoom - 0.1)
  }

  @objc func testNotification() {
    bridgeNotify(
      title: "Your bot needs you.",
      body: "There's a login it can't do safely on its own.",
      taskId: "debug-test",
      id: "debug-test")
  }

  /// Debug-only: runs the page-side bridge call the web UI will make, from the
  /// page's own world. Proves `webkit.messageHandlers` is reachable under
  /// `script-src 'self'` without anything being injected into the page.
  @objc func testBridge() {
    let script = """
      webkit.messageHandlers.modelbot.postMessage({method:"setBadge",args:"3"});
      webkit.messageHandlers.modelbot.postMessage({method:"setTitle",args:"Finding last month's invoice"});
      webkit.messageHandlers.modelbot.postMessage({method:"requestAttention",args:{critical:true}});
      "sent"
      """
    windowController.webView.evaluateJavaScript(script) { result, error in
      if let error {
        Log.shared.write("[shell] bridge test failed: \(error.localizedDescription)")
      } else {
        Log.shared.write("[shell] bridge test: page returned \(result ?? "nil")")
      }
    }
  }

  /// Debug-only. Shows a failure the daemon named a cause and a fix for, so the
  /// screen can be reviewed without corrupting a real vault to get there.
  @objc func showErrorState() {
    let parsed = StartupError.parse(
      "MODELBOT_STARTUP_ERROR: The saved key for this Mac no longer opens BotHearth's "
      + "vault, so it can't read your settings.|reset_vault_key")
    windowController.onRecover = parsed?.recovery.map { action in
      { [weak self] in self?.startRecovery(action) }
    }
    windowController.showError(
      headline: parsed?.headline ?? "BotHearth couldn't start.",
      detail: parsed?.detail ?? "The log has the details.",
      recoveryLabel: parsed?.recovery?.label,
      technical: parsed?.technical)
  }

  @objc func showLog() {
    NSWorkspace.shared.selectFile(Paths.logFile.path, inFileViewerRootedAtPath: "")
  }

  @objc func openHelp() {
    NSWorkspace.shared.open(MainMenu.helpURL)
  }

  @objc func quit() {
    NSApp.terminate(nil)
  }
}
