import AppKit

/// The About panel. Not the stock one — the stock one shows a file name and a
/// build number and says nothing a person wants to know.
///
/// This one leads with the wordmark, then answers the two questions someone
/// opening About actually has: what is this, and who is being paid. Open Field
/// palette, the design brief's voice, no motion.
final class AboutPanelController: NSWindowController {
  private let wordmark = NSImageView()

  var onOpenExternal: ((URL) -> Void)?
  var onShowLog: (() -> Void)?

  static let sourceURL = URL(string: "https://github.com/sanjaygbhat/bothearth")!
  static let commercialURL =
    URL(string: "https://github.com/sanjaygbhat/bothearth/blob/main/COMMERCIAL.md")!

  convenience init() {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 420, height: 268),
      styleMask: [.titled, .closable, .fullSizeContentView],
      backing: .buffered,
      defer: false)
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.isMovableByWindowBackground = true
    window.backgroundColor = Theme.bg
    window.title = "About ModelBot"
    window.isReleasedWhenClosed = false
    self.init(window: window)
    window.contentView = buildBody()
  }

  func present() {
    refreshWordmark()
    window?.center()
    showWindow(nil)
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  // MARK: - Body

  private func buildBody() -> NSView {
    let root = FlippedView()
    root.wantsLayer = true
    root.onAppearanceChange = { [weak self] in self?.refreshWordmark() }

    wordmark.translatesAutoresizingMaskIntoConstraints = false
    wordmark.imageScaling = .scaleProportionallyUpOrDown
    wordmark.setAccessibilityLabel("ModelBot")

    let version = NSTextField(labelWithString: Self.versionLine)
    version.font = Theme.ui(size: 12)
    version.textColor = Theme.muted

    let rule = NSBox()
    rule.boxType = .separator
    rule.translatesAutoresizingMaskIntoConstraints = false

    let what = NSTextField(wrappingLabelWithString:
      "ModelBot runs on this Mac. A subscription you already have does the thinking, "
      + "and your files stay here.")
    what.font = Theme.ui(size: 13)
    what.textColor = Theme.text

    let fine = NSTextField(wrappingLabelWithString:
      "Source-available · free for personal use. Not an Anthropic or OpenAI product "
      + "— usage is billed under your own plan, at your plan's normal rates.")
    fine.font = Theme.ui(size: 12)
    fine.textColor = Theme.muted

    let source = Self.quietButton("View the source")
    source.target = self
    source.action = #selector(openSource)

    let commercial = Self.quietButton("Commercial use")
    commercial.target = self
    commercial.action = #selector(openCommercial)

    let log = Self.quietButton("Open the log folder")
    log.target = self
    log.action = #selector(openLog)

    let actions = NSStackView(views: [source, commercial, log])
    actions.orientation = .horizontal
    actions.spacing = 18
    actions.alignment = .centerY

    let stack = NSStackView(views: [wordmark, version, rule, what, fine, actions])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 10
    stack.setCustomSpacing(6, after: wordmark)
    stack.setCustomSpacing(18, after: version)
    stack.setCustomSpacing(16, after: rule)
    stack.setCustomSpacing(18, after: fine)
    stack.translatesAutoresizingMaskIntoConstraints = false
    root.addSubview(stack)

    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 32),
      stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -32),
      stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 40),
      rule.widthAnchor.constraint(equalTo: stack.widthAnchor),
      // 559.32 x 75.56 in the source SVG; 24pt cap keeps it beside 13pt body.
      wordmark.heightAnchor.constraint(equalToConstant: 24),
      wordmark.widthAnchor.constraint(equalTo: wordmark.heightAnchor, multiplier: 559.32 / 75.56),
    ])
    return root
  }

  private static func quietButton(_ title: String) -> NSButton {
    let button = NSButton(title: title, target: nil, action: nil)
    button.bezelStyle = .accessoryBarAction
    button.isBordered = false
    button.attributedTitle = NSAttributedString(
      string: title,
      attributes: [
        .font: Theme.ui(size: 13, weight: .medium),
        .foregroundColor: Theme.accent,
      ])
    return button
  }

  private static var versionLine: String {
    let info = Bundle.main.infoDictionary
    let short = (info?["CFBundleShortVersionString"] as? String) ?? "0.0.0"
    let build = (info?["CFBundleVersion"] as? String) ?? "0"
    return "Version \(short) · build \(build)"
  }

  /// The lockup ships in two inks; pick the one for the panel's appearance.
  /// Falls back to the tintable icon-only mark if the wordmarks are absent.
  private func refreshWordmark() {
    let isDark = (window?.effectiveAppearance ?? NSApp.effectiveAppearance)
      .bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    let names = isDark ? ["wordmark-dark", "wordmark", "mark"] : ["wordmark", "wordmark-dark", "mark"]
    for name in names {
      if let url = Bundle.main.url(forResource: name, withExtension: "svg"),
         let image = NSImage(contentsOf: url), image.isValid {
        wordmark.image = image
        return
      }
    }
  }

  @objc private func openSource() {
    onOpenExternal?(Self.sourceURL)
  }

  /// ModelBot is free for personal use under PolyForm Noncommercial 1.0.0;
  /// anything commercial is a separate licence from the author. This is where
  /// somebody who needs one finds out how to ask.
  @objc private func openCommercial() {
    onOpenExternal?(Self.commercialURL)
  }

  @objc private func openLog() {
    onShowLog?()
  }
}

final class FlippedView: ThemedView {
  var onAppearanceChange: (() -> Void)?

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    onAppearanceChange?()
  }
}
