import AppKit
import WebKit

/// The single main window: full-size content, transparent titlebar, traffic
/// lights sitting over the page's 52 px drag region.
final class MainWindowController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
  private(set) var window: NSWindow!
  private(set) var webView: WKWebView!
  private let container = ContainerView()
  private let loading = LoadingView()
  private let errorState = ErrorStateView()
  private let dragStrip = TitlebarDragView()
  private let bridge: NativeBridge

  /// Height of the drag region the page reserves at the top. See README.
  private let dragHeight: CGFloat = {
    if let raw = ProcessInfo.processInfo.environment["MODELBOT_DRAG_HEIGHT"],
       let v = Double(raw) { return CGFloat(v) }
    return 52
  }()

  var onRetry: (() -> Void)?
  var onShowLog: (() -> Void)?
  /// The fix the daemon named for the current failure, if it named one.
  var onRecover: (() -> Void)?
  var onOpenExternal: ((URL) -> Void)?
  var onFocus: (() -> Void)?
  /// A response the app must not render — a file. Handed to the download path.
  var onDownload: ((WKDownload, String?) -> Void)?

  private var daemonOrigin: URL?
  /// True while `showError` is covering a page that is still loaded behind it,
  /// so Back can uncover it rather than reloading the world.
  private var errorCoversPage = false

  init(bridge: NativeBridge) {
    self.bridge = bridge
    super.init()
    buildWindow()
  }

  // MARK: - Construction

  private func buildWindow() {
    let config = WKWebViewConfiguration()
    config.userContentController.add(bridge, name: NativeBridge.handlerName)
    config.websiteDataStore = .default()
    if #available(macOS 13.3, *) {
      config.defaultWebpagePreferences.preferredContentMode = .desktop
    }
    webView = WKWebView(frame: .zero, configuration: config)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = false
    // The supported switches, not the private-API KVC pokes they replace.
    if #available(macOS 13.3, *) {
      webView.isInspectable = AppFlags.debugEnabled
    }
    webView.underPageBackgroundColor = .clear
    webView.translatesAutoresizingMaskIntoConstraints = false

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered,
      defer: false)
    window.title = "ModelBot"
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.minSize = NSSize(width: 900, height: 600)
    window.isReleasedWhenClosed = false
    window.backgroundColor = Theme.bg
    window.delegate = self
    window.setFrameAutosaveName("ModelBotMainWindow")
    window.tabbingMode = .disallowed

    container.translatesAutoresizingMaskIntoConstraints = false
    window.contentView = container

    for view in [webView!, loading, errorState] as [NSView] {
      view.translatesAutoresizingMaskIntoConstraints = false
      container.addSubview(view)
      NSLayoutConstraint.activate([
        view.leadingAnchor.constraint(equalTo: container.leadingAnchor),
        view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        view.topAnchor.constraint(equalTo: container.topAnchor),
        view.bottomAnchor.constraint(equalTo: container.bottomAnchor),
      ])
    }

    // Native drag region over the page's reserved 52 px band, so the window
    // moves from the header the way every Mac app does.
    dragStrip.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(dragStrip)
    NSLayoutConstraint.activate([
      dragStrip.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      dragStrip.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      dragStrip.topAnchor.constraint(equalTo: container.topAnchor),
      dragStrip.heightAnchor.constraint(equalToConstant: dragHeight),
    ])

    errorState.onTryAgain = { [weak self] in self?.onRetry?() }
    errorState.onShowLog = { [weak self] in self?.onShowLog?() }
    errorState.onRecover = { [weak self] in self?.onRecover?() }
    errorState.onBack = { [weak self] in self?.goBack() }

    showLoading()
  }

  func show() {
    if window.frame.width < 100 {
      window.setContentSize(NSSize(width: 1280, height: 800))
      window.center()
    }
    window.makeKeyAndOrderFront(nil)
  }

  // MARK: - States

  func showLoading() {
    loading.isHidden = false
    errorState.isHidden = true
    webView.isHidden = true
    dragStrip.isHidden = false
    errorCoversPage = false
  }

  func showError(
    headline: String, detail: String, recoveryLabel: String? = nil, technical: String? = nil,
    backLabel: String? = nil
  ) {
    errorState.present(
      headline: headline, detail: detail, recoveryLabel: recoveryLabel, technical: technical,
      backLabel: backLabel)
    errorState.isHidden = false
    loading.isHidden = true
    webView.isHidden = true
    dragStrip.isHidden = false
    errorCoversPage = backLabel != nil
  }

  /// ⌘[ and the error state's Back button. Always does something: uncover the
  /// page an in-app error is sitting on top of, else walk the web view's own
  /// history, else ask the page to go back within its own routes.
  func goBack() {
    if errorCoversPage && !errorState.isHidden {
      errorCoversPage = false
      revealWebView()
      return
    }
    if webView.canGoBack {
      webView.goBack()
      return
    }
    NativeEvent.dispatch(["kind": "back"], into: webView)
  }

  func load(bootstrapURL: URL) {
    var components = URLComponents(url: bootstrapURL, resolvingAgainstBaseURL: false)
    components?.fragment = nil
    components?.path = "/"
    daemonOrigin = components?.url
    bridge.daemonOrigin = daemonOrigin
    webView.load(URLRequest(url: bootstrapURL))
  }

  private func revealWebView() {
    webView.isHidden = false
    loading.isHidden = true
    errorState.isHidden = true
    errorCoversPage = false
    window.makeFirstResponder(webView)
  }

  // MARK: - Same-origin policy

  private func isDaemonOrigin(_ url: URL?) -> Bool {
    guard let url, let origin = daemonOrigin else { return false }
    guard let scheme = url.scheme?.lowercased(), scheme == origin.scheme?.lowercased() else {
      return false
    }
    return url.host == origin.host && (url.port ?? -1) == (origin.port ?? -1)
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    let url = navigationAction.request.url
    if url?.scheme == "about" { decisionHandler(.allow); return }
    if isDaemonOrigin(url) { decisionHandler(.allow); return }

    decisionHandler(.cancel)
    // Only a click on a link in the main frame may open the real browser. A
    // subframe navigation, a meta-refresh or a server redirect is not something
    // a person asked for, and the agent can put a URL into any of them.
    guard navigationAction.targetFrame?.isMainFrame != false,
          navigationAction.navigationType == .linkActivated else {
      if let url { Log.shared.write("[shell] refused a non-gesture external navigation to \(url.host ?? "?")") }
      return
    }
    if let url, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" {
      onOpenExternal?(url)
    }
  }

  /// The app is HTML; anything else the daemon returns at the top level is a
  /// file or a failure, and neither may replace the window.
  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationResponse: WKNavigationResponse,
    decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
  ) {
    let response = navigationResponse.response
    let url = response.url
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    let decision = NavigationPolicy.disposition(
      isMainFrame: navigationResponse.isForMainFrame,
      isDaemonOrigin: isDaemonOrigin(url),
      path: url?.path ?? "/",
      mimeType: response.mimeType,
      statusCode: status)

    switch decision {
    case .show:
      decisionHandler(.allow)
    case .download:
      Log.shared.write("[shell] a top-level \(response.mimeType ?? "?") became a download")
      pendingDownloadName = NavigationPolicy.fileName(fromURLString: url?.absoluteString ?? "")
      decisionHandler(.download)
    case .errorState(let code):
      decisionHandler(.cancel)
      let copy = NavigationPolicy.errorCopy(status: code, urlString: url?.absoluteString ?? "")
      Log.shared.write("[shell] refused to render a \(code) at the top level")
      showError(
        headline: copy.headline, detail: copy.detail, backLabel: "Back to ModelBot")
    }
  }

  private var pendingDownloadName: String?

  func webView(
    _ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload
  ) {
    onDownload?(download, pendingDownloadName)
    pendingDownloadName = nil
  }

  func webView(
    _ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload
  ) {
    onDownload?(download, pendingDownloadName)
    pendingDownloadName = nil
  }

  /// `target=_blank` and `window.open`.
  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    guard let url = navigationAction.request.url else { return nil }
    if isDaemonOrigin(url) {
      // Only an app route may be loaded into the one window. A `_blank` link
      // to the API is a file, and is fetched rather than rendered.
      if NavigationPolicy.isAppRoute(path: url.path) {
        webView.load(URLRequest(url: url))
      } else {
        pendingDownloadName = NavigationPolicy.fileName(fromURLString: url.absoluteString)
        startDownload(url)
      }
    } else if let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" {
      onOpenExternal?(url)
    }
    return nil
  }

  /// Fetch a daemon URL through the web view's own session — so it carries the
  /// credentials the app already has — and hand it to the download path.
  func startDownload(_ url: URL) {
    let name = NavigationPolicy.fileName(fromURLString: url.absoluteString)
    webView.startDownload(using: URLRequest(url: url)) { [weak self] download in
      guard let self else { return }
      self.onDownload?(download, name)
    }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    revealWebView()
  }

  func webView(
    _ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error
  ) {
    Log.shared.write("[shell] navigation failed: \(error.localizedDescription)")
  }

  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    Log.shared.write("[shell] provisional navigation failed: \(error.localizedDescription)")
    showError(
      headline: "ModelBot couldn't open its window.",
      detail: "The app started but the page wouldn't load. Try again, and if it keeps happening the log will say why.")
  }

  // MARK: - Window delegate

  func windowDidBecomeKey(_ notification: Notification) {
    onFocus?()
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    // Closing the window leaves the app running in the menu bar.
    NSApp.hide(nil)
    return false
  }
}

