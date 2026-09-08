import Foundation

/// Everything the shell needs to find on disk: node, the daemon entry point,
/// the data directory, the log, and the PATH a GUI-launched app must fabricate
/// for itself (a `.app` inherits launchd's PATH, not the user's shell PATH).
enum Paths {
  // MARK: - Launch arguments

  static func argument(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
  }

  // MARK: - Well-known directories

  static let home = FileManager.default.homeDirectoryForCurrentUser

  // MARK: - Executable search order
  //
  // System directories first, always. A user-writable directory is consulted
  // only when nothing else resolved, and only after it passes
  // `isTrustedToolDir`. Otherwise anything running as the user could write
  // `~/.local/bin/node` and the signed app would execute it on every launch,
  // outside every sandbox, as the TCC-responsible process.

  /// Root-owned, non-group/other-writable directories, plus Docker's CLI shims.
  /// These are the only ones consulted while a system hit is still possible.
  static let systemBinDirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/Applications/Docker.app/Contents/Resources/bin",
  ]

  /// Where a per-user Node install lands. Last resort, and only if it is safe.
  static var userBinDirs: [String] {
    [
      home.appendingPathComponent(".local/bin").path,
      home.appendingPathComponent(".npm-global/bin").path,
      home.appendingPathComponent(".volta/bin").path,
      home.appendingPathComponent(".bun/bin").path,
    ]
  }

  /// A directory we are willing to execute out of: it exists, it belongs to
  /// this user or to root, and neither group nor other may write to it.
  static func isTrustedToolDir(_ path: String) -> Bool {
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: path) else { return false }
    guard (attrs[.type] as? FileAttributeType) == .typeDirectory else { return false }
    let owner = (attrs[.ownerAccountID] as? NSNumber)?.uint32Value ?? UInt32.max
    guard owner == getuid() || owner == 0 else { return false }
    let mode = (attrs[.posixPermissions] as? NSNumber)?.uint16Value ?? 0o777
    return (mode & 0o022) == 0
  }

  /// PATH handed to the daemon child. System dirs first, then the inherited
  /// PATH, then any user dir that passed the ownership check. Deduplicated,
  /// order preserved — and the order is the security property.
  static var childPath: String {
    var seen = Set<String>()
    var out: [String] = []
    let inherited = (ProcessInfo.processInfo.environment["PATH"] ?? "")
      .split(separator: ":").map(String.init)
      .filter { $0.hasPrefix("/") }
    for dir in systemBinDirs + inherited + userBinDirs.filter(isTrustedToolDir) {
      guard !dir.isEmpty, seen.insert(dir).inserted else { continue }
      out.append(dir)
    }
    return out.joined(separator: ":")
  }

  // MARK: - Data, logs

  /// `~/Library/Application Support/ModelBot` — passed to the CLI as `--home`.
  static var dataHome: URL {
    // An environment variable must never move the app's home in a shipped
    // build: any local process could point it at a tree it controls.
    if let override = ProcessInfo.processInfo.environment["MODELBOT_APP_HOME"],
       AppFlags.devToolingEnabled {
      return URL(fileURLWithPath: (override as NSString).expandingTildeInPath)
    }
    return home.appendingPathComponent("Library/Application Support/ModelBot")
  }

  /// Workspace the daemon writes task output into (`--data-dir` at init time).
  ///
  /// Deliberately NOT `~/ModelBot`: that is the CLI's default data dir, and an
  /// app that inits into it overwrites an existing CLI install's `tokens.json`
  /// and `vault.enc`. The app owns its own tree and never reaches outside it.
  /// (A user-chosen workspace folder is a settings feature for later.)
  static var workspaceDir: URL { dataHome.appendingPathComponent("data") }

  /// `~/Library/Logs/ModelBot/daemon.log`
  static var logFile: URL {
    home.appendingPathComponent("Library/Logs/ModelBot/daemon.log")
  }

  static var configFile: URL { dataHome.appendingPathComponent("modelbot.yaml") }

  /// Where the shell records the daemon it started, so the next launch can tell
  /// its own orphan from somebody else's server on the same port.
  static var daemonRecordFile: URL { dataHome.appendingPathComponent("shell-daemon.json") }

  // MARK: - Repo (dev builds)

  /// In a bundled build the daemon ships inside the app. In a dev build we run
  /// straight out of the checkout: `--repo`, then `MODELBOT_REPO`, then the
  /// repo root recorded in Info.plist at build time.
  ///
  /// The first two are dev tooling (see `AppFlags`), because otherwise any local
  /// process could run `open -a ModelBot --args --repo /tmp/x` and the signed
  /// app would execute `/tmp/x/dist/cli/index.js` with its identity and its TCC
  /// grants. The Info.plist value is not gated — our own build script writes it,
  /// not whoever launched us.
  static var repoRoot: URL? {
    if let arg = argument("--repo") {
      guard AppFlags.devToolingEnabled else {
        Log.shared.write("[shell] ignoring --repo: dev tooling is off in this build")
        return infoPlistRepoRoot
      }
      return URL(fileURLWithPath: (arg as NSString).expandingTildeInPath)
    }
    if let env = ProcessInfo.processInfo.environment["MODELBOT_REPO"], !env.isEmpty {
      guard AppFlags.devToolingEnabled else {
        Log.shared.write("[shell] ignoring MODELBOT_REPO: dev tooling is off in this build")
        return infoPlistRepoRoot
      }
      return URL(fileURLWithPath: (env as NSString).expandingTildeInPath)
    }
    return infoPlistRepoRoot
  }

  private static var infoPlistRepoRoot: URL? {
    guard let recorded = Bundle.main.object(forInfoDictionaryKey: "MBRepoRoot") as? String,
          !recorded.isEmpty else { return nil }
    return URL(fileURLWithPath: recorded)
  }

  // MARK: - Resolution

  enum ResolveError: LocalizedError {
    case nodeNotFound([String])
    case daemonNotFound([String])

    var errorDescription: String? {
      switch self {
      case .nodeNotFound:
        return "ModelBot couldn't find Node on this Mac."
      case .daemonNotFound:
        return "ModelBot couldn't find its own program files."
      }
    }

    /// What the person can actually do about it. Paths stay in the log.
    var recoverySuggestion: String? {
      switch self {
      case .nodeNotFound:
        return "ModelBot needs Node to run. Install it from nodejs.org, then try again."
      case .daemonNotFound:
        return "Its program files aren't where they should be. Reinstalling ModelBot will put them back."
      }
    }

    /// Where we looked — written to the log, never shown in the window.
    var searched: [String] {
      switch self {
      case .nodeNotFound(let paths), .daemonNotFound(let paths): return paths
      }
    }
  }

  private static func isExecutableFile(_ path: String) -> Bool {
    var isDir: ObjCBool = false
    let fm = FileManager.default
    guard fm.fileExists(atPath: path, isDirectory: &isDir), !isDir.boolValue else { return false }
    return fm.isExecutableFile(atPath: path)
  }

  /// Bundled Node first, then system directories, then the inherited PATH, and
  /// only if all of that failed, a user-writable directory that passed the
  /// ownership check. `MODELBOT_NODE` overrides all of it and is dev tooling:
  /// honouring it unconditionally is the shortest path to running an attacker's
  /// interpreter inside a signed app.
  static func resolveNode() throws -> URL {
    if let res = Bundle.main.resourceURL {
      let bundled = res.appendingPathComponent("node").path
      // A bundled build runs its own Node and never falls back: there is nothing
      // to fall back FROM once the interpreter ships inside the bundle.
      if isExecutableFile(bundled) { return URL(fileURLWithPath: bundled) }
    }

    if let override = ProcessInfo.processInfo.environment["MODELBOT_NODE"], !override.isEmpty {
      guard AppFlags.devToolingEnabled else {
        Log.shared.write("[shell] ignoring MODELBOT_NODE: dev tooling is off in this build")
        throw ResolveError.nodeNotFound(["MODELBOT_NODE (ignored)"])
      }
      let path = (override as NSString).expandingTildeInPath
      guard isExecutableFile(path) else { throw ResolveError.nodeNotFound([path]) }
      return URL(fileURLWithPath: path)
    }

    var candidates: [String] = systemBinDirs.map { $0 + "/node" }
    for dir in (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":")
    where dir.hasPrefix("/") {
      candidates.append("\(dir)/node")
    }
    for path in candidates where isExecutableFile(path) {
      return URL(fileURLWithPath: path)
    }
    // Nothing on a system path. Only now, and only from a directory this user
    // owns and nobody else can write to.
    for dir in userBinDirs where isTrustedToolDir(dir) {
      let path = dir + "/node"
      candidates.append(path)
      if isExecutableFile(path) { return URL(fileURLWithPath: path) }
    }
    throw ResolveError.nodeNotFound(candidates)
  }

  /// `Contents/Resources/app/dist/cli/index.js` when bundled, else the checkout.
  static func resolveDaemonScript() throws -> URL {
    var candidates: [String] = []
    if let res = Bundle.main.resourceURL {
      candidates.append(res.appendingPathComponent("app/dist/cli/index.js").path)
    }
    if let repo = repoRoot {
      candidates.append(repo.appendingPathComponent("dist/cli/index.js").path)
    }
    for path in candidates where FileManager.default.fileExists(atPath: path) {
      return URL(fileURLWithPath: path)
    }
    throw ResolveError.daemonNotFound(candidates)
  }
}
