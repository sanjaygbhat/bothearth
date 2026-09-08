import AppKit
import WebKit

/// Page → shell. Exactly seven methods; anything else is dropped.
///
/// The page calls `webkit.messageHandlers.modelbot.postMessage({method, args})`.
/// `webkit.messageHandlers` exists regardless of CSP, so nothing is injected into
/// the page and `script-src 'self'` stays intact.
protocol NativeBridgeDelegate: AnyObject {
  func bridgeSetBadge(_ text: String?)
  /// `id` is the page's name for this ping, so an undelivered one can be
  /// handed back to it.
  func bridgeNotify(title: String, body: String, taskId: String?, id: String?)
  func bridgeSetTitle(_ text: String)
  func bridgeOpenExternal(_ url: URL)
  func bridgeRequestAttention(critical: Bool)
  /// Show a file the bot saved, without ever navigating the app to it.
  func bridgeRevealFile(resultsDir: String?, path: String?, url: URL?)
  /// How many things are waiting on a person, right now.
  func bridgeSetAttention(waiting: Int)
}

final class NativeBridge: NSObject, WKScriptMessageHandler {
  static let handlerName = "modelbot"
  weak var delegate: NativeBridgeDelegate?

  /// The one origin the page is allowed to be. Set once the daemon is ready.
  var daemonOrigin: URL?

  func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage
  ) {
    // Only the page we loaded, in its MAIN frame, may drive native surface: a
    // same-host subframe is an embed the agent may control, and it must not
    // reach the dock badge, the window title, Notification Center or
    // `openExternal`. Scheme, host and port all have to match.
    guard message.frameInfo.isMainFrame else { return }
    guard let origin = daemonOrigin else { return }
    let frame = message.frameInfo.securityOrigin
    guard frame.host == origin.host,
          frame.port == (origin.port ?? 80),
          frame.protocol.lowercased() == (origin.scheme ?? "http").lowercased() else { return }

    guard let body = message.body as? [String: Any],
          let method = body["method"] as? String else { return }
    let args = body["args"]

    switch method {
    case "setBadge":
      delegate?.bridgeSetBadge(Self.badgeText(from: args))

    case "notify":
      // Everything here is an unvalidated page string on its way to Notification
      // Center, so it is capped, shape-checked and throttled to 1/s burst 3 — a
      // runaway or injected page must not be able to flood system-looking
      // banners.
      guard let dict = args as? [String: Any] else { return }
      guard allowNotify() else { return }
      let title = Self.clamp((dict["title"] as? String) ?? "ModelBot", 120)
      let bodyText = Self.clamp((dict["body"] as? String) ?? "", 300)
      let taskId = (dict["taskId"] as? String).flatMap(Self.validTaskRoute)
      let id = (dict["id"] as? String).map { Self.clamp($0, 120) }
      delegate?.bridgeNotify(title: title, body: bodyText, taskId: taskId, id: id)

    case "setTitle":
      guard let text = args as? String else { return }
      delegate?.bridgeSetTitle(Self.clamp(text, 120))

    case "openExternal":
      guard let raw = args as? String,
            let url = URL(string: raw),
            let scheme = url.scheme?.lowercased(),
            scheme == "http" || scheme == "https" else { return }
      // Refuse to bounce the daemon's own origin out to a browser: the token
      // lives in that URL and the browser is not where it belongs.
      if let origin = daemonOrigin, url.host == origin.host, url.port == origin.port { return }
      delegate?.bridgeOpenExternal(url)

    case "revealFile":
      // Every field is optional and every field is checked: `resultsDir` comes
      // from the daemon, `path` from a tool call the model made, and `url` is
      // only ever used against our own origin. FileReveal re-checks the join.
      guard let dict = args as? [String: Any] else { return }
      let resultsDir = (dict["resultsDir"] as? String).flatMap(Self.validPathArg)
      let path = (dict["path"] as? String).flatMap(Self.validPathArg)
      var target: URL?
      if let raw = dict["url"] as? String, let url = URL(string: raw),
         let origin = daemonOrigin, url.host == origin.host, url.port == origin.port,
         url.scheme?.lowercased() == origin.scheme?.lowercased() {
        target = url
      }
      guard resultsDir != nil || path != nil || target != nil else { return }
      delegate?.bridgeRevealFile(resultsDir: resultsDir, path: path, url: target)

    case "setAttention":
      guard let dict = args as? [String: Any] else { return }
      let waiting = (dict["waiting"] as? NSNumber)?.intValue ?? 0
      delegate?.bridgeSetAttention(waiting: max(0, min(waiting, 999)))

    case "requestAttention":
      guard let dict = args as? [String: Any] else { return }
      delegate?.bridgeRequestAttention(critical: (dict["critical"] as? Bool) ?? false)

    default:
      break  // unknown method: dropped, never forwarded
    }
  }

  // MARK: - Bounds on everything the page hands us

  private var notifyTimes: [Date] = []

  /// 1/s sustained, burst 3. Anything past that is dropped silently.
  private func allowNotify() -> Bool {
    let now = Date()
    notifyTimes.removeAll { now.timeIntervalSince($0) > 3 }
    guard notifyTimes.count < 3 else { return false }
    notifyTimes.append(now)
    return true
  }

  /// Truncated on a whitespace boundary where there is one, hard otherwise.
  static func clamp(_ text: String, _ max: Int) -> String {
    let flat = text.replacingOccurrences(of: "\n", with: " ")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard flat.count > max else { return flat }
    return String(flat.prefix(max - 1)) + "\u{2026}"
  }

  /// A route the page may ask us to remember, or nil. Task ids are
  /// `task_<hex>`; the page also passes the hash route it wants reopened.
  static func validTaskRoute(_ raw: String) -> String? {
    guard raw.count <= 96 else { return nil }
    let allowed = CharacterSet(charactersIn:
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-/#")
    guard !raw.isEmpty, raw.unicodeScalars.allSatisfy(allowed.contains) else { return nil }
    return raw
  }

  /// A file-system path fragment the page may hand us. No `..`, no NUL, no
  /// absolute escape past a results directory, and short enough to be a path.
  static func validPathArg(_ raw: String) -> String? {
    guard !raw.isEmpty, raw.count <= 1024 else { return nil }
    guard !raw.contains("\0") else { return nil }
    let parts = raw.split(separator: "/", omittingEmptySubsequences: true)
    guard !parts.contains("..") else { return nil }
    return raw
  }

  /// The page sends the count as a string, or null to clear the badge.
  private static func badgeText(from args: Any?) -> String? {
    guard let s = args as? String, !s.isEmpty else { return nil }
    return s
  }
}

/// Shell → page. One channel, one call: a CustomEvent dispatched on `window`.
/// This is the only JavaScript the shell ever evaluates in the page.
enum NativeEvent {
  static func dispatch(_ detail: [String: Any], into webView: WKWebView?) {
    guard let webView else { return }
    guard let data = try? JSONSerialization.data(withJSONObject: detail),
          let json = String(data: data, encoding: .utf8) else { return }
    let script = "window.dispatchEvent(new CustomEvent(\"modelbot:native\",{detail:\(json)}))"
    webView.evaluateJavaScript(script, completionHandler: nil)
  }
}
