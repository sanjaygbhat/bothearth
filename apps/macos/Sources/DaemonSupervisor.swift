import Foundation

/// One-time setup link + the port it belongs to. Never logged, never shown.
struct DaemonReady {
  let port: Int
  let bootstrapURL: URL
}

/// Something the person can actually do about a failure, offered as a button.
/// The daemon names it; the shell never invents one.
struct RecoveryAction {
  let label: String
  /// Argv for `node dist/cli/index.js …`, run in the app's own home.
  let arguments: [String]
  /// True when running it throws something away that cannot be got back —
  /// `reset_vault_key` deletes the OS-stored master key, renames `vault.enc`
  /// aside and rotates `tokens.json`. A flagged action must not run until a
  /// confirmation sheet has said yes.
  let destructive: Bool
  /// Shown in the confirmation sheet. Names exactly what is lost and what is
  /// kept; empty for an action that loses nothing.
  let confirmBody: String
}

enum DaemonState {
  case idle
  case preparing
  case starting
  case ready(DaemonReady)
  case failed(reason: String, detail: String, recovery: RecoveryAction?, technical: String?)
}

protocol DaemonSupervisorDelegate: AnyObject {
  func daemonStateChanged(_ state: DaemonState)
}

/// Owns the `node dist/cli/index.js start` child: port selection, the ready
/// handshake, crash restarts with backoff, and a clean shutdown on quit.
///
/// The child is spawned by us and never with `--daemon`; a detached daemon
/// writes a pid file this app does not own.
final class DaemonSupervisor {
  weak var delegate: DaemonSupervisorDelegate?

  private(set) var state: DaemonState = .idle {
    didSet {
      let s = state
      DispatchQueue.main.async { [weak self] in self?.delegate?.daemonStateChanged(s) }
    }
  }

  private let queue = DispatchQueue(label: "org.modelbot.desktop.supervisor")
  private var process: Process?
  private var stdoutBuffer = Data()
  private var stderrBuffer = Data()
  private var restarts = 0
  private var stopping = false
  private var readySentinel = false
  private var readyTimeout: DispatchWorkItem?
  private var lastReadyAt: Date?
  /// The child's process group. `nil` until it is launched, and never the
  /// shell's own group — signalling that would take the shell down with it.
  private var childGroup: pid_t?
  /// The last cause the daemon named for itself, if it named one.
  private var startupError: StartupError?

  private let maxRestarts = 3
  private let readyTimeoutSeconds: TimeInterval = 45

  /// Preferred port; falls back to the first free one if taken.
  let preferredPort: Int

  init(preferredPort: Int) {
    self.preferredPort = preferredPort
    Log.shared.open()
  }

  // MARK: - Lifecycle

  func start() {
    queue.async { [weak self] in self?.launch() }
  }

  /// Operator pressed "Try again" — clears the restart budget.
  func retry() {
    queue.async { [weak self] in
      guard let self else { return }
      self.restarts = 0
      self.launch()
    }
  }

  /// SIGTERM the daemon's whole process group, wait, then SIGKILL it. Blocks.
  ///
  /// The group, not just the pid: `node` starts its own children, and a lone
  /// SIGTERM to the leader can leave one of them holding the port. Reentrant and
  /// idempotent — every exit path calls this, including the signal handlers
  /// installed by `installExitHandlers`, and calling it twice is harmless.
  func shutdownBlocking(timeout: TimeInterval = 5.0) {
    queue.sync {
      stopping = true
      readyTimeout?.cancel()
      guard let proc = process, proc.isRunning else {
        DaemonRecord.clear()
        return
      }
      let pid = proc.processIdentifier
      let group = childGroup
      Log.shared.write("[shell] stopping daemon pid=\(pid) group=\(group.map(String.init) ?? "none") (SIGTERM)")
      Signals.terminate(pid: pid, group: group, signal: SIGTERM)
      let deadline = Date().addingTimeInterval(timeout)
      while proc.isRunning && Date() < deadline {
        usleep(50_000)
      }
      if proc.isRunning {
        Log.shared.write("[shell] daemon did not exit in \(timeout)s — SIGKILL")
        Signals.terminate(pid: pid, group: group, signal: SIGKILL)
        proc.waitUntilExit()
      }
      // Sweep anything in the group that outlived the leader.
      if let group, group != getpgrp() { _ = kill(-group, SIGKILL) }
      childGroup = nil
      DaemonRecord.clear()
      Log.shared.write("[shell] daemon stopped")
    }
  }

