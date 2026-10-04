import Foundation

// Shapes returned by the web app's /api/v1. Decoded with
// `.convertFromSnakeCase`, so `sub_category` arrives as `subCategory`.

/// A number that may arrive as a JSON number or, from NUMERIC columns, a string.
struct Amount: Codable, Hashable {
    let value: Double

    init(_ value: Double) { self.value = value }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let number = try? container.decode(Double.self) {
            value = number
        } else if let text = try? container.decode(String.self), let number = Double(text) {
            value = number
        } else {
            value = 0
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(value)
    }
}

struct Cycle: Codable, Hashable, Identifiable {
    let id: String
    let label: String
    let startDate: String
    let endDate: String
}

struct Transaction: Codable, Hashable, Identifiable {
    let id: String
    var transactionDate: String?
    var receivedAt: String?
    var merchant: String?
    var amount: Amount?
    var direction: String?
    var bank: String?
    var source: String?
    var category: String?
    /// What the user says this was for ("bike fuel"). Gemini reads it; only
    /// the user writes it.
    var subCategory: String?
    var bucketId: String?
    var aiConfidence: Double?
    var taggedBy: String?
    var reviewedAt: String?
    var rawBody: String?
    var accountLast4: String?

    var value: Double { amount?.value ?? 0 }
    var isCredit: Bool { direction == "credit" }
    /// Money between the user's own accounts: not spending, just noise in a list.
    var isSelfTransfer: Bool { category == "Self Transfer" }
    var date: Date? { transactionDate.flatMap(Format.parseDay) }

    /// Below the line the tagger was not sure enough to file on its own.
    var isUnsure: Bool {
        guard let aiConfidence else { return false }
        return aiConfidence < Format.reviewThreshold
    }
}

struct CategoryAmount: Codable, Hashable, Identifiable {
    let category: String
    let amount: Double
    var id: String { category }
}

struct Summary: Codable {
    let cycle: Cycle
    let income: Double
    let spend: Double
    let investments: Double
    let leftover: Double
    /// The cycle's salary credit; nil until it lands.
    var salary: SalaryCredit?
    /// Of this cycle's spend, what parkings paid; the rest came from Float.
    var fromParkings: Double?
    let categories: [CategoryAmount]
    let inboxCount: Int
    let recent: [Transaction]
}

struct SalaryCredit: Codable {
    let amount: Double
    let date: String?
}

struct CategoryInfo: Codable, Hashable, Identifiable {
    let name: String
    let mayHoldBucket: Bool
    var id: String { name }
}

struct BucketRef: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let type: String
    let isDefault: Bool
}

struct Meta: Codable {
    let categories: [CategoryInfo]
    let buckets: [BucketRef]
    let cycles: [Cycle]
    let currentCycleId: String?
    /// The user's bank accounts, by the digits their SMS show. Optional so a
    /// cached reply from before this field still decodes.
    var accounts: [KnownAccount]?
}

struct KnownAccount: Codable, Hashable {
    let bank: String
    let last4: String
}

/// `POST /api/v1/statements/detect`.
struct DetectedBank: Codable {
    let bank: String?
    let by: String?
}

struct TransactionList: Codable {
    let cycle: Cycle?
    let transactions: [Transaction]
}

/// What a row holds after the user describes it and Gemini files it.
struct Described: Codable {
    let category: String?
    let bucketId: String?
    let aiConfidence: Double?
}

struct AuthSession: Codable, Equatable {
    let accessToken: String
    let refreshToken: String
    let expiresAt: Int
    let email: String?
}

/// What `POST /api/v1/statements` found reconciling a statement file.
struct StatementReport: Codable {
    let bank: String
    let parsed: Int
    let periodStart: String
    let periodEnd: String
    let periodDeclared: Bool
    let backfilled: Int
    let alreadyPresent: Int
    let unmatchedInDb: Int
    let matchedUndated: Int
    let samples: [Sample]
    /// The statement's closing balance, kept as a reading. Nil for a file
    /// without a running balance (or an older server).
    var balance: ClosingBalance?

    struct ClosingBalance: Codable {
        let closing: Double
        let at: String
        let predicted: Double?
        let drift: Double?
        let saved: Bool
        let error: String?
    }

    struct Sample: Codable, Hashable {
        let date: String
        let amount: Double
        let direction: String
        let description: String
    }
}

/// `GET /api/v1/balance`: the bank balance as the app keeps it.
struct AccountBalances: Codable {
    /// Nil until every account has a reading.
    let total: Double?
    let accounts: [Account]

    struct Account: Codable, Identifiable {
        let bank: String
        let balance: Double?
        let anchor: Anchor?
        let movedSince: Int
        let lastCheck: Check?
        let checks: Checks
        var id: String { bank }

        var name: String { bank == "AXIS" ? "Axis" : bank }
    }

    struct Anchor: Codable {
        let balance: Double
        let at: String
        let origin: String
    }

    struct Check: Codable {
        let at: String
        let origin: String
        let predicted: Double
        let actual: Double
        let drift: Double
    }

    struct Checks: Codable {
        let total: Int
        let matched: Int
    }

    /// The most recent comparison with a bank reading, across accounts.
    var lastCheck: Check? {
        accounts.compactMap(\.lastCheck).max { $0.at < $1.at }
    }
}

// MARK: - Parkings and Float

/// `GET /api/v1/parkings`.
struct ParkingsOverview: Codable {
    let float: FloatInfo
    let parkings: [Parking]
    let suggestion: Suggestion

    struct Suggestion: Codable {
        let moves: [SuggestedMove]
        let parkedThisMonth: Bool
    }

    struct SuggestedMove: Codable, Hashable {
        let parkingId: String
        let amount: Double
    }
}

/// The bank balance not parked anywhere.
struct FloatInfo: Codable {
    /// Nil until every bank account has a balance reading.
    let balance: Double?
    let bankTotal: Double?
    let monthIn: Double
    let monthOut: Double
    /// Card spend since the last card bill: not out of the bank yet.
    let cardSinceBill: Double
}

/// Money set aside inside the bank balance: an emergency fund, a trip.
struct Parking: Codable, Hashable, Identifiable {
    let id: String
    var name: String
    var goal: Double?
    var sortOrder: Int?
    var balance: Double

    /// 0...1 toward the goal, nil without one.
    var progress: Double? {
        guard let goal, goal > 0 else { return nil }
        return min(max(balance / goal, 0), 1)
    }
    var goalReached: Bool { (goal ?? .infinity) <= balance }
}

/// `GET /api/v1/parkings/:id`.
struct ParkingDetail: Codable {
    let parking: Parking
    let moves: [ParkingMove]
    let transactions: [Transaction]
}

struct ParkingMove: Codable, Hashable, Identifiable {
    let id: String
    let amount: Double
    let kind: String
    let occurredOn: String?
    let createdAt: String?
    /// The other side: Float or another parking. Nil for an adjustment.
    let counterpart: String?
    let note: String?
}
