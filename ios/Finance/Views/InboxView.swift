import SwiftUI

/// Everything the tagger could not file on its own. Say what each was for and
/// Gemini files it, or pick the category and bucket by hand. Edits show at
/// once and a filed card slides away; if the server refuses, it comes back.
struct InboxView: View {
    @Environment(AppStore.self) private var store
    @State private var rows: [Transaction]?
    @State private var error: String?
    @State private var toast: String?
    /// Rows waiting on Gemini after the user described them.
    @State private var filing: Set<String> = []

    init() {
        _rows = State(initialValue: (ResponseCache.shared.value("inbox") as TransactionList?)?.transactions)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 12) {
                    if let rows {
                        if rows.isEmpty {
                            ContentUnavailableView(
                                "Inbox Zero",
                                systemImage: "checkmark.circle",
                                description: Text("Everything has a category and a bucket.")
                            )
                            .padding(.top, 60)
                            .transition(.scale(scale: 0.9).combined(with: .opacity))
                        } else {
                            Text("Say what each was for and it gets filed.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 4)
                                .transition(.opacity)
                            ForEach(rows) { row in
                                InboxCard(
                                    transaction: row,
                                    filing: filing.contains(row.id),
                                    onDescribe: { await describe(row, $0) },
                                    onCategory: { pick in Task { await pickCategory(row, pick) } }
                                )
                                .transition(.asymmetric(
                                    insertion: .scale(scale: 0.95).combined(with: .opacity),
                                    removal: .move(edge: .trailing).combined(with: .opacity)
                                ))
                            }
                        }
                    } else if let error {
                        ErrorCard(message: error) { Task { await load() } }
                            .transition(.opacity)
                    } else {
                        ProgressView().padding(.top, 80)
                    }
                }
                .padding(.horizontal)
                .padding(.bottom, 24)
            }
            .background(Color(.systemGroupedBackground))
            .scrollDismissesKeyboard(.interactively)
            .overlay(alignment: .top) {
                if let toast {
                    Label(toast, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(.red.gradient, in: Capsule())
                        .padding(.top, 8)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .navigationTitle("Inbox")
            .refreshable { await load() }
            .onAppear { Task { await load() } }
        }
    }

    private func load() async {
        do {
            let list: TransactionList = try await store.api.get("inbox")
            withAnimation(.smooth) {
                // A row still waiting on Gemini keeps its local state.
                rows = list.transactions.map { fresh in
                    filing.contains(fresh.id) ? (rows?.first { $0.id == fresh.id } ?? fresh) : fresh
                }
                error = nil
            }
            store.inboxCount = list.transactions.count
        } catch {
            if rows == nil { withAnimation { self.error = error.localizedDescription } }
        }
    }

    // MARK: Optimistic edits

    private func replace(_ row: Transaction) {
        guard let index = rows?.firstIndex(where: { $0.id == row.id }) else { return }
        withAnimation(.snappy) { rows?[index] = row }
    }

    /// Takes a filed row out of the list with the swipe-away transition.
    private func leave(_ row: Transaction) {
        withAnimation(.snappy(duration: 0.3)) { rows?.removeAll { $0.id == row.id } }
        store.inboxCount = max(0, store.inboxCount - 1)
    }

    /// Puts a row back where it was after the server refused an edit.
    private func restore(_ row: Transaction, at index: Int) {
        withAnimation(.snappy) {
            if rows?.contains(where: { $0.id == row.id }) == true {
                replace(row)
            } else {
                rows?.insert(row, at: min(index, rows?.count ?? 0))
                store.inboxCount += 1
            }
        }
    }

    private func showToast(_ message: String) {
        withAnimation(.snappy) { toast = message }
        Task {
            try? await Task.sleep(for: .seconds(3))
            withAnimation(.snappy) { if toast == message { toast = nil } }
        }
    }

    /// Applies a hand edit at once, leaves if that files the row, then asks
    /// the server; rolls back on failure.
    private func handEdit(_ row: Transaction, _ edit: (inout Transaction) -> Void,
                          _ request: () async throws -> Transaction) async {
        guard let index = rows?.firstIndex(where: { $0.id == row.id }) else { return }
        let before = rows![index]
        var after = before
        edit(&after)
        after.taggedBy = "user"
        after.aiConfidence = 1
        if store.leavesInbox(after) { leave(after) } else { replace(after) }
        do {
            let saved = try await request()
            var merged = after
            merged.category = saved.category
            merged.bucketId = saved.bucketId
            merged.aiConfidence = saved.aiConfidence
            merged.taggedBy = saved.taggedBy
            if rows?.contains(where: { $0.id == row.id }) == true {
                if store.leavesInbox(merged) { leave(merged) } else { replace(merged) }
            }
        } catch {
            restore(before, at: index)
            showToast(error.localizedDescription)
        }
    }

    private func pickCategory(_ row: Transaction, _ category: String) async {
        await handEdit(row, { t in
            t.category = category
            // A category that never takes a bucket clears it, as the server does.
            if !store.mayHoldBucket(category) { t.bucketId = nil }
        }) {
            try await store.setCategory(row.id, category)
        }
    }

    /// The description shows at once with "Filing…"; the card leaves if Gemini
    /// files it, or stays with Gemini's guess if it is not sure.
    private func describe(_ row: Transaction, _ text: String) async -> String? {
        guard let index = rows?.firstIndex(where: { $0.id == row.id }) else { return nil }
        let before = rows![index]
        var pending = before
        pending.subCategory = text
        replace(pending)
        withAnimation(.snappy) { _ = filing.insert(row.id) }
        defer { withAnimation(.snappy) { _ = filing.remove(row.id) } }
        do {
            let result = try await store.describe(row.id, text)
            var filed = pending
            filed.category = result.category
            filed.bucketId = result.bucketId
            filed.aiConfidence = result.aiConfidence
            filed.taggedBy = "ai"
            if store.leavesInbox(filed) { leave(filed) } else { replace(filed) }
            return nil
        } catch {
            replace(before)
            return error.localizedDescription
        }
    }
}

private struct InboxCard: View {
    @Environment(AppStore.self) private var store
    let transaction: Transaction
    let filing: Bool
    let onDescribe: (String) async -> String?
    let onCategory: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                CategoryIcon(category: transaction.category, size: 36)
                    .contentTransition(.symbolEffect(.replace))
                VStack(alignment: .leading, spacing: 2) {
                    Text(transaction.merchant ?? "Unknown")
                        .font(.headline)
                        .lineLimit(1)
                    Text(Format.dayTitle(transaction.date))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(Format.signed(transaction))
                    .font(.headline)
                    .monospacedDigit()
                    .foregroundStyle(transaction.isCredit ? .green : .primary)
            }

            DescribeField(initial: transaction.subCategory, onSend: onDescribe)

            CategoryMenu(selected: transaction.category, onPick: onCategory)

            status
        }
        .card()
        .opacity(filing ? 0.75 : 1)
        .animation(.snappy, value: transaction)
    }

    @ViewBuilder private var status: some View {
        Group {
            if filing {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("Filing…")
                }
                .foregroundStyle(.secondary)
            } else if let confidence = transaction.aiConfidence, transaction.isUnsure {
                HStack(spacing: 6) {
                    ConfidenceBadge(confidence: confidence)
                    Text(transaction.subCategory == nil ? "Not sure enough to file on its own" : "Still not sure. Pick the category or bucket.")
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("Not yet tagged").foregroundStyle(.secondary)
            }
        }
        .font(.caption)
        .transition(.opacity)
        .id(statusKey)
    }

    private var statusKey: String {
        filing ? "filing" : transaction.isUnsure ? "unsure" : "untagged"
    }
}