  /// Catch the signals a `pkill`, a `killall` or a logout actually sends, so the
  /// daemon goes down with the shell instead of being reparented to launchd and
  /// left holding the port. `SIGKILL` cannot be caught — the pidfile written at
  /// launch is what covers that case, on the next start.
  func installExitHandlers() {
    Signals.onTermination { [weak self] name in
      Log.shared.write("[shell] received \(name) — taking the daemon down with us")
      self?.shutdownBlocking(timeout: 3.0)
    }
  }

  // MARK: - Launch

  private func launch() {
    stopping = false
    readySentinel = false
    stdoutBuffer = Data()
    stderrBuffer = Data()
    startupError = nil
    state = .preparing

    let node: URL
    let script: URL
    do {
      node = try Paths.resolveNode()
      script = try Paths.resolveDaemonScript()
    } catch let err as Paths.ResolveError {
      Log.shared.write("[shell] \(err.errorDescription ?? "resolve failed"); searched:")
      for p in err.searched { Log.shared.write("[shell]   \(p)") }
      fail(reason: err.errorDescription ?? "Something is missing.",
           detail: err.recoverySuggestion ?? "The log has the details.")
      return
    } catch {
      fail(reason: "BotHearth couldn't start.", detail: String(describing: error))
      return
    }

    do {
      try prepareHomeIfNeeded(node: node, script: script)
    } catch {
      fail(reason: "BotHearth couldn't set up its folder.",
           detail: "\(Paths.dataHome.path) — see the log for what went wrong.")
      return
    }

    // A shell that was force-killed leaves the daemon running and holding the
    // port. Reclaim it if the record says it is ours; if the listener is
    // somebody else's, say so and step aside rather than killing a stranger.
    DaemonRecord.reclaim(preferred: preferredPort)
    let port = Ports.choose(preferred: preferredPort)
    if port != preferredPort {
      Log.shared.write("[shell] port \(preferredPort) is taken by another program — using \(port == 0 ? "a port the system picks" : String(port))")
    }
    state = .starting

    let proc = Process()
    proc.executableURL = node
    proc.arguments = [
      script.path,
      "start",
      "--ready-json",
      "--host", "127.0.0.1",
      "--port", String(port),
      "--home", Paths.dataHome.path,
    ]
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = Paths.childPath
    env["MODELBOT_HOME"] = Paths.dataHome.path
    env["HOME"] = Paths.home.path
    env["MODELBOT_LAUNCHED_BY"] = "macos-app"
    proc.environment = env
    proc.currentDirectoryURL = script.deletingLastPathComponent()

    let outPipe = Pipe()
    let errPipe = Pipe()
    proc.standardOutput = outPipe
    proc.standardError = errPipe
    proc.standardInput = FileHandle.nullDevice

    outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard !data.isEmpty else { return }
      self?.queue.async { self?.consumeStdout(data) }
    }
    errPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard !data.isEmpty else { return }
      // stderr is not line-buffered, so the marker can be split across a read
      // boundary; it is buffered into whole lines and only whole lines parsed.
      self?.queue.async { self?.consumeStderr(data) }
    }

    proc.terminationHandler = { [weak self] p in
      outPipe.fileHandleForReading.readabilityHandler = nil
      errPipe.fileHandleForReading.readabilityHandler = nil
      self?.queue.async {
        self?.flushStderr()
        self?.handleTermination(status: p.terminationStatus)
      }
    }

    Log.shared.write("[shell] launching \(node.path) \(script.path) start --port \(port) (attempt \(restarts + 1))")

    do {
      try proc.run()
    } catch {
      Log.shared.write("[shell] spawn failed: \(error)")
      fail(reason: "BotHearth couldn't start Node.",
           detail: "Tried \(node.path).")
      return
    }
    process = proc
    childGroup = Signals.isolate(pid: proc.processIdentifier)
    DaemonRecord.write(pid: proc.processIdentifier, group: childGroup, port: port)

    let timeout = DispatchWorkItem { [weak self] in
      guard let self, !self.readySentinel else { return }
      Log.shared.write("[shell] daemon did not report ready within \(Int(self.readyTimeoutSeconds))s")
      if let p = self.process, p.isRunning { kill(p.processIdentifier, SIGTERM) }
    }
    readyTimeout = timeout
    queue.asyncAfter(deadline: .now() + readyTimeoutSeconds, execute: timeout)
  }

  /// `start` refuses to run without a config, so a first launch must init first.
  /// Non-interactive, so it never prompts for a vault passphrase.
  private func prepareHomeIfNeeded(node: URL, script: URL) throws {
    let fm = FileManager.default
    try fm.createDirectory(at: Paths.dataHome, withIntermediateDirectories: true,
                           attributes: [.posixPermissions: 0o700])
    if fm.fileExists(atPath: Paths.configFile.path) { return }

    Log.shared.write("[shell] first run — initialising \(Paths.dataHome.path)")
    let proc = Process()
    proc.executableURL = node
    proc.arguments = [
      script.path, "init",
      "--home", Paths.dataHome.path,
      "--data-dir", Paths.workspaceDir.path,
      "--bind", "127.0.0.1",
      "--port", String(preferredPort),
      "--skip-images",
      "--keychain", "auto",
      "--quiet",
    ]
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = Paths.childPath
    env["MODELBOT_HOME"] = Paths.dataHome.path
    proc.environment = env
    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = pipe
    proc.standardInput = FileHandle.nullDevice
    try proc.run()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    proc.waitUntilExit()
    if let text = String(data: data, encoding: .utf8), !text.isEmpty {
      Log.shared.write(Redact.apply(text), addNewline: false)
    }
    if proc.terminationStatus != 0 {
      throw NSError(domain: "org.modelbot.desktop", code: Int(proc.terminationStatus),
                    userInfo: [NSLocalizedDescriptionKey: "init exited \(proc.terminationStatus)"])
    }
  }

  // MARK: - Ready handshake

  private func consumeStdout(_ data: Data) {
    stdoutBuffer.append(data)
    while let idx = stdoutBuffer.firstIndex(of: 0x0A) {
      let lineData = stdoutBuffer.subdata(in: stdoutBuffer.startIndex..<idx)
      stdoutBuffer.removeSubrange(stdoutBuffer.startIndex...idx)
      guard let line = String(data: lineData, encoding: .utf8) else { continue }
      Log.shared.write(Redact.apply(line))
      if !readySentinel, let ready = Self.parseReady(line) {
        readySentinel = true
        readyTimeout?.cancel()
        lastReadyAt = Date()
        Log.shared.write("[shell] daemon ready on port \(ready.port)")
        state = .ready(ready)
      }
    }
  }

  private func consumeStderr(_ data: Data) {
    stderrBuffer.append(data)
    while let idx = stderrBuffer.firstIndex(of: 0x0A) {
      let lineData = stderrBuffer.subdata(in: stderrBuffer.startIndex..<idx)
      stderrBuffer.removeSubrange(stderrBuffer.startIndex...idx)
      guard let line = String(data: lineData, encoding: .utf8) else { continue }
      Log.shared.write(Redact.apply(line))
      // The daemon knows why it could not start; the shell does not. It prints
      // that reason on its last stderr line, and this is where the shell picks
      // it up, so the error screen can name a cause and offer something better
      // than "Try again".
      if let parsed = StartupError.parse(line) { startupError = parsed }
    }
    // A daemon writing a very long line without a newline must not buffer for
    // ever; past 8 KB take what is there.
    if stderrBuffer.count > 8192 { flushStderr() }
  }

  /// Flush whatever stderr left behind with no trailing newline, so the marker
  /// is never lost to a missing "\n".
  private func flushStderr() {
    guard !stderrBuffer.isEmpty, let rest = String(data: stderrBuffer, encoding: .utf8) else {
      stderrBuffer.removeAll()
      return
    }
    stderrBuffer.removeAll()
    Log.shared.write(Redact.apply(rest))
    if let parsed = StartupError.parse(rest) { startupError = parsed }
  }

  /// Accepts the JSON handshake and the older human-readable line.
  static func parseReady(_ line: String) -> DaemonReady? {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }

    if trimmed.hasPrefix("{"),
       let data = trimmed.data(using: .utf8),
       let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
       (obj["type"] as? String) == "modelbot.ready",
       let urlString = obj["bootstrap_url"] as? String,
       let url = URL(string: urlString) {
      let port = (obj["port"] as? Int) ?? url.port ?? 0
      return DaemonReady(port: port, bootstrapURL: url)
    }

    if let range = trimmed.range(of: "bootstrap_url:") {
      let urlString = trimmed[range.upperBound...].trimmingCharacters(in: .whitespaces)
      if let url = URL(string: urlString), let port = url.port {
        return DaemonReady(port: port, bootstrapURL: url)
      }
    }
    return nil
  }

  // MARK: - Crash handling

  private func handleTermination(status: Int32) {
    process = nil
    readyTimeout?.cancel()
    if stopping { return }

    // A daemon that stayed up for a while earns a fresh restart budget.
    if let last = lastReadyAt, Date().timeIntervalSince(last) > 120 { restarts = 0 }

    Log.shared.write("[shell] daemon exited status=\(status)")
    guard restarts < maxRestarts else {
      if let named = startupError {
        // The daemon told us exactly what is wrong. Say that, not "it tried 3
        // times" — which is true, useless, and offers a button that can only
        // fail a fourth time.
        fail(reason: named.headline, detail: named.detail, recovery: named.recovery,
             technical: named.technical)
      } else {
        fail(reason: "BotHearth stopped and couldn't get going again.",
             detail: "It tried \(maxRestarts) times. The log has the details.")
      }
      return
    }
    restarts += 1
    let delay = pow(2.0, Double(restarts - 1))  // 1 s, 2 s, 4 s
    Log.shared.write("[shell] restarting in \(Int(delay))s (\(restarts)/\(maxRestarts))")
    state = .preparing
    queue.asyncAfter(deadline: .now() + delay) { [weak self] in
      guard let self, !self.stopping else { return }
      self.launch()
    }
  }

  private func fail(
    reason: String, detail: String, recovery: RecoveryAction? = nil, technical: String? = nil
  ) {
    state = .failed(reason: reason, detail: detail, recovery: recovery, technical: technical)
  }

  /// Run a recovery action the daemon offered, then start again.
  ///
  /// The action is not free-form: it is matched against a fixed table of things
  /// the CLI can do, so a malformed or hostile line in the log can never turn
  /// into an arbitrary command. Anything unrecognised is refused.
  /// `confirmed` is the caller's promise that a confirmation sheet was shown
  /// and accepted. A destructive action without it does nothing and says so —
  /// the guard lives here rather than at the call site so there is exactly one
  /// place that can start it.
  func runRecovery(_ action: RecoveryAction, confirmed: Bool = false) {
    guard !action.arguments.isEmpty else { return }
    guard !action.destructive || confirmed else {
      Log.shared.write("[shell] refusing an unconfirmed destructive recovery: \(action.label)")
      return
    }
    queue.async { [weak self] in
      guard let self else { return }
      guard let node = try? Paths.resolveNode(), let script = try? Paths.resolveDaemonScript() else {
        self.fail(reason: "BotHearth couldn't find Node.", detail: "The log has the details.")
        return
      }
      Log.shared.write("[shell] recovery: \(action.arguments.joined(separator: " "))")
      let proc = Process()
      proc.executableURL = node
      proc.arguments = [script.path] + action.arguments + ["--home", Paths.dataHome.path]
      var env = ProcessInfo.processInfo.environment
      env["PATH"] = Paths.childPath
      env["MODELBOT_HOME"] = Paths.dataHome.path
      env["HOME"] = Paths.home.path
      proc.environment = env
      proc.standardInput = FileHandle.nullDevice
      let pipe = Pipe()
      proc.standardOutput = pipe
      proc.standardError = pipe
      do {
        try proc.run()
        proc.waitUntilExit()
      } catch {
        Log.shared.write("[shell] recovery failed to start: \(error)")
      }
      let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
      Log.shared.write(Redact.apply(output), addNewline: false)
      Log.shared.write("[shell] recovery finished status=\(proc.terminationStatus)")
      self.restarts = 0
      self.launch()
    }
  }
}

