import Foundation

enum Format {
    /// Below this the tagger was not sure enough to file on its own. The same
    /// line as `REVIEW_THRESHOLD` on the server.
    static let reviewThreshold = 0.5

    private static let rupees: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.locale = Locale(identifier: "en_IN")
        formatter.currencyCode = "INR"
        formatter.maximumFractionDigits = 0
        return formatter
    }()

    private static let rupeesExact: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.locale = Locale(identifier: "en_IN")
        formatter.currencyCode = "INR"
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = 2
        return formatter
    }()

    /// "₹1,24,000". Totals round to the rupee.
    /// A balance, or dots while balances are hidden.
    static func inr(_ value: Double, hidden: Bool) -> String {
        hidden ? "₹ ••••••" : inr(value)
    }

    static func inr(_ value: Double) -> String {
        rupees.string(from: NSNumber(value: value == 0 ? 0 : value)) ?? "₹0"
    }

    /// "₹887.50". A single transaction keeps its paise.
    static func inrExact(_ value: Double) -> String {
        rupeesExact.string(from: NSNumber(value: value == 0 ? 0 : value)) ?? "₹0"
    }

    /// "−₹240" for money out, "+₹10,000" for money in.
    static func signed(_ transaction: Transaction) -> String {
        (transaction.isCredit ? "+" : "−") + inrExact(transaction.value)
    }

    private static let dayParser: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    static func parseDay(_ text: String) -> Date? {
        dayParser.date(from: String(text.prefix(10)))
    }

    /// "Today", "Yesterday", or "Mon, 28 Sept".
    static func dayTitle(_ date: Date?) -> String {
        guard let date else { return "No date" }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        return date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
    }

    /// "28 Sept".
    static func shortDay(_ date: Date?) -> String {
        guard let date else { return "No date" }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }

    static func percent(_ value: Double) -> String {
        "\(Int((value * 100).rounded()))%"
    }
}
