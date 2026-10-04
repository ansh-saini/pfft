import SwiftUI

// MARK: - Card

private struct CardBackground: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                Color(.secondarySystemGroupedBackground),
                in: RoundedRectangle(cornerRadius: 20, style: .continuous)
            )
    }
}

extension View {
    /// A rounded card on the grouped background.
    func card() -> some View { modifier(CardBackground()) }
}

// MARK: - Category icon

struct CategoryIcon: View {
    let category: String?
    var size: CGFloat = 40

    var body: some View {
        let tint = CategoryStyle.color(category)
        Image(systemName: CategoryStyle.symbol(category))
            .font(.system(size: size * 0.42, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(tint.opacity(0.15), in: Circle())
            .accessibilityHidden(true)
    }
}

// MARK: - Transaction row

struct TransactionRow: View {
    @Environment(AppStore.self) private var store
    let transaction: Transaction
    /// Off where rows sit under a day heading that already says the date.
    var showsDate = true

    var body: some View {
        HStack(spacing: 12) {
            CategoryIcon(category: transaction.category)
            VStack(alignment: .leading, spacing: 3) {
                Text(transaction.merchant ?? "Unknown")
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 3) {
                Text(Format.signed(transaction))
                    .font(.body.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(transaction.isCredit ? .green : .primary)
                if transaction.isUnsure {
                    ConfidenceBadge(confidence: transaction.aiConfidence)
                } else if let bucket = store.bucketName(transaction.bucketId) {
                    Text(bucket)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
        .opacity(transaction.isSelfTransfer ? 0.45 : 1)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var subtitle: String {
        let what = transaction.subCategory ?? transaction.category ?? "Untagged"
        return showsDate ? "\(what) · \(Format.shortDay(transaction.date))" : what
    }
}

/// "40% sure", in amber: the tagger wants the user.
struct ConfidenceBadge: View {
    let confidence: Double?

    var body: some View {
        if let confidence {
            Text("\(Format.percent(confidence)) sure")
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.orange.opacity(0.15), in: Capsule())
                .foregroundStyle(.orange)
        }
    }
}

// MARK: - What for

/// The description field: the user says what a transaction was for, Gemini
/// reads it and files the category and bucket. The same path as the web's
/// "What for" input. The caller sends it and returns an error message, or nil
/// on success, so each screen can update optimistically in its own way.
struct DescribeField: View {
    let initial: String?
    var prompt: String = "What was this for? e.g. bike fuel"
    let onSend: (String) async -> String?

    @State private var text = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                TextField(prompt, text: $text)
                    .focused($focused)
                    .submitLabel(.send)
                    .onSubmit(send)
                    .disabled(busy)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                Button(action: send) {
                    ZStack {
                        if busy {
                            ProgressView().tint(.white)
                                .transition(.scale.combined(with: .opacity))
                        } else {
                            Image(systemName: "sparkles")
                                .font(.body.weight(.semibold))
                                .transition(.scale.combined(with: .opacity))
                        }
                    }
                    .frame(width: 40, height: 40)
                    .background(Color.accentColor.opacity(canSend || busy ? 1 : 0.3), in: Circle())
                    .foregroundStyle(.white)
                }
                .disabled(!canSend)
                .accessibilityLabel("File it")
            }
            if let error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.snappy, value: busy)
        .animation(.snappy, value: error)
        .onAppear { text = initial ?? "" }
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSend: Bool { !busy && !trimmed.isEmpty && trimmed != (initial ?? "") }

    private func send() {
        guard canSend else { return }
        let description = trimmed
        busy = true
        error = nil
        focused = false
        Task {
            error = await onSend(description)
            busy = false
        }
    }
}

// MARK: - Pickers

/// A menu of categories. Choosing one is a hand decision.
struct CategoryMenu: View {
    @Environment(AppStore.self) private var store
    let selected: String?
    let onPick: (String) -> Void

    var body: some View {
        Menu {
            ForEach(store.categories) { category in
                Button {
                    onPick(category.name)
                } label: {
                    Label(category.name, systemImage: CategoryStyle.symbol(category.name))
                }
            }
        } label: {
            PickerChip(
                title: selected ?? "Category",
                symbol: CategoryStyle.symbol(selected),
                tint: CategoryStyle.color(selected),
                placeholder: selected == nil
            )
        }
    }
}

/// Where a transaction's money came from or went: Float, or a parking.
/// Filing a spend to a parking drains it (to zero, the rest falls on Float);
/// filing money in raises it.
struct ParkingMenu: View {
    @Environment(AppStore.self) private var store
    let selected: String?
    let isCredit: Bool
    let enabled: Bool
    let onPick: (String?) -> Void

    var body: some View {
        Menu {
            Button {
                onPick(nil)
            } label: {
                if selected == nil { Label("Float", systemImage: "checkmark") } else { Text("Float") }
            }
            ForEach(store.buckets) { parking in
                Button {
                    onPick(parking.id)
                } label: {
                    if parking.id == selected { Label(parking.name, systemImage: "checkmark") } else { Text(parking.name) }
                }
            }
        } label: {
            PickerChip(
                title: enabled ? (store.bucketName(selected) ?? "Float") : "Not spending",
                symbol: "parkingsign.circle",
                tint: selected == nil ? .teal : .accentColor,
                placeholder: false
            )
        }
        .disabled(!enabled)
        .accessibilityLabel(isCredit ? "Goes into" : "Paid from")
    }
}

struct PickerChip: View {
    let title: String
    let symbol: String
    let tint: Color
    let placeholder: Bool

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.caption.weight(.semibold))
                .foregroundStyle(placeholder ? .secondary : tint)
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(placeholder ? .secondary : .primary)
                .lineLimit(1)
            Image(systemName: "chevron.up.chevron.down")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(.tertiarySystemFill), in: Capsule())
    }
}

// MARK: - States

struct ErrorCard: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "wifi.exclamationmark")
                .font(.title2)
                .foregroundStyle(.secondary)
            Text(message)
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Button("Try Again", action: retry)
                .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity)
        .card()
    }
}

