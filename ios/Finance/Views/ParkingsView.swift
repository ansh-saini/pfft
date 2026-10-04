import SwiftUI

/// Float and the parkings. Float is the bank balance not parked anywhere;
/// spending comes out of it and salary lands in it. Parkings are money set
/// aside for something, with all-time balances.
struct ParkingsView: View {
    @Environment(AppStore.self) private var store
    @State private var overview: ParkingsOverview?
    @State private var error: String?
    @State private var creating = false
    @State private var moving: MoveDraft?

    init() {
        _overview = State(initialValue: ResponseCache.shared.value("parkings"))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let overview {
                        FloatCard(float: overview.float) { moving = MoveDraft(from: nil, to: nil) } cover: {
                            moving = MoveDraft(from: overview.parkings.first { $0.balance > 0 }?.id, to: nil)
                        }
                        .transition(.opacity)
                        if overview.parkings.isEmpty {
                            ContentUnavailableView {
                                Label("Nothing Parked", systemImage: "parkingsign.circle")
                            } description: {
                                Text("Park money for an emergency fund, a trip or Diwali gifting. Everything else stays in Float.")
                            } actions: {
                                Button("New Parking") { creating = true }
                            }
                            .transition(.opacity)
                        } else {
                            Text("Parked")
                                .font(.headline)
                                .padding(.horizontal, 4)
                            ForEach(overview.parkings) { parking in
                                NavigationLink(value: parking) {
                                    ParkingCard(parking: parking)
                                }
                                .buttonStyle(.plain)
                                .transition(.scale(scale: 0.95).combined(with: .opacity))
                            }
                        }
                    } else if let error {
                        ErrorCard(message: error) { Task { await load() } }
                    } else {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 80)
                    }
                }
                .padding(.horizontal)
                .padding(.bottom, 24)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Parkings")
            .navigationDestination(for: Parking.self) { parking in
                ParkingDetailView(parking: parking)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { creating = true } label: { Image(systemName: "plus") }
                        .accessibilityLabel("New Parking")
                }
            }
            .sheet(isPresented: $creating) { ParkingEditSheet(parking: nil) }
            .sheet(item: $moving) { draft in
                MoveSheet(draft: draft, parkings: overview?.parkings ?? [], float: overview?.float.balance)
            }
            .refreshable { await load() }
            .task(id: store.revision) { await load() }
        }
    }

    private func load() async {
        do {
            let fresh: ParkingsOverview = try await store.api.get("parkings")
            withAnimation(.smooth) {
                overview = fresh
                error = nil
            }
        } catch {
            if overview == nil { withAnimation { self.error = error.localizedDescription } }
        }
    }
}

// MARK: - Float

struct FloatCard: View {
    @Environment(AppStore.self) private var store
    let float: FloatInfo
    let move: () -> Void
    let cover: () -> Void

    private var negative: Bool { (float.balance ?? 0) < 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Float", systemImage: "water.waves")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(negative ? .red : .teal)
                Spacer()
                BalanceEye()
                Button("Park", action: move)
                    .font(.subheadline.weight(.semibold))
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
            }
            if let balance = float.balance {
                Text(Format.inr(balance, hidden: store.balancesHidden))
                    .font(.system(size: 38, weight: .bold))
                    .monospacedDigit()
                    .foregroundStyle(negative ? .red : .primary)
                    .contentTransition(.numericText(value: balance))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
            } else {
                Text("Needs a balance reading for every account")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 14) {
                Label("+" + Format.inr(float.monthIn), systemImage: "arrow.down.left")
                    .foregroundStyle(.green)
                Label("−" + Format.inr(float.monthOut), systemImage: "arrow.up.right")
                    .foregroundStyle(.secondary)
                Text("this month").foregroundStyle(.tertiary)
            }
            .font(.caption.weight(.medium))
            .monospacedDigit()
            if float.cardSinceBill > 0 {
                Label("\(Format.inr(float.cardSinceBill)) on cards since the last bill, still to come out", systemImage: "creditcard")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if negative {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Your parkings hold more than the bank does. Move some back to Float.")
                        .font(.caption)
                        .foregroundStyle(.red)
                    Button("Cover from a Parking…", action: cover)
                        .font(.subheadline.weight(.semibold))
                        .tint(.red)
                }
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .card()
        .animation(.smooth, value: negative)
    }
}

// MARK: - A parking