// MARK: - The daemon's own account of why it could not start

/// Parses the daemon's last-resort stderr line:
///
///     MODELBOT_STARTUP_ERROR: <plain english cause>|<recovery_action>
///
/// The recovery action is a *name*, not a command. It is looked up in the table
/// below and turned into an argv the CLI is known to accept; a name that is not
/// in the table yields no button at all. That is deliberate — this string comes
/// out of a log file, and a log file is not a place to take instructions from.
struct StartupError {
  let headline: String
  /// Plain English, shown on the screen. Never a command.
  let detail: String
  /// The daemon's own words, verbatim, shown only behind "Details".
  let technical: String?
  let recovery: RecoveryAction?

  static let marker = "MODELBOT_STARTUP_ERROR:"

  /// name -> the button the shell is willing to offer. Everything it will run.
  /// `open_settings` runs nothing: the shell just opens Settings in the page.
  private static let actions: [String: RecoveryAction] = [
    "reset_vault_key": RecoveryAction(
      label: "Set up a new key",
      arguments: ["init", "--reset-vault-key", "--skip-images", "--force"],
      destructive: true,
      confirmBody:
        "BotHearth will start a new key and set itself up again. Every site and service "
        + "you had signed in to will need signing in again. Your old settings file is "
        + "kept alongside the new one, so nothing is deleted — it just can't be opened "
        + "without the old key."),
    "init": RecoveryAction(
      label: "Set BotHearth up again",
      arguments: ["init", "--skip-images"],
      destructive: false,
      confirmBody: ""),
    "prepare_images": RecoveryAction(
      label: "Download what it needs",
      arguments: ["image", "pull"],
      destructive: false,
      confirmBody: ""),
    "open_settings": RecoveryAction(
      label: "Open settings",
      arguments: [],
      destructive: false,
      confirmBody: ""),
  ]

