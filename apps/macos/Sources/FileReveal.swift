import AppKit
import WebKit

/// Getting a file the bot saved onto the person's own Mac, and showing it to
/// them in Finder. When the task record names `results_dir` the file is already
/// here and is simply selected; otherwise the daemon's `/files` route is fetched
/// through the web view's own session, saved into Downloads, and revealed.
///
/// That second route deliberately does not bounce the URL to the user's browser:
/// the browser is not signed in to the daemon, so it would land on a login wall
/// or a bare 401, and the URL is not something to spray into another app's
/// history.
enum FileReveal {
  /// Select a file that is already on this Mac. False when the path does not
  /// resolve to a real file inside `resultsDir`.
  ///
  /// `resultsDir` comes from the daemon over the page bridge, and `path` comes
  /// from a tool call the model made, so the join is checked rather than
  /// trusted: the resolved file must still be inside the directory.
  @discardableResult
  static func revealLocal(resultsDir: String, path: String) -> Bool {
    guard !resultsDir.isEmpty, !path.isEmpty else { return false }
    let root = URL(fileURLWithPath: (resultsDir as NSString).expandingTildeInPath)
      .standardizedFileURL
    let target = root.appendingPathComponent(path).standardizedFileURL
    guard isInside(target, root: root) else {
      Log.shared.write("[shell] refused a results path that escaped its directory")
      return false
    }
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: target.path, isDirectory: &isDir),
          !isDir.boolValue else { return false }
    NSWorkspace.shared.activateFileViewerSelecting([target])
    return true
  }

  /// True when `url` resolves inside `root` (or is `root` itself).
  static func isInside(_ url: URL, root: URL) -> Bool {
    let rootPath = root.path.hasSuffix("/") ? root.path : root.path + "/"
    return url.path == root.path || url.path.hasPrefix(rootPath)
  }

  /// Where a downloaded artifact lands, with a numeric suffix when the name is
  /// taken, so a second download never silently overwrites the first.
  static func uniqueDestination(in directory: URL, name: String) -> URL {
    let safe = sanitize(name)
    var candidate = directory.appendingPathComponent(safe)
    guard FileManager.default.fileExists(atPath: candidate.path) else { return candidate }
    let base = (safe as NSString).deletingPathExtension
    let ext = (safe as NSString).pathExtension
    for n in 2...999 {
      let next = ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)"
      candidate = directory.appendingPathComponent(next)
      if !FileManager.default.fileExists(atPath: candidate.path) { return candidate }
    }
    return directory.appendingPathComponent("\(base)-\(UUID().uuidString)")
  }

  /// One path segment, no separators, no leading dot, never empty.
  static func sanitize(_ name: String) -> String {
    let last = name.split(separator: "/").last.map(String.init) ?? name
    var cleaned = last.replacingOccurrences(of: ":", with: "-")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    while cleaned.hasPrefix(".") { cleaned.removeFirst() }
    if cleaned.isEmpty { cleaned = "download" }
    return String(cleaned.prefix(120))
  }
}

/// Runs one `WKDownload` to a chosen destination and reveals it when it lands.
///
/// WebKit hands the delegate the destination and then owns the transfer; the
/// controller keeps itself alive in `AppDelegate`'s set until it finishes, so a
/// download is never cancelled by its delegate being collected.
final class DownloadController: NSObject, WKDownloadDelegate {
  private let onFinish: (DownloadController, URL?) -> Void
  private var destination: URL?
  /// Named by the page when it knows the file's name; WebKit's suggestion
  /// otherwise. A daemon that sends `Content-Disposition: attachment` gives a
  /// good suggestion, and this is the fallback for one that does not.
  private let preferredName: String?

  init(preferredName: String?, onFinish: @escaping (DownloadController, URL?) -> Void) {
    self.preferredName = preferredName
    self.onFinish = onFinish
  }

  func download(
    _ download: WKDownload,
    decideDestinationUsing response: URLResponse,
    suggestedFilename: String,
    completionHandler: @escaping (URL?) -> Void
  ) {
    let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
      ?? FileManager.default.temporaryDirectory
    let name = preferredName ?? suggestedFilename
    let url = FileReveal.uniqueDestination(in: folder, name: name)
    destination = url
    completionHandler(url)
  }

  func downloadDidFinish(_ download: WKDownload) {
    let url = destination
    Log.shared.write("[shell] downloaded a file the receipt named")
    if let url { NSWorkspace.shared.activateFileViewerSelecting([url]) }
    onFinish(self, url)
  }

  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    Log.shared.write("[shell] download failed: \(error.localizedDescription)")
    onFinish(self, nil)
  }
}