struct ParkingCard: View {
    let parking: Parking

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(parking.name)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                Text(Format.inr(parking.balance))
                    .font(.headline)
                    .monospacedDigit()
                    .contentTransition(.numericText(value: parking.balance))
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            if let progress = parking.progress, let goal = parking.goal {
                ProgressView(value: progress)
                    .tint(parking.goalReached ? .green : .accentColor)
                Text(parking.goalReached ? "Goal reached" : "of \(Format.inr(goal))")
                    .font(.caption)
                    .foregroundStyle(parking.goalReached ? .green : .secondary)
            }
        }
        .card()
        .accessibilityElement(children: .combine)
    }
}

struct ParkingDetailView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let parking: Parking
    @State private var detail: ParkingDetail?
    @State private var parkings: [Parking] = []
    @State private var float: Double?
    @State private var moving: MoveDraft?
    @State private var editing = false
    @State private var confirmDelete = false
    @State private var error: String?
    @State private var selected: Transaction?

    init(parking: Parking) {
        self.parking = parking
        _detail = State(initialValue: ResponseCache.shared.value("parkings/\(parking.id)"))
    }

    private var current: Parking { detail?.parking ?? parking }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(Format.inr(current.balance))
                        .font(.system(size: 40, weight: .bold))
                        .monospacedDigit()
                        .contentTransition(.numericText(value: current.balance))
                    if let progress = current.progress, let goal = current.goal {
                        ProgressView(value: progress).tint(current.goalReached ? .green : .accentColor)
                        Text(current.goalReached ? "Goal of \(Format.inr(goal)) reached" : "\(Format.inr(max(goal - current.balance, 0))) to go of \(Format.inr(goal))")
                            .font(.caption)
                            .foregroundStyle(current.goalReached ? .green : .secondary)
                    }
                    HStack(spacing: 10) {
                        Button { moving = MoveDraft(from: nil, to: parking.id) } label: {
                            Label("Move In", systemImage: "arrow.down.to.line").frame(maxWidth: .infinity)
                        }
                        Button { moving = MoveDraft(from: parking.id, to: nil) } label: {
                            Label("Move Out", systemImage: "arrow.up.to.line").frame(maxWidth: .infinity)
                        }
                        .disabled(current.balance <= 0)
                    }
                    .buttonStyle(.bordered)
                    .padding(.top, 4)
                }
                .padding(.vertical, 4)
            }
            if let error {
                Section { Text(error).foregroundStyle(.red) }
            }
            if let detail {
                Section("Moves") {
                    if detail.moves.isEmpty {
                        Text("Nothing moved yet.").foregroundStyle(.secondary)
                    }
                    ForEach(detail.moves) { move in
                        MoveRow(move: move)
                            .swipeActions {
                                if move.kind == "funding" || move.kind == "transfer" {
                                    Button("Undo", role: .destructive) { Task { await undo(move) } }
                                }
                            }
                    }
                }
                if !detail.transactions.isEmpty {
                    Section("Paid from or into here") {
                        ForEach(detail.transactions) { row in
                            Button { selected = row } label: { TransactionRow(transaction: row) }
                                .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
        .navigationTitle(current.name)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Rename or Set Goal", systemImage: "pencil") { editing = true }
                    Button("Delete Parking", systemImage: "trash", role: .destructive) { confirmDelete = true }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
        .confirmationDialog("Delete \(current.name)?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await delete() } }
        } message: {
            Text("Its \(Format.inr(current.balance)) goes back to Float, and anything filed here is unfiled.")
        }
        .sheet(isPresented: $editing) { ParkingEditSheet(parking: current) }
        .sheet(item: $moving) { draft in MoveSheet(draft: draft, parkings: parkings, float: float) }
        .fullScreenCover(item: $selected) { TransactionDetailView(transaction: $0) }
        .refreshable { await load() }
        .task(id: store.revision) { await load() }
        .animation(.smooth, value: detail?.moves)
    }

    private func load() async {
        if let fresh: ParkingDetail = try? await store.api.get("parkings/\(parking.id)") {
            withAnimation(.smooth) { detail = fresh }
        }
        if let overview: ParkingsOverview = try? await store.api.get("parkings") {
            parkings = overview.parkings
            float = overview.float.balance
        }
    }

    private func undo(_ move: ParkingMove) async {
        do {
            try await store.undoMove(move.id)
            withAnimation { error = nil }
        } catch {
            withAnimation { self.error = error.localizedDescription }
        }
    }

    private func delete() async {
        do {
            try await store.deleteParking(parking.id)
            dismiss()
        } catch {
            withAnimation { self.error = error.localizedDescription }
        }
    }
}

private struct MoveRow: View {
    let move: ParkingMove

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline)
                Text(Format.shortDay(move.occurredOn.flatMap(Format.parseDay)))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Text((move.amount >= 0 ? "+" : "−") + Format.inr(abs(move.amount)))
                .monospacedDigit()
                .foregroundStyle(move.amount >= 0 ? .green : .primary)
        }
    }

    private var title: String {
        guard let other = move.counterpart else { return move.note ?? "Adjustment" }
        return move.amount >= 0 ? "From \(other)" : "To \(other)"
    }
}