  static func parse(_ text: String) -> StartupError? {
    // Last one wins: a restart may print several before it gives up.
    var found: StartupError?
    for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
      // The marker must BEGIN the line: a task goal, or any other text the
      // daemon echoed to stderr, could otherwise carry it and conjure a
      // recovery button.
      let trimmed = line.drop(while: { $0 == " " || $0 == "\t" })
      guard trimmed.hasPrefix(marker) else { continue }
      let payload = trimmed.dropFirst(marker.count).trimmingCharacters(in: .whitespaces)
      guard !payload.isEmpty else { continue }
      let parts = payload.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)
      let cause = parts[0].trimmingCharacters(in: .whitespaces)
      guard !cause.isEmpty else { continue }
      let name = parts.count > 1 ? parts[1].trimmingCharacters(in: .whitespaces) : ""
      let action = actions[name]
      let plain = PlainCause.humanise(cause)
      found = StartupError(
        headline: "BotHearth couldn't start.",
        detail: plain.text,
        technical: plain.technical,
        recovery: action)
    }
    return found
  }
}

/// Keeps terminal instructions off the failure screen.
///
/// The daemon writes lines like `run modelbot init first`, and the shell is the
/// last thing between that and a non-technical subscriber at the moment of
/// maximum vulnerability. The original is never thrown away: it goes behind
/// "Details", where somebody debugging can still read it.
enum PlainCause {
  /// A sentence that is really an instruction to type something.
  static func looksLikeCommand(_ text: String) -> Bool {
    let lower = text.lowercased()
    if lower.hasPrefix("run ") || lower.hasPrefix("$ ") || lower.hasPrefix("try running") {
      return true
    }
    for needle in ["modelbot init", "modelbot start", "modelbot doctor", "npm ", "npx ",
                   "sudo ", "docker run", "--reset-", "--home ", "--force"] where lower.contains(needle) {
      return true
    }
    return false
  }

