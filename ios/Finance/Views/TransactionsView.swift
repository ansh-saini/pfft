import SwiftUI

/// A cycle's transactions by day, or a search across every cycle.
struct TransactionsView: View {
    @Environment(AppStore.self) private var store
    @State private var cycleId: String?
    @State private var list: TransactionList?
    @State private var error: String?
    @State private var search = ""
    @State private var selected: Transaction?
    @Namespace private var zoom

    init() {
        _list = State(initialValue: ResponseCache.shared.value("transactions"))
    }

    var body: some View {
        NavigationStack {
            List {
                if let list {
                    ForEach(days(list.transactions), id: \.title) { day in
                        Section {
                            ForEach(day.rows) { row in
                                Button {
                                    selected = row
                                } label: {
                                    TransactionRow(transaction: row, showsDate: false)
                                }
                                .buttonStyle(.plain)
                                .matchedTransitionSource(id: row.id, in: zoom)
                            }
                        } header: {
                            HStack {
                                Text(day.title)
                                Spacer()
                                Text(Format.inr(day.spent))
                                    .monospacedDigit()
                            }
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)
                            .textCase(nil)
                        }
                    }
                } else if let error {
                    ErrorCard(message: error) { Task { await load() } }
                        .listRowBackground(Color.clear)
                }
            }
            .listStyle(.insetGrouped)
            .overlay {
                if list == nil && error == nil {
                    ProgressView()
                } else if let list, list.transactions.isEmpty {
                    ContentUnavailableView(
                        search.isEmpty ? "No Transactions" : "No Matches",
                        systemImage: "tray",
                        description: Text(search.isEmpty ? "Nothing in this cycle yet." : "Try another word.")
                    )
                }
            }
            .searchable(text: $search, prompt: "Merchant, what for, category")
            .navigationTitle(search.isEmpty ? (list?.cycle?.label ?? "Transactions") : "Search")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    CycleMenu(cycleId: $cycleId)
                }
            }
            .refreshable { await load() }
            .task(id: "\(cycleId ?? "")-\(search)-\(store.revision)") {
                // Let typing settle before searching.
                if !search.isEmpty { try? await Task.sleep(for: .milliseconds(350)) }
                guard !Task.isCancelled else { return }
                await load()
            }
            .fullScreenCover(item: $selected) { transaction in
                TransactionDetailView(transaction: transaction)
                    .navigationTransition(.zoom(sourceID: transaction.id, in: zoom))
            }
        }
    }

    private func load() async {
        do {
            let term = search.trimmingCharacters(in: .whitespaces)
            if term.isEmpty {
                let query = ["cycle": cycleId]
                if let cached: TransactionList = store.api.cached("transactions", query: query) {
                    withAnimation(.smooth) { list = cached }
                }
                let fresh: TransactionList = try await store.api.get("transactions", query: query)
                withAnimation(.smooth) { list = fresh }
            } else {
                // Searches are not kept: each is typed once.
                let found: TransactionList = try await store.api.get("transactions", query: ["q": term], cache: false)
                withAnimation(.smooth) { list = found }
            }
            error = nil
        } catch {
            if list == nil { withAnimation { self.error = error.localizedDescription } }
        }
    }

    private struct Day {
        let title: String
        let rows: [Transaction]
        /// Money out that day, before refunds; a quick sense of the day. Self
        /// transfers move money between the user's own accounts and are left out.
        var spent: Double {
            rows.filter { !$0.isCredit && !$0.isSelfTransfer }.reduce(0) { $0 + $1.value }
        }
    }

    private func days(_ rows: [Transaction]) -> [Day] {
        var order: [String] = []
        var grouped: [String: [Transaction]] = [:]
        for row in rows {
            let title = Format.dayTitle(row.date)
            if grouped[title] == nil { order.append(title) }
            grouped[title, default: []].append(row)
        }
        return order.map { Day(title: $0, rows: grouped[$0] ?? []) }
    }
}
