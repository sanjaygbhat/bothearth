import XCTest

final class NativeAcceptance: XCTestCase {
  func testNativeTaskAndControl() throws {
    continueAfterFailure = false
    let link = try XCTUnwrap(ProcessInfo.processInfo.environment["MODELBOT_NATIVE_LINK"])
    XCTAssertTrue(
      link.hasPrefix("https://localhost:7792/#bootstrap="), "Use only the disposable local fixture")
    let app = XCUIApplication()
    app.launch()
    if app.buttons["Connection"].exists {
      app.buttons["Connection"].tap()
      app.buttons["Forget connection locally"].tap()
      app.buttons["Forget"].tap()
    }
    let connection = app.secureTextFields["Workspace connection link"]
    XCTAssertTrue(connection.waitForExistence(timeout: 10))
    connection.tap()
    connection.typeText(link)
    app.buttons["Connect"].tap()
    capture(app, "native-connected")
    let start = app.buttons["Start task"]
    XCTAssertTrue(start.waitForExistence(timeout: 20))
    XCTAssertFalse(start.isEnabled, "An empty task cannot be submitted")
    let goal =
      app.textFields["What would you like to get done?"].exists
      ? app.textFields["What would you like to get done?"] : app.textViews.firstMatch
    goal.tap()
    goal.typeText("Review iOS fixture demo.user@example.test")
    start.tap()
    let row = app.buttons.containing(
      .staticText, identifier: "Review iOS fixture demo.user@example.test"
    ).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 20))
    row.tap()
    let result = app.staticTexts.containing(
      NSPredicate(format: "label CONTAINS %@", "END-NATIVE-RESULT")
    ).firstMatch
    if !result.waitForExistence(timeout: 5) { app.buttons["Refresh"].tap() }
    XCTAssertTrue(result.waitForExistence(timeout: 20))
    capture(app, "native-result")
    app.buttons["Open computer"].tap()
    let web = app.webViews.firstMatch
    XCTAssertTrue(web.waitForExistence(timeout: 20))
    let take = web.buttons["Take control"]
    if take.waitForExistence(timeout: 5) && take.isEnabled { take.tap() }
    let summary = web.descendants(matching: .any).matching(identifier: "Type on computer")
      .firstMatch
    XCTAssertTrue(summary.waitForExistence(timeout: 20))
    summary.tap()
    let entry = web.textViews.firstMatch
    XCTAssertTrue(entry.waitForExistence(timeout: 10))
    entry.tap()
    entry.typeText("demo.user@example.test · é")
    capture(app, "native-keyboard")
    web.buttons["Type text"].tap()
    XCTAssertTrue(web.staticTexts["Text sent to the selected field."].waitForExistence(timeout: 10))
    XCTAssertLessThanOrEqual(web.buttons["Return control"].frame.maxX, app.frame.width + 2, "Phone keyboard must not zoom control actions beyond the viewport")
    capture(app, "native-control")
    XCUIDevice.shared.press(.home)
    app.activate()
    XCTAssertTrue(
      web.descendants(matching: .any).matching(identifier: "Type on computer").firstMatch
        .waitForExistence(timeout: 20))
    app.buttons["Back to tasks"].tap()
    app.terminate()
    app.launch()
    XCTAssertTrue(
      app.buttons["Start task"].waitForExistence(timeout: 20),
      "Keychain session restores without retaining the pairing link")
    app.buttons.containing(.staticText, identifier: "Review iOS fixture demo.user@example.test").firstMatch.tap()
    app.buttons["Open computer"].tap()
    XCTAssertTrue(app.webViews.firstMatch.descendants(matching: .any).matching(identifier: "Type on computer").firstMatch.waitForExistence(timeout: 20))
    print("NATIVE_REVOCATION_READY")
    XCTAssertTrue(app.secureTextFields["Workspace connection link"].waitForExistence(timeout: 30))
    XCTAssertFalse(app.webViews.firstMatch.exists, "Revoked device cannot retain the control screen")
    capture(app, "native-revoked")
  }
  private func capture(_ app: XCUIApplication, _ name: String) { let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment) }
}