  /// The generic last resort. Specific enough to act on, and true of every
  /// failure that gets this far: the button beside it is the actual fix.
  static let fallback =
    "BotHearth couldn't open its own setup on this Mac. Nothing of yours has been changed."

  static func humanise(_ cause: String) -> (text: String, technical: String?) {
    let sentences = cause
      .split(whereSeparator: { $0 == "." || $0 == "\n" })
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }
    let kept = sentences.filter { !looksLikeCommand($0) }
    if kept.count == sentences.count {
      return (cause, nil)
    }
    let text = kept.isEmpty ? fallback : kept.joined(separator: ". ") + "."
    return (text, cause)
  }
}

// MARK: - Process groups and exit signals

/// Everything the shell needs to take the daemon down with it.
enum Signals {
  /// Move the freshly spawned child into a process group of its own, so the
  /// whole tree can be signalled at once.
  ///
  /// `setpgid` from the parent is allowed only until the child calls `exec`, so
  /// this races and may lose. When it loses, the child's group is the shell's
  /// own — which must never be signalled, because that would kill the shell —
  /// so `nil` is returned and callers fall back to signalling the pid alone.
  static func isolate(pid: pid_t) -> pid_t? {
    if setpgid(pid, pid) == 0 {
      Log.shared.write("[shell] daemon isolated in process group \(pid)")
      return pid
    }
    let existing = getpgid(pid)
    if existing > 0 && existing != getpgrp() {
      Log.shared.write("[shell] daemon already in its own group \(existing)")
      return existing
    }
    Log.shared.write("[shell] daemon shares the shell's process group — signalling the pid only")
    return nil
  }