// MARK: - Moving money

struct MoveDraft: Identifiable {
    let id = UUID()
    var from: String?
    var to: String?
}

/// Moves money between Float and a parking, or between two parkings. Nothing
/// can move more than its source holds.
struct MoveSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let parkings: [Parking]
    let float: Double?
    @State private var from: String?
    @State private var to: String?
    @State private var amount = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool

    init(draft: MoveDraft, parkings: [Parking], float: Double?) {
        self.parkings = parkings
        self.float = float
        _from = State(initialValue: draft.from)
        // Parking from Float with nothing picked: the first parking.
        _to = State(initialValue: draft.from == nil && draft.to == nil ? parkings.first?.id : draft.to)
    }

    private func name(_ id: String?) -> String { id.flatMap { id in parkings.first { $0.id == id }?.name } ?? "Float" }
    private func holds(_ id: String?) -> Double? { id == nil ? float : parkings.first { $0.id == id }?.balance }
    private var value: Double? { Double(amount.replacingOccurrences(of: ",", with: "")) }
    private var canMove: Bool {
        guard let value, value > 0, from != to else { return false }
        return value <= (holds(from) ?? 0) + 0.001
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    picker("From", selection: $from)
                    picker("To", selection: $to)
                } footer: {
                    if let available = holds(from) { Text("\(name(from)) holds \(Format.inrExact(available)).") }
                }
                Section {
                    TextField("Amount", text: $amount)
                        .keyboardType(.decimalPad)
                        .focused($focused)
                        .font(.title2.weight(.semibold))
                        .monospacedDigit()
                    if let available = holds(from), available > 0 {
                        Button("Move all \(Format.inrExact(available))") {
                            amount = String(format: "%.2f", available)
                        }
                        .font(.subheadline)
                    }
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Move Money")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Moving…" : "Move") { Task { await move() } }
                        .disabled(!canMove || busy)
                }
            }
            .onAppear { focused = true }
        }
        .presentationDetents([.medium, .large])
    }

    private func picker(_ title: String, selection: Binding<String?>) -> some View {
        Picker(title, selection: selection) {
            Text("Float").tag(String?.none)
            ForEach(parkings) { Text($0.name).tag(String?.some($0.id)) }
        }
    }

    private func move() async {
        guard let value else { return }
        busy = true
        defer { busy = false }
        do {
            try await store.move(from: from, to: to, amount: value)
            dismiss()
        } catch {
            withAnimation { self.error = error.localizedDescription }
        }
    }
}

// MARK: - Creating and editing

struct ParkingEditSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let parking: Parking?
    @State private var name = ""
    @State private var goal = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name, e.g. Anniversary Trip", text: $name)
                    TextField("Goal (optional)", text: $goal)
                        .keyboardType(.numberPad)
                } footer: {
                    Text("A goal adds a progress bar. Money stays parked past it.")
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle(parking == nil ? "New Parking" : "Edit Parking")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(parking == nil ? "Create" : "Save") { Task { await save() } }
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                }
            }
            .onAppear {
                name = parking?.name ?? ""
                goal = parking?.goal.map { String(Int($0)) } ?? ""
            }
        }
        .presentationDetents([.medium])
    }

    private func save() async {
        busy = true
        defer { busy = false }
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        let goalValue = Double(goal.replacingOccurrences(of: ",", with: ""))
        do {
            if let parking {
                try await store.updateParking(parking.id, name: trimmed, goal: goalValue)
            } else {
                _ = try await store.createParking(name: trimmed, goal: goalValue)
            }
            dismiss()
        } catch {
            withAnimation { self.error = error.localizedDescription }
        }
    }
}