/// Paints the app ground behind the web view so there is never a white flash.
final class ContainerView: ThemedView {}

/// A transparent band at the top of the content view. The page reserves the
/// same 52 px as a drag region and keeps controls out of it, so dragging here
/// moves the window and a double-click zooms it.
final class TitlebarDragView: NSView {
  override func mouseDown(with event: NSEvent) {
    if event.clickCount == 2 {
      window?.performZoom(nil)
      return
    }
    window?.performDrag(with: event)
  }
  override func hitTest(_ point: NSPoint) -> NSView? {
    // `point` arrives in the superview's coordinates. Never steal clicks from
    // the traffic lights, which live in the titlebar above us.
    guard let window, let parent = superview else { return super.hitTest(point) }
    let inWindow = parent.convert(point, to: nil)
    let types: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]
    for type in types {
      guard let button = window.standardWindowButton(type) else { continue }
      let frame = button.convert(button.bounds, to: nil).insetBy(dx: -6, dy: -6)
      if frame.contains(inWindow) { return nil }
    }
    return super.hitTest(point)
  }
}

/// Quiet first paint. One line of type, the mark, nothing moving.
final class LoadingView: ThemedView {
  private let label = NSTextField(labelWithString: "Starting ModelBot")
  private let mark = MarkView()

  init() {
    super.init(frame: .zero)
    wantsLayer = true
    label.font = Theme.ui(size: 14)
    label.textColor = Theme.muted
    label.alignment = .center
    mark.strokeColor = Theme.border
    mark.translatesAutoresizingMaskIntoConstraints = false

    let stack = NSStackView(views: [mark, label])
    stack.orientation = .vertical
    stack.alignment = .centerX
    stack.spacing = 20
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: centerYAnchor),
      mark.widthAnchor.constraint(equalToConstant: 48),
      mark.heightAnchor.constraint(equalToConstant: 48),
    ])
  }

  required init?(coder: NSCoder) { fatalError("not used") }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    mark.strokeColor = Theme.border
    label.textColor = Theme.muted
  }
}

enum AppFlags {
  /// The Debug menu (developer tools, test notification) is opt-in.
  static let debugEnabled: Bool =
    ProcessInfo.processInfo.environment["MODELBOT_DEBUG"] == "1"
    || CommandLine.arguments.contains("--debug")

  /// True only in a Debug compile or when the launch carried `--dev`. This is
  /// the gate on `--repo`, `MODELBOT_REPO`, `MODELBOT_NODE` and
  /// `MODELBOT_APP_HOME`, each of which redirects what code the app runs or
  /// where it keeps its data — a same-user process must not be able to hand the
  /// signed app someone else's `dist/cli/index.js`.
  ///
  /// It deliberately excludes `MODELBOT_DEBUG`: an environment variable must not
  /// unlock the code-redirection switches, or the gate is only as strong as the
  /// weakest variable behind it. `--dev` cannot arrive by inheritance.
  static let devToolingEnabled: Bool = {
    #if DEBUG
      return true
    #else
      return CommandLine.arguments.contains("--dev")
    #endif
  }()
}