  /// Signal the group when there is one, and the pid either way, so a leader
  /// that has already left its group is still reached.
  static func terminate(pid: pid_t, group: pid_t?, signal sig: Int32) {
    if let group, group != getpgrp() { _ = kill(-group, sig) }
    _ = kill(pid, sig)
  }

  private static var handler: ((String) -> Void)?
  private static var sources: [DispatchSourceSignal] = []

  /// Run `body` on SIGTERM / SIGINT / SIGHUP, then exit. Uses GCD signal
  /// sources rather than `signal(2)` handlers, so the body may take locks and
  /// write files — none of which is legal inside a real signal handler.
  static func onTermination(_ body: @escaping (String) -> Void) {
    guard sources.isEmpty else { return }
    handler = body
    for (sig, name) in [(SIGTERM, "SIGTERM"), (SIGINT, "SIGINT"), (SIGHUP, "SIGHUP")] {
      // The default disposition still fires and would kill us before the source
      // runs, so it has to be ignored first.
      Foundation.signal(sig, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: sig, queue: .global())
      source.setEventHandler {
        Signals.handler?(name)
        exit(0)
      }
      source.resume()
      sources.append(source)
    }
  }
}

// MARK: - The daemon we started, remembered across launches

/// A tiny record of the daemon this shell owns: pid, process group and port.
///
/// It exists for exactly one case — the shell was killed with a signal it could
/// not catch, so `shutdownBlocking` never ran and `node` is still up, holding
/// the port and reparented to launchd. On the next launch this is what tells an
/// orphan of ours apart from an unrelated server, so the shell can reclaim its
/// own port without ever signalling a process it did not start.
enum DaemonRecord {
  private struct Record: Codable { let pid: Int32; let group: Int32?; let port: Int; let startedAt: Double }

