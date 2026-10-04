import Foundation
import Observation

enum AppTab: Hashable {
    case home, inbox, transactions, parkings
}

/// What several screens share: the pickers' lists and the Inbox count.
@Observable
final class AppStore {
    let api: APIClient
    var meta: Meta?
    var inboxCount = 0
    var selectedTab: AppTab = .home
    /// Bumped after any edit so every screen reloads what it shows.
    var revision = 0
    /// Bank balances show as dots until the eye is tapped; hidden again on
    /// every launch and every return from the background.
    var balancesHidden = true
    /// A statement file shared into the app, waiting to be reconciled.
    var sharedStatement: SharedFile?

    init(api: APIClient) {
        self.api = api
        meta = api.cached("meta")
        inboxCount = (api.cached("inbox") as TransactionList?)?.transactions.count ?? 0
        #if DEBUG
        switch ProcessInfo.processInfo.environment["FINANCE_TAB"] {
        case "inbox": selectedTab = .inbox
        case "transactions": selectedTab = .transactions
        case "buckets", "parkings": selectedTab = .parkings
        default: break
        }
        #endif
    }

    var categories: [CategoryInfo] { meta?.categories ?? [] }
    var buckets: [BucketRef] { meta?.buckets ?? [] }

    func bucketName(_ id: String?) -> String? {
        guard let id else { return nil }
        return buckets.first { $0.id == id }?.name
    }

    func mayHoldBucket(_ category: String?) -> Bool {
        guard let category else { return true }
        return categories.first { $0.name == category }?.mayHoldBucket ?? true
    }

    /// On launch and on return from the background: fetch what every tab
    /// opens on, so each one shows today's numbers, not the last session's.
    /// Screens load when they appear, so only a return from the background
    /// needs `reloadVisible` to refresh the ones already on view.
    func refreshAll(reloadVisible: Bool) async {
        // Messages the Shortcut could not send go first, so the lists include them.
        await Ingestor.shared.flush()
        async let meta: Void = loadMeta()
        async let inbox: Void = refreshInboxCount()
        async let transactions: TransactionList? = try? api.get("transactions")
        async let buckets: ParkingsOverview? = try? api.get("parkings")
        _ = await (meta, inbox, transactions, buckets)
        if reloadVisible { revision += 1 }
    }

    /// Whether a row is done with the Inbox: the client's mirror of the
    /// server's `needsInput`: a category the tagger is sure of, or the user
    /// chose. Parkings are never asked about.
    func leavesInbox(_ t: Transaction) -> Bool {
        guard t.category != nil else { return false }
        return !t.isUnsure || t.taggedBy == "user"
    }

    func loadMeta() async {
        if let fresh: Meta = try? await api.get("meta") {
            meta = fresh
        }
    }

    func refreshInboxCount() async {
        if let list: TransactionList = try? await api.get("inbox") {
            inboxCount = list.transactions.count
        }
    }

    /// Saves what a transaction was for; Gemini files it. Returns the result.
    func describe(_ id: String, _ text: String) async throws -> Described {
        struct Body: Encodable { let description: String }
        let result: Described = try await api.send("POST", "transactions/\(id)/describe", body: Body(description: text))
        changed()
        return result
    }

    /// A hand decision on the category.
    func setCategory(_ id: String, _ category: String?) async throws -> Transaction {
        let row: Transaction = try await api.send("PATCH", "transactions/\(id)", body: NullableBody(key: "category", value: category))
        changed()
        return row
    }

    /// A hand decision on the bucket; nil sends it back to the pool.
    func setBucket(_ id: String, _ bucketId: String?) async throws -> Transaction {
        let row: Transaction = try await api.send("PATCH", "transactions/\(id)", body: NullableBody(key: "bucket_id", value: bucketId))
        changed()
        return row
    }

    // MARK: Parkings

    /// `from`/`to` nil is Float.
    func move(from: String?, to: String?, amount: Double) async throws {
        struct Body: Encodable { let from: String?; let to: String?; let amount: Double
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(from, forKey: .from)   // explicit null means Float
                try c.encode(to, forKey: .to)
                try c.encode(amount, forKey: .amount)
            }
            enum CodingKeys: String, CodingKey { case from, to, amount }
        }
        struct Reply: Decodable { let ids: [String] }
        let _: Reply = try await api.send("POST", "parkings/moves", body: Body(from: from, to: to, amount: amount))
        changed()
    }

    func undoMove(_ id: String) async throws {
        struct Reply: Decodable { let undone: [String] }
        struct Empty: Encodable {}
        let _: Reply = try await api.send("DELETE", "parkings/moves/\(id)", body: Empty())
        changed()
    }

    func createParking(name: String, goal: Double?) async throws -> Parking {
        struct Body: Encodable { let name: String; let goal: Double? }
        let parking: Parking = try await api.send("POST", "parkings", body: Body(name: name, goal: goal))
        await loadMeta()
        changed()
        return parking
    }

    /// Renames and sets or clears the goal.
    func updateParking(_ id: String, name: String, goal: Double?) async throws {
        struct Body: Encodable { let name: String; let goal: Double?
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(name, forKey: .name)
                try c.encode(goal, forKey: .goal)   // explicit null clears it
            }
            enum CodingKeys: String, CodingKey { case name, goal }
        }
        let _: Parking = try await api.send("PATCH", "parkings/\(id)", body: Body(name: name, goal: goal))
        await loadMeta()
        changed()
    }

    /// Its money returns to Float; what was filed to it is unfiled.
    func deleteParking(_ id: String) async throws {
        struct Reply: Decodable { let deleted: String }
        struct Empty: Encodable {}
        let _: Reply = try await api.send("DELETE", "parkings/\(id)", body: Empty())
        await loadMeta()
        changed()
    }

    /// A file from the share sheet ("Open in Finance"). Read now: the copy
    /// iOS hands over lives in the app's Inbox folder and is removed after.
    func receive(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { return }
        sharedStatement = SharedFile(name: url.lastPathComponent, data: data)
        try? FileManager.default.removeItem(at: url)
    }

    func changed() {
        revision += 1
        Task { await refreshInboxCount() }
    }
}

/// `{ "<key>": value }` that writes an explicit `null`, which the server reads
/// as "clear it". Synthesized Encodable would drop the key instead.
private struct NullableBody: Encodable {
    let key: String
    let value: String?

    struct Key: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        try container.encode(value, forKey: Key(stringValue: key))
    }
}

struct SharedFile: Identifiable {
    let id = UUID()
    let name: String
    let data: Data
}
