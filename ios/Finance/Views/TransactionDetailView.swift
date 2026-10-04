import SwiftUI

/// One transaction, full screen: a hero tinted with its category, what it was
/// for, where it was filed, and the SMS it came from. Pull down to close.
struct TransactionDetailView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var transaction: Transaction
    @State private var error: String?

    init(transaction: Transaction) {
        _transaction = State(initialValue: transaction)
    }

    private var tint: Color { CategoryStyle.color(transaction.category) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    hero
                    VStack(spacing: 16) {
                        describeCard
                        filingCard
                        detailsCard
                        if let body = transaction.rawBody, !body.isEmpty {
                            smsCard(body)
                        }
                    }
                    .padding(.horizontal)
                    .padding(.bottom, 32)
                }
            }
            .background {
                LinearGradient(
                    stops: [
                        .init(color: tint, location: 0),
                        .init(color: tint.mix(with: Color(.systemGroupedBackground), by: 0.55), location: 0.35),
                        .init(color: Color(.systemGroupedBackground), location: 0.7),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .ignoresSafeArea()
            }
            .onScrollPhaseChange { oldPhase, newPhase, context in
                let overscroll = context.geometry.contentOffset.y + context.geometry.contentInsets.top
                if oldPhase == .interacting, newPhase != .interacting, overscroll < -110 {
                    dismiss()
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark").font(.subheadline.weight(.semibold))
                    }
                    .tint(.white)
                    .accessibilityLabel("Close")
                }
            }
            .toolbarBackground(.hidden, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .task { await loadFull() }
            .animation(.snappy, value: transaction)
        }
    }

    /// The list rows carry no SMS text; fetch the full row once.
    private func loadFull() async {
        if let full: Transaction = try? await store.api.get("transactions/\(transaction.id)", cache: false) {
            withAnimation(.smooth) { transaction = full }
        }
    }

    // MARK: Hero

    private var hero: some View {
        VStack(spacing: 12) {
            Image(systemName: CategoryStyle.symbol(transaction.category))
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 60, height: 60)
                .background(.white.opacity(0.2), in: Circle())
            Text(transaction.merchant ?? "Unknown")
                .font(.headline)
                .foregroundStyle(.white.opacity(0.9))
                .lineLimit(1)
            // Default design, not .rounded: SF Rounded has no ₹ glyph.
            Text(Format.signed(transaction))
                .font(.system(size: 52, weight: .bold))
                .monospacedDigit()
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
            Text(Format.dayTitle(transaction.date))
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.85))
            HStack(spacing: 8) {
                chip(transaction.category ?? "Untagged", CategoryStyle.symbol(transaction.category))
                if let bucket = store.bucketName(transaction.bucketId) {
                    chip(bucket, "parkingsign.circle")
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 12)
        .padding(.bottom, 28)
        .padding(.horizontal)
    }

    private func chip(_ text: String, _ symbol: String) -> some View {
        Label(text, systemImage: symbol)
            .font(.caption.weight(.medium))
            .foregroundStyle(.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(.white.opacity(0.2), in: Capsule())
    }

    // MARK: Cards

    private var describeCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("What was this for?")
                .font(.headline)
            DescribeField(
                initial: transaction.subCategory,
                prompt: "bike fuel, office lunch, refund against books"
            ) { text in
                let before = transaction
                withAnimation(.snappy) { transaction.subCategory = text }
                do {
                    let result = try await store.describe(transaction.id, text)
                    withAnimation(.snappy) {
                        transaction.category = result.category
                        transaction.bucketId = result.bucketId
                        transaction.aiConfidence = result.aiConfidence
                        transaction.taggedBy = "ai"
                    }
                    return nil
                } catch {
                    withAnimation(.snappy) { transaction = before }
                    return error.localizedDescription
                }
            }
            Text("Gemini reads this and picks the category and bucket.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .card()
    }

    private var filingCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Filed as")
                    .font(.headline)
                Spacer()
                if transaction.isUnsure {
                    ConfidenceBadge(confidence: transaction.aiConfidence)
                }
            }
            HStack(spacing: 8) {
                CategoryMenu(selected: transaction.category) { pick in
                    Task {
                        await apply({ t in
                            t.category = pick
                            if !store.mayHoldBucket(pick) { t.bucketId = nil }
                        }) { try await store.setCategory(transaction.id, pick) }
                    }
                }
            }
            HStack(spacing: 8) {
                Text(transaction.isCredit ? "Goes into" : "Paid from")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                ParkingMenu(
                    selected: transaction.bucketId,
                    isCredit: transaction.isCredit,
                    enabled: store.mayHoldBucket(transaction.category)
                ) { pick in
                    Task { await apply({ $0.bucketId = pick }) { try await store.setBucket(transaction.id, pick) } }
                }
            }
            Text(filedBy)
                .font(.caption)
                .foregroundStyle(.secondary)
            if let error {
                Text(error).font(.caption).foregroundStyle(.red)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .card()
        .animation(.snappy, value: error)
    }

    private var filedBy: String {
        switch transaction.taggedBy {
        case "user": "Your decision. The tagger leaves it alone."
        case "ai":
            "Gemini, \(Format.percent(transaction.aiConfidence ?? 0)) sure."
        case "history": "From how you filed this merchant before."
        case "rule": "From a saved merchant rule."
        case "note": "From a description you filed the same way before."
        default: "Picking a category or bucket here saves it as your decision."
        }
    }

    private var detailsCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            row("Date", transaction.date.map { $0.formatted(date: .long, time: .omitted) } ?? "Unknown")
            Divider().padding(.leading, 16)
            row("Account", [transaction.source?.replacingOccurrences(of: "_", with: " ").capitalized, transaction.accountLast4.map { "••\($0)" }]
                .compactMap { $0 }.joined(separator: " "))
            Divider().padding(.leading, 16)
            row("Direction", transaction.isCredit ? "Money in" : "Money out")
        }
        .background(
            Color(.secondarySystemGroupedBackground),
            in: RoundedRectangle(cornerRadius: 20, style: .continuous)
        )
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value.isEmpty ? "—" : value).multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
        .padding(16)
    }

    private func smsCard(_ body: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Original SMS", systemImage: "message")
                .font(.headline)
            Text(body)
                .font(.footnote.monospaced())
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
        .card()
    }

    /// Shows a hand edit at once as the user's decision, then saves it; puts
    /// the row back if the server refuses.
    private func apply(_ edit: (inout Transaction) -> Void, _ request: () async throws -> Transaction) async {
        let before = transaction
        withAnimation(.snappy) {
            edit(&transaction)
            transaction.taggedBy = "user"
            transaction.aiConfidence = 1
            error = nil
        }
        do {
            let row = try await request()
            withAnimation(.snappy) {
                transaction.category = row.category
                transaction.bucketId = row.bucketId
                transaction.aiConfidence = row.aiConfidence
                transaction.taggedBy = row.taggedBy
            }
        } catch {
            withAnimation(.snappy) {
                transaction = before
                self.error = error.localizedDescription
            }
        }
    }
}
