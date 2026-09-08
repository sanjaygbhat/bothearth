import AppKit

/// What the menu-bar item says. Three words, no jargon.
enum ShellStatus: String {
  case starting = "Starting…"
  case idle = "Idle"
  case working = "Working"
  /// Stopped and blocked on a person — distinct from working, which a badge
  /// alone cannot tell apart.
  case needsYou = "Waiting for you"
  case stopped = "Stopped"
}

/// Menu-bar presence: status, Open ModelBot, New task, Quit.
final class StatusItemController {
  private let item: NSStatusItem
  private let statusLine = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")

  var onOpen: (() -> Void)?
  var onNewTask: (() -> Void)?
  var onQuit: (() -> Void)?

  private(set) var status: ShellStatus = .starting

  /// Built once each — the menu-bar item redraws on every appearance change and
  /// on every status change, and re-rasterising an SVG there is wasteful.
  private static let idleIcon = markImage(side: 18)
  private static let attentionIcon = attentionImage(side: 18)

  init() {
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    item.button?.image = Self.idleIcon
    item.button?.toolTip = "ModelBot"

    let menu = NSMenu()
    statusLine.isEnabled = false
    menu.addItem(statusLine)
    menu.addItem(.separator())

    let open = NSMenuItem(title: "Open ModelBot", action: #selector(handleOpen), keyEquivalent: "")
    open.target = self
    menu.addItem(open)

    let newTask = NSMenuItem(title: "New task", action: #selector(handleNewTask), keyEquivalent: "")
    newTask.target = self
    menu.addItem(newTask)

    menu.addItem(.separator())
    let quit = NSMenuItem(title: "Quit ModelBot", action: #selector(handleQuit), keyEquivalent: "")
    quit.target = self
    menu.addItem(quit)

    item.menu = menu
  }

  func set(_ status: ShellStatus) {
    self.status = status
    statusLine.title = status.rawValue
    let waiting = status == .needsYou
    item.button?.image = waiting ? Self.attentionIcon : Self.idleIcon
    item.button?.toolTip = waiting ? "ModelBot — waiting for you" : "ModelBot"
  }

  @objc private func handleOpen() { onOpen?() }
  @objc private func handleNewTask() { onNewTask?() }
  @objc private func handleQuit() { onQuit?() }

  /// The Threshold, as a template image. Prefers the shipped brand mark
  /// (`assets/brand/mark-mono.svg`, copied into `Contents/Resources/mark.svg`
  /// by build.sh); falls back to the same geometry drawn in code so the app
  /// still builds in a checkout with no brand assets. A replacement SVG must be
  /// monochrome — a template image is used as a mask.
  static func markImage(side: CGFloat) -> NSImage {
    if let url = Bundle.main.url(forResource: "mark", withExtension: "svg"),
       let svg = NSImage(contentsOf: url), svg.isValid {
      svg.size = NSSize(width: side, height: side)
      svg.isTemplate = true
      return svg
    }
    return drawnMarkImage(side: side)
  }

  /// The waiting variant: the mark with a filled stone in the mouth of the
  /// enclosure — visibly different from idle at 18 px, still a template image.
  /// Drawn over whatever `markImage` produced, so it tracks a swapped-in mark.
  static func attentionImage(side: CGFloat) -> NSImage {
    let base = markImage(side: side)
    let image = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
      base.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
      let d = side * 0.46
      let dot = NSBezierPath(
        ovalIn: NSRect(
          x: rect.maxX - d - side * 0.02,
          y: rect.maxY - d - side * 0.02,
          width: d, height: d))
      NSColor.black.setFill()
      dot.fill()
      return true
    }
    image.isTemplate = true
    return image
  }

  private static func drawnMarkImage(side: CGFloat) -> NSImage {
    let view = MarkView(frame: NSRect(x: 0, y: 0, width: side, height: side))
    view.strokeColor = .black
    view.showsChevron = false  // below 32 px the chevron is dropped
    let image = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
      view.frame = rect
      view.draw(rect)
      return true
    }
    image.isTemplate = true
    return image
  }
}
