import BackgroundTasks
import Foundation

/// The server's reply to `POST /api/v1/ingest`.
struct IngestResult: Codable {
    let id: String
    var isSpam: Bool?
    /// The server already had this SMS; the rest describes that row.
    var duplicate: Bool?
    var summary: String?
    var needsReview: Bool?
    var parsed: Parsed?

    struct Parsed: Codable {
        var category: String?
        var bucket: String?
        var amount: Amount?
        var direction: String?
        var merchant: String?
    }
}

/// Relays bank SMS from the Shortcuts automation to the server and shows the
/// outcome as a notification. Parsing and tagging stay on the server; this
/// owns the round trip. Every message is written to the queue before it is
/// sent and leaves only when the server has it, so nothing is lost if iOS
/// stops the action mid-request or the phone is offline.
final class Ingestor {
    static let shared = Ingestor(api: .shared)

    /// Identifies the background refresh that sends what is queued.
    static let backgroundTask = "com.anshsaini.finance.send-queued"

    struct Pending: Codable, Hashable {
        let body: String
        let sender: String?
        /// When the SMS arrived, so a late send is still dated correctly.
        let timestamp: String
    }

    /// Long enough for the server to file a message with Gemini; short enough
    /// that a bad connection falls back to the queue while the Shortcuts
    /// action still has time to say so.
    private static let timeout: TimeInterval = 15

    private let api: APIClient
    private let queueFile: URL
    private var running: Task<Void, Never>?
    /// What the last pass sent, so `log` can return its own message's result.
    private var delivered: [Pending: IngestResult] = [:]

    init(
        api: APIClient,
        queueFile: URL = URL.applicationSupportDirectory.appending(path: "pending-messages.json")
    ) {
        self.api = api
        self.queueFile = queueFile
    }

    /// Queues one SMS, then sends the queue oldest first. Returns this
    /// message's result, or nil when it is still waiting.
    @discardableResult
    func log(body: String, sender: String?) async -> IngestResult? {
        let message = Pending(
            body: body.trimmingCharacters(in: .whitespacesAndNewlines),
            sender: sender,
            timestamp: Date().ISO8601Format()
        )
        guard !message.body.isEmpty else { return nil }
        enqueue(message)
        await flush()
        if let result = delivered.removeValue(forKey: message) { return result }
        await Notifier.shared.queued(waiting: pending.count, signedOut: !api.isSignedIn)
        return nil
    }

    /// Sends what is waiting, oldest first; stops at the first failure. One
    /// pass at a time: a second caller waits for the running pass, then
    /// makes its own, so the app and the action never send the same message
    /// twice at once.
    func flush() async {
        // Passes the app runs on its own leave results nobody reads.
        if delivered.count > 50 { delivered.removeAll() }
        if let running { await running.value }
        let pass = Task { await drain() }
        running = pass
        await pass.value
        running = nil
        scheduleBackgroundSend()
    }

    private func drain() async {
        while let next = pending.first {
            guard let result = try? await send(next) else { return }
            dequeue(next)
            delivered[next] = result
            await Notifier.shared.transaction(result)
        }
    }

    private func send(_ message: Pending) async throws -> IngestResult {
        try await api.send("POST", "ingest", body: message, timeout: Self.timeout)
    }

    /// While anything waits, ask iOS to wake the app later and send it, so it
    /// goes out without the app being opened. iOS decides when.
    private func scheduleBackgroundSend() {
        let scheduler = BGTaskScheduler.shared
        guard !pending.isEmpty else {
            scheduler.cancel(taskRequestWithIdentifier: Self.backgroundTask)
            return
        }
        let request = BGAppRefreshTaskRequest(identifier: Self.backgroundTask)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? scheduler.submit(request)
    }

    // MARK: Queue

    var pending: [Pending] {
        guard let data = try? Data(contentsOf: queueFile) else { return [] }
        return (try? JSONDecoder().decode([Pending].self, from: data)) ?? []
    }

    private func enqueue(_ message: Pending) {
        var queue = pending
        guard !queue.contains(message) else { return }
        queue.append(message)
        save(queue)
    }

    private func dequeue(_ message: Pending) {
        save(pending.filter { $0 != message })
    }

    private func save(_ queue: [Pending]) {
        try? FileManager.default.createDirectory(
            at: queueFile.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try? JSONEncoder().encode(queue).write(to: queueFile, options: .atomic)
    }
}
