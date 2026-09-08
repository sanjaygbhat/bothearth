import Foundation

/// What the shell does with a top-level response from the daemon.
///
/// The rule: **the main frame is the app, and the app is HTML.** A top-level
/// response from the daemon that is not `text/html` is a file, and files are
/// downloaded and revealed in Finder — never rendered over the app. A top-level
/// response that failed is an error, and errors are shown in the app's own error
/// state with a Back action — never as a raw body. Without it, a `_blank` link
/// to `/api/…/files` replaces the whole app with a JSON body and nothing short
/// of quitting brings it back.
///
/// Kept pure and free of AppKit so `--selftest` can assert every branch.
enum TopLevelDisposition: Equatable {
  /// Render it: this is the app.
  case show
  /// Not HTML — hand it to the download path and reveal it in Finder.
  case download
  /// The daemon said no. Show the in-app error state, never the body.
  case errorState(status: Int)
}

enum NavigationPolicy {
  /// Content types that are the application itself. Everything else is a file.
  static func isAppContentType(_ mimeType: String?) -> Bool {
    guard let raw = mimeType?.lowercased() else { return false }
    // `text/html; charset=utf-8` — compare the type, not the parameters.
    let type = raw.split(separator: ";").first.map(String.init)?
      .trimmingCharacters(in: .whitespaces) ?? raw
    return type == "text/html" || type == "application/xhtml+xml"
  }

  /// Paths that serve the app. Anything under the API — including the file
  /// route the receipt links to — is data, whatever its content type claims.
  static func isAppRoute(path: String) -> Bool {
    let lower = path.lowercased()
    if lower.hasPrefix("/api/") || lower == "/api" { return false }
    if lower.hasPrefix("/files/") || lower == "/files" { return false }
    return true
  }

  /// The decision for one response. `statusCode` is 0 when there is no HTTP
  /// response to read (a `file:`/`about:` load), which is treated as success.
  static func disposition(
    isMainFrame: Bool,
    isDaemonOrigin: Bool,
    path: String,
    mimeType: String?,
    statusCode: Int
  ) -> TopLevelDisposition {
    // Subresources — images, scripts, the live-view frames — are none of this
    // rule's business. Only what would REPLACE the app is.
    guard isMainFrame else { return .show }
    // A non-daemon origin never reaches here: decidePolicyFor(navigationAction)
    // has already cancelled it. Failing open would be the wrong default anyway.
    guard isDaemonOrigin else { return .show }
    if statusCode >= 400 { return .errorState(status: statusCode) }
    if !isAppRoute(path: path) { return .download }
    return isAppContentType(mimeType) ? .show : .download
  }

  /// Plain-English copy for a top-level failure. The status code is never the
  /// headline — a person reading it has just clicked something in a receipt.
  static func errorCopy(status: Int, urlString: String) -> (headline: String, detail: String) {
    let name = fileName(fromURLString: urlString)
    switch status {
    case 401, 403:
      return (
        "ModelBot couldn't open that.",
        "This copy of the app isn't allowed to read it any more. Go back and open the task again."
      )
    case 404, 410:
      return (
        name == nil ? "That isn't there any more." : "\(name!) isn't there any more.",
        "Its computer has been put away, or the file was never written. The task's own receipt is still complete — go back to read it."
      )
    default:
      return (
        "ModelBot couldn't open that.",
        "Its computer answered, but not with anything readable. Go back and try again from the task."
      )
    }
  }

  /// `/api/v1/computers/c1/files?path=out%2Ftoday.md` -> `today.md`.
  ///
  /// The receipt's link carries the name in the `path` query, not in the URL
  /// path, so that is read first. Nil when nothing names a file a person would
  /// recognise — the copy then falls back to "that".
  static func fileName(fromURLString raw: String) -> String? {
    if let components = URLComponents(string: raw),
       let queried = components.queryItems?.first(where: { $0.name == "path" })?.value,
       let name = lastSegment(queried) {
      return name
    }
    let path = URLComponents(string: raw)?.path ?? raw
    return lastSegment(path)
  }

  /// The last `/`-separated segment, if it looks like a file name.
  static func lastSegment(_ raw: String) -> String? {
    guard let decoded = raw.removingPercentEncoding ?? raw as String? else { return nil }
    guard let last = decoded.split(separator: "/").last.map(String.init) else { return nil }
    guard !last.isEmpty, last.contains("."), last.count <= 64 else { return nil }
    return last
  }
}