/// Picks a cycle; the list comes from the server.
struct CycleMenu: View {
    @Environment(AppStore.self) private var store
    @Binding var cycleId: String?

    var body: some View {
        Menu {
            ForEach((store.meta?.cycles ?? []).reversed()) { cycle in
                Button {
                    cycleId = cycle.id
                } label: {
                    if cycle.id == currentId {
                        Label(cycle.label, systemImage: "checkmark")
                    } else {
                        Text(cycle.label)
                    }
                }
            }
        } label: {
            Image(systemName: "calendar")
        }
        .accessibilityLabel("Cycle")
    }

    private var currentId: String? { cycleId ?? store.meta?.currentCycleId }
}

// MARK: - Awaiting salary

/// Stands in for Leftover until the month's salary lands. Every few seconds
/// a soft light passes across the card and the rupee coin gives a small
/// bounce; between passes nothing moves, so the screen goes fully idle
/// instead of redrawing every frame. Still under Reduce Motion.
struct AwaitingSalaryCard: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @State private var sweep = false
    @State private var pass = 0

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: "indianrupeesign.circle.fill")
                .font(.system(size: 30))
                .foregroundStyle(.white, .green.gradient)
                .symbolEffect(.bounce, value: pass)
            VStack(alignment: .leading, spacing: 3) {
                Text("Awaiting salary")
                    .font(.headline)
                Text("Leftover shows once it lands.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .card()
        .overlay {
            GeometryReader { geo in
                LinearGradient(
                    colors: [.clear, .white.opacity(colorScheme == .dark ? 0.08 : 0.55), .clear],
                    startPoint: .leading,
                    endPoint: .trailing
                )
                .frame(width: geo.size.width * 0.4)
                .rotationEffect(.degrees(12))
                .offset(x: sweep ? geo.size.width * 1.1 : -geo.size.width * 0.5)
            }
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .allowsHitTesting(false)
        }
        .task {
            guard !reduceMotion else { return }
            // One pass, then a long rest; cancelled when the card leaves.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1.2))
                guard !Task.isCancelled else { return }
                pass += 1
                withAnimation(.easeInOut(duration: 1.4)) { sweep = true }
                try? await Task.sleep(for: .seconds(1.5))
                var reset = SwiftUI.Transaction()
                reset.disablesAnimations = true
                withTransaction(reset) { sweep = false }
                try? await Task.sleep(for: .seconds(5))
            }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Bank balance

/// The bank balance as the app keeps it: each account's last reading plus
/// everything recorded since. The footer says how the last comparison with a
/// real bank reading went, which is what a reconciliation adds.
/// Shows or hides every bank balance on screen at once.
struct BalanceEye: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        @Bindable var store = store
        Button {
            withAnimation(.snappy) { store.balancesHidden.toggle() }
        } label: {
            Image(systemName: store.balancesHidden ? "eye.slash" : "eye")
                .contentTransition(.symbolEffect(.replace))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(width: 32, height: 32)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(store.balancesHidden ? "Show balances" : "Hide balances")
    }
}

struct BankBalanceCard: View {
    @Environment(AppStore.self) private var store
    let balances: AccountBalances
    /// The part not parked anywhere; nil until known.
    var float: Double? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("In the bank", systemImage: "building.columns.fill")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.teal)
                Spacer()
                BalanceEye()
            }
            Text(Format.inr(balances.total ?? 0, hidden: store.balancesHidden))
                .font(.system(size: 34, weight: .bold))
                .monospacedDigit()
                .contentTransition(.numericText(value: balances.total ?? 0))
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            HStack(spacing: 16) {
                ForEach(balances.accounts) { account in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(account.name)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(Format.inr(account.balance ?? 0, hidden: store.balancesHidden))
                            .font(.subheadline.weight(.semibold))
                            .monospacedDigit()
                            .contentTransition(.numericText(value: account.balance ?? 0))
                    }
                }
            }
            if let float {
                HStack {
                    Label("Float", systemImage: "water.waves")
                        .foregroundStyle(float < 0 ? .red : .teal)
                    Spacer()
                    Text(Format.inr(float, hidden: store.balancesHidden))
                        .monospacedDigit()
                        .foregroundStyle(float < 0 ? .red : .primary)
                        .contentTransition(.numericText(value: float))
                }
                .font(.subheadline.weight(.semibold))
                .padding(.top, 2)
            }
            if let check = balances.lastCheck {
                Label(checkLine(check), systemImage: abs(check.drift) < 1 ? "checkmark.seal.fill" : "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(abs(check.drift) < 1 ? .green : .orange)
            }
            if let since = sinceLine {
                Text(since)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .card()
        .accessibilityElement(children: .combine)
    }

    private func checkLine(_ check: AccountBalances.Check) -> String {
        let day = Format.shortDay(Format.parseDay(String(check.at.prefix(10))))
        return abs(check.drift) < 1
            ? "Matched the bank on \(day)"
            : "Off by \(Format.inr(abs(check.drift))) on \(day)"
    }

    /// How long the figure has run on its own since the oldest last reading.
    private var sinceLine: String? {
        let anchors = balances.accounts.compactMap(\.anchor)
        guard let oldest = anchors.min(by: { $0.at < $1.at }) else { return nil }
        let day = Format.shortDay(Format.parseDay(String(oldest.at.prefix(10))))
        let moved = balances.accounts.reduce(0) { $0 + $1.movedSince }
        return "Worked out from \(moved) transactions since \(day). Reconcile to check it."
    }
}

// MARK: - Salary day

/// Salary has landed: offers to park it the way last month was parked.
struct ParkOfferCard: View {
    let offer: [(Parking, Double)]
    let busy: Bool
    let park: () -> Void
    let dismiss: () -> Void

    private var total: Double { offer.reduce(0) { $0 + $1.1 } }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Salary landed. Park it like last month?", systemImage: "parkingsign.circle.fill")
                .font(.headline)
                .foregroundStyle(.teal)
            ForEach(offer, id: \.0.id) { parking, amount in
                HStack {
                    Text(parking.name)
                    Spacer()
                    Text(Format.inr(amount)).monospacedDigit()
                }
                .font(.subheadline)
            }
            HStack {
                Button(action: park) {
                    Text(busy ? "Parking…" : "Park \(Format.inr(total))").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy)
                Button("Not Now", action: dismiss)
                    .buttonStyle(.bordered)
            }
        }
        .card()
    }
}
