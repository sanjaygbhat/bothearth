import AppKit

/// The Open Field palette, mirroring `src/ui/tokens.css`. Only the tokens the
/// native chrome needs live here; the web UI owns the rest. Every colour is a
/// dynamic NSColor so the native chrome follows the system appearance.
enum Theme {
  private static func dyn(light: NSColor, dark: NSColor) -> NSColor {
    NSColor(name: nil) { appearance in
      let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
      return isDark ? dark : light
    }
  }

  private static func hex(_ value: UInt32) -> NSColor {
    NSColor(
      srgbRed: CGFloat((value >> 16) & 0xFF) / 255.0,
      green: CGFloat((value >> 8) & 0xFF) / 255.0,
      blue: CGFloat(value & 0xFF) / 255.0,
      alpha: 1.0)
  }

  /// #FAFAF5 / #0A130F — app ground.
  static let bg = dyn(light: hex(0xFAFAF5), dark: hex(0x0A130F))
  /// #142920 / #EBECE4 — evergreen ink, 14.67:1 on bg.
  static let text = dyn(light: hex(0x142920), dark: hex(0xEBECE4))
  /// #526259 / #A3AAA1 — secondary copy, 6.17:1 on bg.
  static let muted = dyn(light: hex(0x526259), dark: hex(0xA3AAA1))
  /// #D9DED5 / #29332E — decorative hairline.
  static let border = dyn(light: hex(0xD9DED5), dark: hex(0x29332E))
  /// #A84E13 / #E8954A — the ember. Used once per screen, never twice.
  static let accent = dyn(light: hex(0xA84E13), dark: hex(0xE8954A))
  /// #FDFCF7 — text on the ember.
  static let onAccent = dyn(light: hex(0xFDFCF7), dark: hex(0x1A0F06))

  /// Display face for the one headline in the error state. Falls back to the
  /// system serif, then the system face, if Fraunces is not installed.
  static func display(size: CGFloat) -> NSFont {
    if let f = NSFont(name: "Fraunces", size: size) { return f }
    let descriptor = NSFont.systemFont(ofSize: size, weight: .semibold)
      .fontDescriptor.withDesign(.serif)
    if let d = descriptor, let f = NSFont(descriptor: d, size: size) { return f }
    return NSFont.systemFont(ofSize: size, weight: .semibold)
  }

  /// 14px is the native macOS chrome size.
  static func ui(size: CGFloat = 14, weight: NSFont.Weight = .regular) -> NSFont {
    NSFont.systemFont(ofSize: size, weight: weight)
  }

  static func mono(size: CGFloat = 12) -> NSFont {
    NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
  }
}

/// A full-bleed native surface: paints the app ground and repaints itself when
/// the system appearance changes. Subclasses must still set `wantsLayer`.
class ThemedView: NSView {
  override var isFlipped: Bool { true }
  override var wantsUpdateLayer: Bool { true }

  override func updateLayer() {
    layer?.backgroundColor = Theme.bg.cgColor
  }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    needsDisplay = true
  }
}
