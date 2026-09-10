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
  private let back = NSButton(title: "Back to BotHearth", target: nil, action: nil)
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

    // Use the same cairn mark as the rest of the app.
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

/// The cairn mark, matching assets/brand/mark.svg on a 24 × 24 grid.
final class MarkView: NSView {
  var strokeColor: NSColor = .labelColor { didSet { needsDisplay = true } }

  override func draw(_ dirtyRect: NSRect) {
    let side = min(bounds.width, bounds.height)
    let scale = side / 24.0
    let dx = (bounds.width - side) / 2
    let dy = (bounds.height - side) / 2

    strokeColor.setFill()
    let stones: [(CGFloat, CGFloat, CGFloat)] = [
      (3.5, 16, 17), (7, 10.75, 11.5), (8.25, 5.5, 6.75),
    ]
    for (x, y, width) in stones {
      let rect = NSRect(
        x: dx + x * scale, y: dy + (24 - y - 4.25) * scale,
        width: width * scale, height: 4.25 * scale)
      NSBezierPath(roundedRect: rect, xRadius: 1.75 * scale, yRadius: 1.75 * scale).fill()
    }
  }
}
