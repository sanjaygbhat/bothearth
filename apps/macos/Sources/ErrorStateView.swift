import AppKit

/// The calm in-window error state. Native NSView, Open Field palette, the
/// design brief's voice: name what happened, never blame the person, never joke.
/// Nothing animates here — errors appear instantly and hold still.
final class ErrorStateView: ThemedView {
  private let headline = NSTextField(labelWithString: "")
  private let detail = NSTextField(wrappingLabelWithString: "")
  private let recover = NSButton(title: "", target: nil, action: nil)
  private let tryAgain = NSButton(title: "Try again", target: nil, action: nil)
  private let showLog = NSButton(title: "Show log", target: nil, action: nil)
  /// A failure reached by clicking something inside the app needs a way back
  /// into the app, not just a way to retry the app's startup.
  private let back = NSButton(title: "Back to ModelBot", target: nil, action: nil)
  /// The daemon's own wording, kept but never on screen by default. A person
  /// who wants it opens it; nobody else is shown a command.
  private let detailsToggle = NSButton(title: "Details", target: nil, action: nil)
  private let technical = NSTextField(wrappingLabelWithString: "")
  private let mark = MarkView()

  var onTryAgain: (() -> Void)?
  var onShowLog: (() -> Void)?
  /// The fix the daemon named for this failure. Nil when it named none.
  var onRecover: (() -> Void)?
  /// Set when this error is covering a page that is still there behind it.
  var onBack: (() -> Void)?

  init() {
    super.init(frame: .zero)
    wantsLayer = true

    headline.font = Theme.display(size: 26)
    headline.textColor = Theme.text
    headline.alignment = .center
    headline.lineBreakMode = .byWordWrapping
    headline.maximumNumberOfLines = 2

    detail.font = Theme.ui(size: 14)
    detail.textColor = Theme.muted
    detail.alignment = .center
    detail.maximumNumberOfLines = 4

    // When the daemon names a fix, that fix is the primary button and "Try
    // again" — which an undecryptable vault can only fail a second time —
    // steps back to being the secondary one.
    recover.bezelStyle = .rounded
    recover.controlSize = .large
    recover.keyEquivalent = "\r"
    recover.target = self
    recover.action = #selector(handleRecover)
    recover.bezelColor = Theme.accent
    recover.contentTintColor = Theme.onAccent
    recover.isHidden = true

    back.bezelStyle = .rounded
    back.controlSize = .large
    back.target = self
    back.action = #selector(handleBack)
    back.bezelColor = Theme.accent
    back.contentTintColor = Theme.onAccent
    back.isHidden = true

    tryAgain.bezelStyle = .rounded
    tryAgain.controlSize = .large
    tryAgain.keyEquivalent = "\r"
    tryAgain.target = self
    tryAgain.action = #selector(handleTryAgain)
    tryAgain.bezelColor = Theme.accent
    tryAgain.contentTintColor = Theme.onAccent

    showLog.bezelStyle = .accessoryBarAction
    showLog.isBordered = false
    showLog.target = self
    showLog.action = #selector(handleShowLog)
    showLog.contentTintColor = Theme.accent
    showLog.attributedTitle = NSAttributedString(
      string: "Show log",
      attributes: [
        .font: Theme.ui(size: 13, weight: .medium),
        .foregroundColor: Theme.accent,
      ])

    detailsToggle.bezelStyle = .accessoryBarAction
    detailsToggle.isBordered = false
    detailsToggle.target = self
    detailsToggle.action = #selector(toggleDetails)
    detailsToggle.isHidden = true
    detailsToggle.attributedTitle = Self.linkTitle("Details")

    technical.font = Theme.mono(size: 11)
    technical.textColor = Theme.muted
    technical.alignment = .center
    technical.isSelectable = true
    technical.maximumNumberOfLines = 6
    technical.isHidden = true

    // The Threshold, drawn large and quiet above the headline — the enclosure
    // alone. At 56 px over "couldn't start", the mark's exit stroke reads as a
    // sign-out icon, which is the wrong thing to say on a failure.
    mark.showsChevron = false
    mark.showsExit = false
    mark.translatesAutoresizingMaskIntoConstraints = false
    mark.strokeColor = Theme.border

    let buttons = NSStackView(views: [back, recover, tryAgain, showLog])
    buttons.orientation = .horizontal
    buttons.spacing = 16
    buttons.alignment = .centerY

    let stack = NSStackView(views: [mark, headline, detail, buttons, detailsToggle, technical])
    stack.orientation = .vertical
    stack.alignment = .centerX
    stack.spacing = 16
    stack.setCustomSpacing(28, after: mark)
    stack.setCustomSpacing(10, after: headline)
    stack.setCustomSpacing(28, after: detail)
    stack.setCustomSpacing(20, after: buttons)
    stack.setCustomSpacing(8, after: detailsToggle)
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)

    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: centerYAnchor),
      stack.widthAnchor.constraint(lessThanOrEqualToConstant: 460),
      mark.widthAnchor.constraint(equalToConstant: 56),
      mark.heightAnchor.constraint(equalToConstant: 56),
    ])
  }

  required init?(coder: NSCoder) { fatalError("not used") }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    tryAgain.bezelColor = Theme.accent
    back.bezelColor = Theme.accent
    showLog.attributedTitle = NSAttributedString(
      string: "Show log",
      attributes: [
        .font: Theme.ui(size: 13, weight: .medium),
        .foregroundColor: Theme.accent,
      ])
  }

  func present(
    headline text: String,
    detail detailText: String,
    recoveryLabel: String? = nil,
    technical technicalText: String? = nil,
    backLabel: String? = nil
  ) {
    headline.stringValue = text
    detail.stringValue = detailText
    detail.maximumNumberOfLines = 6

    technical.stringValue = technicalText ?? ""
    technical.isHidden = true
    detailsToggle.isHidden = (technicalText ?? "").isEmpty
    detailsToggle.attributedTitle = Self.linkTitle("Details")

    // Back is offered only when there is something to go back to, and when it
    // is offered it is the default: the app is still running behind this.
    if let label = backLabel, !label.isEmpty {
      back.title = label
      back.isHidden = false
      back.keyEquivalent = "\r"
      back.bezelColor = Theme.accent
      back.contentTintColor = Theme.onAccent
      recover.isHidden = true
      tryAgain.isHidden = true
      tryAgain.keyEquivalent = ""
      needsDisplay = true
      return
    }
    back.isHidden = true
    back.keyEquivalent = ""
    tryAgain.isHidden = false

    if let label = recoveryLabel, !label.isEmpty {
      recover.title = label
      recover.isHidden = false
      recover.keyEquivalent = "\r"
      // Two default-looking buttons is one too many; the fix is the default.
      tryAgain.keyEquivalent = ""
      tryAgain.bezelColor = nil
      tryAgain.contentTintColor = Theme.text
    } else {
      recover.isHidden = true
      tryAgain.keyEquivalent = "\r"
      tryAgain.bezelColor = Theme.accent
      tryAgain.contentTintColor = Theme.onAccent
    }
    needsDisplay = true
  }

  private static func linkTitle(_ text: String) -> NSAttributedString {
    NSAttributedString(
      string: text,
      attributes: [
        .font: Theme.ui(size: 12, weight: .medium),
        .foregroundColor: Theme.muted,
      ])
  }

  @objc private func toggleDetails() {
    technical.isHidden.toggle()
    detailsToggle.attributedTitle = Self.linkTitle(technical.isHidden ? "Details" : "Hide details")
  }

  @objc private func handleBack() { onBack?() }
  @objc private func handleTryAgain() { onTryAgain?() }
  @objc private func handleShowLog() { onShowLog?() }
  @objc private func handleRecover() { onRecover?() }
}

