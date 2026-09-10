import AppKit

/// A real macOS menu bar. Every item either does a native thing or hands the
/// page one `modelbot:native` event — nothing in between.
enum MainMenu {
  static let helpURL = URL(string: "https://github.com/sanjaygbhat/bothearth")!

  static func build(target: AppDelegate) -> NSMenu {
    let main = NSMenu()

    // MARK: App
    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    add(appMenu, "About BotHearth", #selector(AppDelegate.showAbout), "", target)
    appMenu.addItem(.separator())
    add(appMenu, "Settings…", #selector(AppDelegate.openSettings), ",", target)
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Hide BotHearth",
                    action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    let hideOthers = NSMenuItem(title: "Hide Others",
                                action: #selector(NSApplication.hideOtherApplications(_:)),
                                keyEquivalent: "h")
    hideOthers.keyEquivalentModifierMask = [.command, .option]
    appMenu.addItem(hideOthers)
    appMenu.addItem(withTitle: "Show All",
                    action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
    appMenu.addItem(.separator())
    add(appMenu, "Quit BotHearth", #selector(AppDelegate.quit), "q", target)
    appItem.submenu = appMenu
    main.addItem(appItem)

    // MARK: File
    let fileItem = NSMenuItem()
    let fileMenu = NSMenu(title: "File")
    add(fileMenu, "New task", #selector(AppDelegate.newTask), "n", target)
    fileMenu.addItem(.separator())
    fileMenu.addItem(withTitle: "Close Window",
                     action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    fileItem.submenu = fileMenu
    main.addItem(fileItem)

    // MARK: Edit — the standard responder-chain set, so Cmd-C/V/A/Z all work.
    let editItem = NSMenuItem()
    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
    redo.keyEquivalentModifierMask = [.command, .shift]
    editMenu.addItem(redo)
    editMenu.addItem(.separator())
    editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "Select All",
                     action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = editMenu
    main.addItem(editItem)

    // MARK: View
    let viewItem = NSMenuItem()
    let viewMenu = NSMenu(title: "View")
    // ⌘K and ⌘/ are claimed here, so the keystroke never reaches the page; the
    // shell hands the page an `open-palette` / `open-keys` event instead and
    // src/ui/palette.ts runs the same code path either way.
    add(viewMenu, "Find a command…", #selector(AppDelegate.openPalette), "k", target)
    viewMenu.addItem(.separator())
    add(viewMenu, "Back", #selector(AppDelegate.goBack), "[", target)
    viewMenu.addItem(.separator())
    add(viewMenu, "Reload", #selector(AppDelegate.reload), "r", target)
    viewMenu.addItem(.separator())
    add(viewMenu, "Actual Size", #selector(AppDelegate.zoomActual), "0", target)
    add(viewMenu, "Zoom In", #selector(AppDelegate.zoomIn), "+", target)
    add(viewMenu, "Zoom Out", #selector(AppDelegate.zoomOut), "-", target)
    viewItem.submenu = viewMenu
    main.addItem(viewItem)

    // MARK: Window
    let windowItem = NSMenuItem()
    let windowMenu = NSMenu(title: "Window")
    windowMenu.addItem(withTitle: "Minimize",
                       action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    windowMenu.addItem(withTitle: "Zoom",
                       action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
    windowMenu.addItem(.separator())
    windowMenu.addItem(withTitle: "Bring All to Front",
                       action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
    windowItem.submenu = windowMenu
    main.addItem(windowItem)
    NSApp.windowsMenu = windowMenu

    // MARK: Debug (opt-in: MODELBOT_DEBUG=1 or --debug)
    if AppFlags.debugEnabled {
      let debugItem = NSMenuItem()
      let debugMenu = NSMenu(title: "Debug")
      add(debugMenu, "Test notification", #selector(AppDelegate.testNotification), "", target)
      add(debugMenu, "Test bridge", #selector(AppDelegate.testBridge), "", target)
      add(debugMenu, "Show error state", #selector(AppDelegate.showErrorState), "", target)
      add(debugMenu, "Open log", #selector(AppDelegate.showLog), "", target)
      debugItem.submenu = debugMenu
      main.addItem(debugItem)
    }

    // MARK: Help
    let helpItem = NSMenuItem()
    let helpMenu = NSMenu(title: "Help")
    add(helpMenu, "Keyboard shortcuts", #selector(AppDelegate.openKeys), "/", target)
    helpMenu.addItem(.separator())
    add(helpMenu, "BotHearth Help", #selector(AppDelegate.openHelp), "?", target)
    helpItem.submenu = helpMenu
    main.addItem(helpItem)
    NSApp.helpMenu = helpMenu

    return main
  }

  @discardableResult
  private static func add(
    _ menu: NSMenu, _ title: String, _ action: Selector, _ key: String,
    _ target: AnyObject, modifiers: NSEvent.ModifierFlags? = nil
  ) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
    item.target = target
    if let modifiers { item.keyEquivalentModifierMask = modifiers }
    menu.addItem(item)
    return item
  }
}
