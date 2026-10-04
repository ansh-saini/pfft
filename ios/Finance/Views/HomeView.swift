import SwiftUI

/// The dashboard for one cycle: what came in, what went out, where it went.
struct HomeView: View {
    @Environment(AppStore.self) private var store
    @State private var cycleId: String?
    @State private var summary: Summary?
    @State private var balances: AccountBalances?
    @State private var parkings: ParkingsOverview?
    @State private var parking = false
    @State private var error: String?
    @State private var selected: Transaction?
    @State private var testingTagger = false
    @Namespace private var zoom

    init() {
        _summary = State(initialValue: ResponseCache.shared.value(ResponseCache.key("summary", query: [:])))
        _balances = State(initialValue: ResponseCache.shared.value("balance"))
        _parkings = State(initialValue: ResponseCache.shared.value("parkings"))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    if let summary {
                        if summary.inboxCount > 0 {
                            inboxBanner(summary.inboxCount)
                                .transition(.move(edge: .top).combined(with: .opacity))
                        }
                        if let offer = parkOffer(summary) {
                            ParkOfferCard(offer: offer, busy: parking) {
                                Task { await park(offer) }
                            } dismiss: {
                                withAnimation(.snappy) { dismissOffer(summary) }
                            }
                            .transition(.move(edge: .top).combined(with: .opacity))
                        }
                        spendCard(summary)
                        if let balances, balances.total != nil {
                            BankBalanceCard(balances: balances, float: parkings?.float.balance)
                                .transition(.move(edge: .top).combined(with: .opacity))
                        }
                        statsGrid(summary)
                        categoryCard(summary)
                        recentCard(summary)
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
            .navigationTitle(summary?.cycle.label ?? "Home")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    CycleMenu(cycleId: $cycleId)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if let email = store.api.session?.email {
                            Text(email)
                        }
                        Button("Test Tagger", systemImage: "testtube.2") { testingTagger = true }
                        Button("Sign Out", role: .destructive) { store.api.signOut() }
                    } label: {
                        Image(systemName: "person.crop.circle")
                    }
                }
            }
            .refreshable { await load() }
            .task(id: "\(cycleId ?? "")-\(store.revision)") { await load() }
            .sheet(isPresented: $testingTagger) { TaggerTestView() }
            .fullScreenCover(item: $selected) { transaction in
                TransactionDetailView(transaction: transaction)
                    .navigationTransition(.zoom(sourceID: transaction.id, in: zoom))
            }
        }
    }

    // MARK: Salary day

    @State private var dismissedOffers: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "parkOfferDismissed") ?? [])

    /// Last month's moves out of Float, offered once salary has landed on the
    /// current cycle and nothing has been parked yet this month.
    private func parkOffer(_ s: Summary) -> [(Parking, Double)]? {
        guard s.salary != nil, cycleId == nil || cycleId == store.meta?.currentCycleId,
              let parkings, !parkings.suggestion.parkedThisMonth,
              !dismissedOffers.contains(s.cycle.id) else { return nil }
        let moves = parkings.suggestion.moves.compactMap { move in
            parkings.parkings.first { $0.id == move.parkingId }.map { ($0, move.amount) }
        }
        return moves.isEmpty ? nil : moves
    }

    private func dismissOffer(_ s: Summary) {
        dismissedOffers.insert(s.cycle.id)
        UserDefaults.standard.set(Array(dismissedOffers), forKey: "parkOfferDismissed")
    }

    private func park(_ offer: [(Parking, Double)]) async {
        parking = true
        defer { parking = false }
        for (target, amount) in offer {
            try? await store.move(from: nil, to: target.id, amount: amount)
        }
    }

    private func load() async {
        let query = ["cycle": cycleId]
        // Open on the last reply for this cycle; the fetch updates it in place.
        if let cached: Summary = store.api.cached("summary", query: query) {
            withAnimation(.smooth) { summary = cached }
        }
        do {
            // Both at once; the balance is extra, so its failure is not the page's.
            let balanceFetch = Task { () -> AccountBalances? in try? await store.api.get("balance") }
            let parkingsFetch = Task { () -> ParkingsOverview? in try? await store.api.get("parkings") }
            let fresh: Summary = try await store.api.get("summary", query: query)
            let bank = await balanceFetch.value
            let parked = await parkingsFetch.value
            withAnimation(.smooth) {
                summary = fresh
                if let bank { balances = bank }
                if let parked { parkings = parked }
            }
            store.inboxCount = summary?.inboxCount ?? store.inboxCount
            error = nil
        } catch {
            if summary == nil { withAnimation { self.error = error.localizedDescription } }
        }
    }

    // MARK: Cards

    private func inboxBanner(_ count: Int) -> some View {
        Button {
            store.selectedTab = .inbox
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "tray.full.fill")
                    .font(.title3)
                    .foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(count) \(count == 1 ? "needs" : "need") you")
                        .font(.headline)
                    Text("Say what \(count == 1 ? "it was" : "they were") for and they get filed.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .card()
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(Color.orange.opacity(0.35), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private func spendCard(_ s: Summary) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Spent this cycle")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text(Format.inr(s.spend))
                .font(.system(size: 44, weight: .bold))
                .monospacedDigit()
                .contentTransition(.numericText())
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            if let fromParkings = s.fromParkings, fromParkings > 0 {
                Text("\(Format.inr(fromParkings)) of it paid from parkings")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text("Refunds already taken off")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .card()
        .accessibilityElement(children: .combine)
    }

    private func statsGrid(_ s: Summary) -> some View {
        Grid(horizontalSpacing: 12, verticalSpacing: 12) {
            GridRow {
                stat("Income", s.income, "arrow.down.left", .green)
                stat("Invested", s.investments, "chart.pie.fill", .blue)
            }
            GridRow {
                // Leftover means nothing before the month's income is in.
                if awaitingSalary(s) {
                    AwaitingSalaryCard()
                        .gridCellColumns(2)
                        .transition(.blurReplace)
                } else {
                    stat("Leftover", s.leftover, "wallet.bifold.fill", s.leftover >= 0 ? .green : .red)
                        .gridCellColumns(2)
                        .transition(.blurReplace)
                }
            }
        }
    }

    /// Only the current cycle waits; a past cycle without salary is history.
    private func awaitingSalary(_ s: Summary) -> Bool {
        guard s.salary == nil else { return false }
        return cycleId == nil || cycleId == store.meta?.currentCycleId
    }

    private func stat(_ title: String, _ value: Double, _ symbol: String, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: symbol)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(tint)
            Text(Format.inr(value))
                .font(.title2.weight(.semibold))
                .monospacedDigit()
                .contentTransition(.numericText(value: value))
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .card()
        .accessibilityElement(children: .combine)
    }

    private func categoryCard(_ s: Summary) -> some View {
        let total = max(s.categories.reduce(0) { $0 + $1.amount }, 1)
        return VStack(alignment: .leading, spacing: 14) {
            Text("Where it went")
                .font(.headline)
            if s.categories.isEmpty {
                Text("No spending this cycle yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(s.categories.prefix(6)) { slice in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 10) {
                            Image(systemName: CategoryStyle.symbol(slice.category))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(CategoryStyle.color(slice.category))
                                .frame(width: 20)
                            Text(slice.category)
                                .font(.subheadline)
                            Spacer()
                            Text(Format.inr(slice.amount))
                                .font(.subheadline.weight(.medium))
                                .monospacedDigit()
                        }
                        ProgressView(value: slice.amount / total)
                            .tint(CategoryStyle.color(slice.category))
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .card()
    }

    private func recentCard(_ s: Summary) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Recent")
                    .font(.headline)
                Spacer()
                Button("See All") { store.selectedTab = .transactions }
                    .font(.subheadline)
            }
            if s.recent.isEmpty {
                Text("No transactions yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(s.recent) { transaction in
                    Button {
                        selected = transaction
                    } label: {
                        TransactionRow(transaction: transaction)
                    }
                    .buttonStyle(.plain)
                    .matchedTransitionSource(id: transaction.id, in: zoom)
                    if transaction.id != s.recent.last?.id {
                        Divider().padding(.leading, 52)
                    }
                }
            }
        }
        .card()
    }
}