  static func write(pid: pid_t, group: pid_t?, port: Int) {
    let record = Record(pid: pid, group: group, port: port, startedAt: Date().timeIntervalSince1970)
    guard let data = try? JSONEncoder().encode(record) else { return }
    try? data.write(to: Paths.daemonRecordFile, options: .atomic)
  }

  static func clear() {
    try? FileManager.default.removeItem(at: Paths.daemonRecordFile)
  }

  private static func read() -> Record? {
    guard let data = try? Data(contentsOf: Paths.daemonRecordFile) else { return nil }
    return try? JSONDecoder().decode(Record.self, from: data)
  }

  /// If the preferred port is busy AND the record says the process holding it is
  /// one we started, stop it. Anything else is left strictly alone.
  ///
  /// The record file survives reboots, and macOS hands out pids from low
  /// numbers again after one, so a stale record can name somebody else's
  /// process. Three checks stand between a record and a signal:
  ///
  ///   1. the record was written since the last boot (a pre-boot record can
  ///      only be about a process that no longer exists),
  ///   2. the live pid's own start time matches `startedAt` to the second, and
  ///   3. its command line contains the exact daemon script path *this* build
  ///      would launch — not a substring anyone can arrange to appear.
  ///
  /// The group is signalled only after the leader has passed all three.
  static func reclaim(preferred: Int) {
    guard let record = read() else { return }
    guard !Ports.isFree(record.port) else { clear(); return }
    guard record.port == preferred else { return }

    if let boot = bootTime(), record.startedAt < boot {
      Log.shared.write("[shell] daemon record predates the last boot — discarding it, signalling nothing")
      clear()
      return
    }

    // `kill(pid, 0)` only proves the pid exists; the pid may have been reused.
    guard kill(record.pid, 0) == 0, isOurDaemon(pid: record.pid, startedAt: record.startedAt) else {
      Log.shared.write("[shell] port \(preferred) is held by something we did not start — leaving it alone")
      clear()
      return
    }
    Log.shared.write("[shell] reclaiming port \(preferred) from our own daemon pid=\(record.pid) (SIGTERM)")
    Signals.terminate(pid: record.pid, group: record.group, signal: SIGTERM)
    let deadline = Date().addingTimeInterval(4)
    while kill(record.pid, 0) == 0 && Date() < deadline { usleep(50_000) }
    if kill(record.pid, 0) == 0 {
      Log.shared.write("[shell] it did not go — SIGKILL")
      Signals.terminate(pid: record.pid, group: record.group, signal: SIGKILL)
      usleep(300_000)
    }
    clear()
  }

  /// `kern.boottime`, as seconds since the epoch.
  static func bootTime() -> Double? {
    var tv = timeval()
    var size = MemoryLayout<timeval>.size
    var mib: [Int32] = [CTL_KERN, KERN_BOOTTIME]
    guard sysctl(&mib, 2, &tv, &size, nil, 0) == 0 else { return nil }
    return Double(tv.tv_sec) + Double(tv.tv_usec) / 1_000_000
  }

  /// `ps` output -> (start time, command line), for one pid.
  static func processFacts(_ pid: Int32) -> (started: Date, command: String)? {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/bin/ps")
    proc.arguments = ["-o", "lstart=,command=", "-p", String(pid)]
    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = FileHandle.nullDevice
    do { try proc.run() } catch { return nil }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    proc.waitUntilExit()
    guard let raw = String(data: data, encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }

    // lstart is a fixed 24-character ctime string: "Sun Sep  7 12:34:56 2026".
    let stampLength = 24
    guard raw.count > stampLength else { return nil }
    let stamp = String(raw.prefix(stampLength))
    let command = String(raw.dropFirst(stampLength)).trimmingCharacters(in: .whitespaces)
    let fmt = DateFormatter()
    fmt.locale = Locale(identifier: "en_US_POSIX")
    fmt.dateFormat = "EEE MMM d HH:mm:ss yyyy"
    guard let started = fmt.date(from: stamp.replacingOccurrences(of: "  ", with: " ")) else {
      return nil
    }
    return (started, command)
  }

