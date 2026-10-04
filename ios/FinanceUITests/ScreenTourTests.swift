import XCTest

/// Drives the real app like a person: every tab, a transaction, a bucket, and
/// typing in the Inbox with the keyboard up, timing each step. Read-only: it
/// never submits a description or picks a category.
///
/// Needs a session: run with `TEST_RUNNER_FINANCE_ACCESS_TOKEN=<access token>`
/// (and optionally `TEST_RUNNER_FINANCE_SERVER`) in the environment, which
/// xcodebuild hands to this runner without the prefix.
@MainActor
final class ScreenTourTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = true
        let env = ProcessInfo.processInfo.environment
        guard let token = env["FINANCE_ACCESS_TOKEN"], !token.isEmpty else {
            throw XCTSkip("Set TEST_RUNNER_FINANCE_ACCESS_TOKEN to run the tour")
        }
        app = XCUIApplication()
        app.launchEnvironment["FINANCE_ACCESS_TOKEN"] = token
        if let server = env["FINANCE_SERVER"] { app.launchEnvironment["FINANCE_SERVER"] = server }
    }

    /// Times one step: `action`, then waits for `element` to exist.
    @discardableResult
    private func step(_ name: String, timeout: TimeInterval = 15, _ action: () -> Void, until element: XCUIElement) -> TimeInterval {
        let start = Date()
        action()
        let found = element.waitForExistence(timeout: timeout)
        let elapsed = Date().timeIntervalSince(start)
        print("TIMING \(name): \(String(format: "%.2f", elapsed))s\(found ? "" : " (NOT FOUND)")")
        XCTAssertTrue(found, "\(name): \(element) did not appear within \(timeout)s")
        return elapsed
    }

    private func tab(_ name: String) -> XCUIElement { app.tabBars.buttons[name] }

    func testTourEveryScreen() throws {
        step("launch to Home", { app.launch() }, until: app.staticTexts["Spent this cycle"])

        // Balances start hidden; the eye shows them.
        let dots = app.staticTexts["₹ ••••••"].firstMatch
        XCTAssertTrue(dots.waitForExistence(timeout: 10), "balances not hidden by default")
        step("show balances", { app.buttons["Show balances"].firstMatch.tap() }, until: app.buttons["Hide balances"].firstMatch)
        XCTAssertFalse(app.staticTexts["₹ ••••••"].exists, "balances still hidden after the eye")

        step("Inbox tab", { tab("Inbox").tap() }, until: app.navigationBars["Inbox"])
        step("Transactions tab", { tab("Transactions").tap() }, until: app.searchFields.firstMatch)
        step("Parkings tab", { tab("Parkings").tap() }, until: app.staticTexts["Float"])
        step("Home tab", { tab("Home").tap() }, until: app.staticTexts["Spent this cycle"])

        // A transaction's detail, from the Transactions list.
        tab("Transactions").tap()
        let firstRow = app.collectionViews.buttons.firstMatch
        XCTAssertTrue(firstRow.waitForExistence(timeout: 15), "no transaction rows")
        step("open transaction", { firstRow.tap() }, until: app.staticTexts["Original SMS"])
        XCTAssertTrue(
            app.staticTexts["Paid from"].exists || app.staticTexts["Goes into"].exists,
            "no Paid from / Goes into picker"
        )
        // Typing with the keyboard up while the full row loads underneath.
        let describe = app.textFields.firstMatch
        if describe.waitForExistence(timeout: 5) {
            step("focus description", { describe.tap() }, until: app.keyboards.firstMatch)
            let typed = Date()
            describe.typeText(" tour")
            print("TIMING type 5 chars in detail: \(String(format: "%.2f", Date().timeIntervalSince(typed)))s")
            // The tap may land mid-text, so the typing can land mid-text too.
            XCTAssertTrue((describe.value as? String ?? "").contains("tour"), "typing did not reach the field")
            let scrolled = Date()
            app.scrollViews.firstMatch.swipeUp()
            print("TIMING scroll with keyboard in detail: \(String(format: "%.2f", Date().timeIntervalSince(scrolled)))s")
        }
        step("close transaction", { app.buttons["Close"].tap() }, until: app.searchFields.firstMatch)

        // A parking's detail.
        tab("Parkings").tap()
        let fund = app.buttons.containing(NSPredicate(format: "label CONTAINS 'Emergency Fund'")).firstMatch
        XCTAssertTrue(fund.waitForExistence(timeout: 15), "no Emergency Fund parking")
        step("open parking", { fund.tap() }, until: app.navigationBars["Emergency Fund"])
        XCTAssertTrue(app.buttons["Move In"].exists, "no Move In button")
        step("back to parkings", { app.navigationBars.buttons.firstMatch.tap() }, until: app.staticTexts["Float"])

        // The reported freeze: keyboard up in the Inbox while it loads.
        tab("Inbox").tap()
        let field = app.textFields.firstMatch
        guard field.waitForExistence(timeout: 15) else {
            print("TIMING inbox: empty, no field to type in")
            return
        }
        step("focus inbox field", { field.tap() }, until: app.keyboards.firstMatch)
        let typed = Date()
        field.typeText("tour")
        print("TIMING type 4 chars: \(String(format: "%.2f", Date().timeIntervalSince(typed)))s")
        XCTAssertEqual(field.value as? String, "tour", "typing did not reach the field")

        let scrolled = Date()
        app.scrollViews.firstMatch.swipeUp()
        print("TIMING scroll with keyboard: \(String(format: "%.2f", Date().timeIntervalSince(scrolled)))s")

        // Pull to refresh while the field holds text: the load runs under it.
        app.scrollViews.firstMatch.swipeDown()
        app.scrollViews.firstMatch.swipeDown()
        let refreshed = Date()
        XCTAssertTrue(tab("Home").isHittable, "tab bar not hittable after refresh")
        step("Home after inbox", { tab("Home").tap() }, until: app.staticTexts["Spent this cycle"])
        print("TIMING settle after refresh: \(String(format: "%.2f", Date().timeIntervalSince(refreshed)))s")
    }
}