/// The Threshold mark on a 24×24 grid: a container with its fourth wall
/// missing, and a line walking out through the gap.
final class MarkView: NSView {
  var strokeColor: NSColor = .labelColor { didSet { needsDisplay = true } }
  /// Below 32 px the chevron is dropped; the mark reduces to two strokes.
  var showsChevron: Bool = true
  /// The stroke that walks out through the opening. Off on the error state,
  /// where an arrow leaving a box reads as "sign out" rather than "failed".
  var showsExit: Bool = true

  override func draw(_ dirtyRect: NSRect) {
    let side = min(bounds.width, bounds.height)
    let scale = side / 24.0
    let dx = (bounds.width - side) / 2
    let dy = (bounds.height - side) / 2

    func p(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
      // 24-unit grid is y-down; NSView here is y-up.
      NSPoint(x: dx + x * scale, y: dy + (24 - y) * scale)
    }

    let path = NSBezierPath()
    path.lineWidth = max(1.0, 2.25 * scale)
    path.lineCapStyle = .round
    path.lineJoinStyle = .round

    // Enclosure, open on the right.
    let r: CGFloat = 3.5 * scale
    path.move(to: p(16.75, 3.75))
    path.line(to: p(7.25 + 3.5, 3.75))
    path.appendArc(
      withCenter: p(7.25, 7.25), radius: r,
      startAngle: 90, endAngle: 180)
    path.move(to: p(3.75, 7.25))
    path.line(to: p(3.75, 16.75))
    path.appendArc(
      withCenter: p(7.25, 16.75), radius: r,
      startAngle: 180, endAngle: 270)
    path.move(to: p(7.25, 20.25))
    path.line(to: p(16.75, 20.25))

    strokeColor.setStroke()
    path.stroke()

    // The way out: crosses the opening and exits past the enclosure.
    guard showsExit else { return }
    let out = NSBezierPath()
    out.lineWidth = path.lineWidth
    out.lineCapStyle = .round
    out.lineJoinStyle = .round
    out.move(to: p(11.5, 12))
    out.line(to: p(21, 12))
    if showsChevron && side >= 32 {
      out.move(to: p(18.25, 9.25))
      out.line(to: p(21, 12))
      out.line(to: p(18.25, 14.75))
    }
    out.stroke()
  }
}