  /// Identity, not resemblance: same start second, same script path.
  static func isOurDaemon(pid: Int32, startedAt: Double, tolerance: Double = 2) -> Bool {
    guard let facts = processFacts(pid) else { return false }
    guard abs(facts.started.timeIntervalSince1970 - startedAt) <= tolerance else {
      Log.shared.write("[shell] pid \(pid) started at a different time than our record — not ours")
      return false
    }
    guard let script = try? Paths.resolveDaemonScript() else { return false }
    guard facts.command.contains(script.path), facts.command.contains(" start") else {
      Log.shared.write("[shell] pid \(pid) is not running our daemon script — not ours")
      return false
    }
    return true
  }
}

// MARK: - Port selection

enum Ports {
  /// True if 127.0.0.1:port can be bound right now.
  static func isFree(_ port: Int) -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    var yes: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = UInt16(port).bigEndian
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let ok = withUnsafePointer(to: &addr) { ptr in
      ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
        bind(fd, sa, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
      }
    }
    return ok
  }

  /// Prefer the canonical port; otherwise walk forward, then give up to the OS.
  static func choose(preferred: Int) -> Int {
    if isFree(preferred) { return preferred }
    for candidate in (preferred + 1)...(preferred + 40) where isFree(candidate) {
      return candidate
    }
    return 0  // let the daemon ask the kernel
  }
}

// MARK: - Logging

/// Credentials reach the window and nowhere else — never the log file. Covers
/// every key=value credential shape the daemon can emit, plus any bare 32+
/// character hex / base64url run, which is what all of them look like.
enum Redact {
  private static let keys = ["bootstrap=", "token=", "pair=", "key=", "secret="]

  /// A long unbroken hex or base64url run is a credential wherever it appears.
  private static let bulk = try? NSRegularExpression(
    pattern: "[A-Za-z0-9_-]{32,}", options: [])

  static func apply(_ text: String) -> String {
    var out = text
    for key in keys {
      guard out.contains(key) else { continue }
      var built = ""
      var rest = Substring(out)
      while let r = rest.range(of: key) {
        built += rest[rest.startIndex..<r.upperBound]
        let after = rest[r.upperBound...]
        let end = after.firstIndex(where: { $0.isWhitespace || $0 == "\"" || $0 == "&" })
          ?? after.endIndex
        built += "<redacted>"
        rest = after[end...]
      }
      built += rest
      out = built
    }
    guard let bulk else { return out }
    let ns = out as NSString
    return bulk.stringByReplacingMatches(
      in: out, options: [], range: NSRange(location: 0, length: ns.length),
      withTemplate: "<redacted>")
  }
}

final class Log {
  static let shared = Log()
  private var handle: FileHandle?
  private let queue = DispatchQueue(label: "org.modelbot.desktop.log")

  func open() {
    queue.sync {
      guard handle == nil else { return }
      let url = Paths.logFile
      try? FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      if !FileManager.default.fileExists(atPath: url.path) {
        // 0600, not the default 0644: `dataHome` is deliberately 0700 and the
        // log sits beside it holding the same kind of detail.
        FileManager.default.createFile(
          atPath: url.path, contents: nil,
          attributes: [.posixPermissions: NSNumber(value: Int16(0o600))])
      } else {
        try? FileManager.default.setAttributes(
          [.posixPermissions: NSNumber(value: Int16(0o600))], ofItemAtPath: url.path)
      }
      handle = try? FileHandle(forWritingTo: url)
      _ = try? handle?.seekToEnd()
    }
  }

  func write(_ text: String, addNewline: Bool = true) {
    queue.async { [weak self] in
      guard let self, let handle = self.handle else { return }
      let stamped = "\(ISO8601DateFormatter().string(from: Date())) \(text)"
      let payload = addNewline ? stamped + "\n" : stamped
      if let data = payload.data(using: .utf8) { try? handle.write(contentsOf: data) }
    }
  }

}
