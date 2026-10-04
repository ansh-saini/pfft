import SwiftUI

/// A bank statement shared into the app: pick the bank, reconcile it against
/// what the SMS feed recorded, and see what was added. The same work as the
/// web's sync page; lines added here are tagged on the server afterwards.
struct StatementSyncView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let file: SharedFile

    @State private var bank: String?
    @State private var busy = false
    @State private var report: StatementReport?
    @State private var error: String?
    @State private var detecting = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label(file.name, systemImage: "doc.text")
                        .lineLimit(2)
                    Picker("Bank", selection: $bank) {
                        Text("ICICI").tag(String?.some("ICICI"))
                        Text("Axis").tag(String?.some("AXIS"))
                    }
                    .pickerStyle(.segmented)
                    .disabled(busy || report != nil)
                } footer: {
                    if detecting {
                        Label("Checking which bank this is…", systemImage: "magnifyingglass")
                    } else {
                        Text("Lines the SMS feed missed are added and filed. Nothing already here is changed.")
                    }
                }

                if report == nil {
                    Section {
                        Button {
                            Task { await reconcile() }
                        } label: {
                            HStack {
                                Text(busy ? "Reconciling…" : "Reconcile")
                                Spacer()
                                if busy { ProgressView() }
                            }
                        }
                        .disabled(bank == nil || busy)
                    }
                }

                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                    }
                }

                if let report { results(report) }
            }
            .navigationTitle("Statement")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(report == nil ? "Cancel" : "Done") { dismiss() }
                }
            }
        }
        .task {
            guard bank == nil else { return }
            bank = Self.guessBank(file.name, data: file.data, accounts: store.meta?.accounts ?? [])
            if bank == nil { await askServer() }
        }
        .interactiveDismissDisabled(busy)
    }

    @ViewBuilder private func results(_ r: StatementReport) -> some View {
        Section {
            row("Period", "\(Format.shortDay(Format.parseDay(r.periodStart))) – \(Format.shortDay(Format.parseDay(r.periodEnd)))")
            row("Lines in statement", "\(r.parsed)")
            row("Added", "\(r.backfilled)", tint: r.backfilled > 0 ? .green : nil)
            if r.alreadyPresent > 0 { row("Already added before", "\(r.alreadyPresent)") }
            if r.unmatchedInDb > 0 { row("In Finance, not in statement", "\(r.unmatchedInDb)", tint: .orange) }
        } header: {
            Label(r.backfilled == 0 && r.unmatchedInDb == 0 ? "Everything matched" : "Reconciled", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .textCase(nil)
        } footer: {
            if r.unmatchedInDb > 0 {
                Text("Rows Finance has for these dates that the statement does not show. Usually a duplicate SMS or a pending card charge.")
            }
        }
        if let b = r.balance { balanceSection(b) }
        if !r.samples.isEmpty {
            Section(r.backfilled > r.samples.count ? "First \(r.samples.count) added" : "Added") {
                ForEach(r.samples, id: \.self) { sample in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(sample.description)
                                .font(.subheadline)
                                .lineLimit(1)
                            Text(Format.shortDay(Format.parseDay(sample.date)))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text((sample.direction == "credit" ? "+" : "−") + Format.inrExact(sample.amount))
                            .monospacedDigit()
                            .foregroundStyle(sample.direction == "credit" ? .green : .primary)
                    }
                }
            }
        }
    }

    @ViewBuilder private func balanceSection(_ b: StatementReport.ClosingBalance) -> some View {
        Section {
            row("Closing balance", Format.inrExact(b.closing))
            if let predicted = b.predicted {
                row("Finance had worked out", Format.inrExact(predicted))
            }
            if let drift = b.drift {
                row("Difference", abs(drift) < 1 ? "None" : (drift > 0 ? "+" : "−") + Format.inrExact(abs(drift)),
                    tint: abs(drift) < 1 ? .green : .orange)
            }
        } header: {
            Text("Bank balance").textCase(nil)
        } footer: {
            if !b.saved {
                Text("Not saved: \(b.error ?? "unknown error"). The balance on Home still starts from the last reading.")
                    .foregroundStyle(.red)
            } else if let drift = b.drift, abs(drift) >= 1 {
                Text("The balance on Home now starts from the statement. The difference is money that moved without an SMS.")
            } else {
                Text("The balance on Home now starts from the statement.")
            }
        }
    }

    private func row(_ title: String, _ value: String, tint: Color? = nil) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text(value)
                .monospacedDigit()
                .foregroundStyle(tint ?? .secondary)
        }
    }

    /// The server reads .xls/.xlsx properly and knows the accounts, so it
    /// settles files the app cannot read. Leaves the choice to the user if it
    /// cannot tell either.
    private func askServer() async {
        withAnimation { detecting = true }
        defer { withAnimation { detecting = false } }
        if let found: DetectedBank = try? await store.api.upload(
            "statements/detect", file: file.data, fileName: file.name, fields: [:]
        ), bank == nil {
            withAnimation { bank = found.bank }
        }
    }

    private func reconcile() async {
        guard let bank else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let result: StatementReport = try await store.api.upload(
                "statements", file: file.data, fileName: file.name, fields: ["bank": bank]
            )
            withAnimation { report = result }
            store.changed()
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// The bank, without asking the server: the account number first (in the
    /// file name, then inside the file), then the column headers. Axis heads
    /// its table "Tran Date … PARTICULARS", ICICI "Transaction Remarks …
    /// Withdrawal Amount". Nil when the file does not say, which is always
    /// the case for a compressed .xlsx; the server is asked then.
    static func guessBank(_ name: String, data: Data = Data(), accounts: [KnownAccount] = []) -> String? {
        let lower = name.lowercased()
        // UTF-16 text becomes plain once its zero bytes are dropped.
        let text = String(decoding: data.filter { $0 != 0 }, as: UTF8.self)

        for source in [name, text] {
            let banks = Set(accounts.filter { mentionsAccount(source, $0.last4) }.map(\.bank))
            if banks.count == 1 { return banks.first }
        }
        if lower.contains("axis") { return "AXIS" }
        if lower.contains("icici") || lower.contains("optransactionhistory") { return "ICICI" }

        let upper = text.uppercased()
        let axis = ["TRAN DATE", "PARTICULARS", "AXIS BANK", "UTIB"].contains { upper.contains($0) }
        let icici = ["TRANSACTION REMARKS", "WITHDRAWAL AMOUNT", "ICICI BANK", "ICIC0"].contains { upper.contains($0) }
        if axis != icici { return axis ? "AXIS" : "ICICI" }
        return nil
    }

    /// Masked ("XX4321") or full account numbers, never a bare run of digits
    /// that could be an amount ("14321.00"). Same rule as the server's.
    static func mentionsAccount(_ text: String, _ last4: String) -> Bool {
        text.range(of: "(?:[Xx*]{2,}|[0-9]{5,})\(last4)(?![0-9.])", options: .regularExpression) != nil
    }
}
