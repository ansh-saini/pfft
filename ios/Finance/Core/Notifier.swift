import Foundation
import UserNotifications

/// The app's own notifications for logged transactions, in place of the
/// Shortcuts banner. One that the tagger was unsure about carries a reply
/// field; the reply is sent as the description and the notification is
/// replaced with what was filed.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()

    private static let askCategory = "needs-input"
    private static let describeAction = "describe"
    private static let thread = "transactions"

    private let center = UNUserNotificationCenter.current()
    private weak var store: AppStore?

    /// Called once at launch, including a background launch for a reply.
    func attach(_ store: AppStore) {
        self.store = store
        center.delegate = self
        let describe = UNTextInputNotificationAction(
            identifier: Self.describeAction,
            title: "Say What It Was For",
            textInputButtonTitle: "File",
            textInputPlaceholder: "e.g. bike fuel"
        )
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Self.askCategory, actions: [describe], intentIdentifiers: [])
        ])
    }

    func requestPermission() async {
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
    }

    // MARK: Posting

    func transaction(_ result: IngestResult) async {
        guard result.isSpam != true, let parsed = result.parsed else { return }
        let content = UNMutableNotificationContent()
        content.title = Self.title(parsed)
        content.threadIdentifier = Self.thread
        content.userInfo = ["id": result.id, "title": content.title]
        if result.needsReview == true {
            content.body = "Not sure what this was. Reply to say and it gets filed."
            content.categoryIdentifier = Self.askCategory
        } else {
            content.body = Self.filedLine(category: parsed.category, bucket: parsed.bucket)
        }
        if result.duplicate == true { content.subtitle = "Already logged" }
        content.sound = .default
        await post(id: result.id, content)
    }

    func queued(waiting: Int, signedOut: Bool) async {
        let content = UNMutableNotificationContent()
        content.title = waiting > 1 ? "\(waiting) transactions saved, not sent yet" : "Saved, not sent yet"
        content.body = signedOut
            ? "Open Finance and sign in to send \(waiting > 1 ? "them" : "it")."
            : "Finance will send \(waiting > 1 ? "them" : "it") when it can reach the server."
        content.threadIdentifier = Self.thread
        await post(id: "queued", content)
    }

    private func post(id: String, _ content: UNNotificationContent) async {
        try? await center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }

    static func title(_ parsed: IngestResult.Parsed) -> String {
        let amount = Format.inrExact(parsed.amount?.value ?? 0)
        guard let merchant = parsed.merchant?.trimmingCharacters(in: .whitespaces), !merchant.isEmpty else {
            return parsed.direction == "credit" ? "\(amount) received" : "\(amount) spent"
        }
        // Banks shout merchant names; "NEW ADARSH DAIR" reads better as "New Adarsh Dair".
        let name = merchant == merchant.uppercased() ? merchant.capitalized : merchant
        return parsed.direction == "credit" ? "\(amount) from \(name)" : "\(amount) at \(name)"
    }

    static func filedLine(category: String?, bucket: String?) -> String {
        switch (category, bucket) {
        case let (category?, bucket?): "\(category) · \(bucket)"
        case let (category?, nil): category
        case let (nil, bucket?): bucket
        default: "Filed"
        }
    }

    // MARK: UNUserNotificationCenterDelegate

    /// Shown as a banner even when the app is open.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        guard let id = info["id"] as? String else { return }

        if let reply = response as? UNTextInputNotificationResponse {
            let text = reply.userText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return }
            await describe(id: id, text: text, title: info["title"] as? String)
        } else if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
                  response.notification.request.content.categoryIdentifier == Self.askCategory {
            store?.selectedTab = .inbox
        }
    }

    private func describe(id: String, text: String, title: String?) async {
        let content = UNMutableNotificationContent()
        content.title = title ?? "Transaction"
        content.threadIdentifier = Self.thread
        do {
            let result: Described
            if let store {
                result = try await store.describe(id, text)
            } else {
                struct Body: Encodable { let description: String }
                result = try await APIClient.shared.send("POST", "transactions/\(id)/describe", body: Body(description: text))
            }
            let meta: Meta? = APIClient.shared.cached("meta")
            let bucket = meta?.buckets.first { $0.id == result.bucketId }?.name
            let unsure = (result.aiConfidence ?? 1) < Format.reviewThreshold
            content.body = unsure
                ? "\"\(text)\" saved. Still not sure where it goes; it waits in the Inbox."
                : "\"\(text)\": \(Self.filedLine(category: result.category, bucket: bucket))"
        } catch {
            content.body = "Could not save \"\(text)\". \(error.localizedDescription)"
            content.userInfo = ["id": id, "title": content.title]
            content.categoryIdentifier = Self.askCategory
        }
        await post(id: id, content)
    }
}
