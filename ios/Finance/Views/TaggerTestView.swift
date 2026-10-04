import SwiftUI

/// Runs made-up bank SMS through the server's parser and tagger, the model
/// included, as a dry run: nothing is saved. Each case says what it should
/// become; the run shows what it did and how long it took.
struct TaggerTestView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var cases: [TaggerTestCase] = []
    @State private var runs: [String: TaggerTestRun] = [:]
    @State private var running: Set<String> = []
    @State private var failures: [String: String] = [:]
    @State private var error: String?
    @State private var customSMS = ""
    @State private var customDescription = ""
    @State private var customRun: TaggerTestRun?
    @State private var customRunning = false

    private var passed: Int { runs.values.filter { $0.passed == true }.count }
    private var busy: Bool { !running.isEmpty || customRunning }

    var body: some View {
        NavigationStack {
            List {
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
                if !cases.isEmpty {
                    Section {
                        ForEach(cases) { testCase in
                            caseRow(testCase)
                        }
                    } header: {
                        Text(runs.isEmpty ? "\(cases.count) cases" : "\(passed) of \(runs.count) passed")
                    } footer: {
                        Text("Dry run: nothing is saved. Uses your real filing history.")
                    }
                } else if error == nil {
                    Section { ProgressView().frame(maxWidth: .infinity) }
                }
                customSection
            }
            .navigationTitle("Tagger Test")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button("Run All") { Task { await runAll() } }
                        .disabled(cases.isEmpty || busy)
                }
            }
            .task { await load() }
        }
    }

    // MARK: Cases

    private func caseRow(_ testCase: TaggerTestCase) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(testCase.title).font(.headline)
                Spacer()
                status(for: testCase)
            }
            Text(testCase.sms)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(3)
            if let description = testCase.description {
                Label("\"\(description)\"", systemImage: "text.bubble")
                    .font(.caption)
            }
            HStack(spacing: 6) {
                Text("Expect").foregroundStyle(.secondary)
                outcome(category: testCase.expected, path: testCase.expectedPath)
            }
            .font(.caption)
            if let run = runs[testCase.id] {
                HStack(spacing: 6) {
                    Text("Got").foregroundStyle(.secondary)
                    outcome(category: run.spam ? nil : run.result?.category, path: run.path)
                    if let confidence = run.result?.confidence {
                        Text(confidence.formatted(.percent.precision(.fractionLength(0))))
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text("\(run.ms) ms").foregroundStyle(.secondary)
                }
                .font(.caption)
                if let reasoning = run.result?.reasoning {
                    Text(reasoning).font(.caption).italic().foregroundStyle(.secondary)
                }
            }
            if let failure = failures[testCase.id] {
                Text(failure).font(.caption).foregroundStyle(.red)
            }
            Text(testCase.why).font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .onTapGesture { if !busy { Task { await run(testCase) } } }
    }

    @ViewBuilder
    private func status(for testCase: TaggerTestCase) -> some View {
        if running.contains(testCase.id) {
            ProgressView()
        } else if let passed = runs[testCase.id]?.passed {
            Image(systemName: passed ? "checkmark.circle.fill" : "xmark.circle.fill")
                .foregroundStyle(passed ? .green : .red)
                .accessibilityLabel(passed ? "Passed" : "Failed")
        } else if failures[testCase.id] != nil {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
        }
    }

    /// "Food & Dining · model", or "Spam".
    private func outcome(category: String?, path: String?) -> some View {
        HStack(spacing: 4) {
            if let category {
                Image(systemName: CategoryStyle.symbol(category))
                    .foregroundStyle(CategoryStyle.color(category))
                Text(category)
            } else if path == "spam" {
                Text("Spam")
            } else {
                Text("Nothing (left for review)")
            }
            if let path, path != "spam" {
                Text("· \(Self.pathName(path))").foregroundStyle(.secondary)
            }
        }
    }

    private static func pathName(_ path: String) -> String {
        switch path {
        case "ai": "model"
        case "note": "your description"
        case "history": "history"
        case "rule": "rule"
        default: path
        }
    }

    // MARK: Your own SMS

    private var customSection: some View {
        Section {
            TextField("Paste a bank SMS", text: $customSMS, axis: .vertical)
                .font(.callout.monospaced())
                .lineLimit(3...8)
            TextField("What it was for (optional)", text: $customDescription)
            Button {
                Task { await runCustom() }
            } label: {
                HStack {
                    Text("Run")
                    if customRunning { Spacer(); ProgressView() }
                }
            }
            .disabled(customSMS.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
            if let run = customRun {
                VStack(alignment: .leading, spacing: 4) {
                    if let parsed = run.parsed {
                        Text("\(parsed.merchant ?? "Unknown") · \(parsed.direction ?? "") · ₹\(parsed.amount.map { $0.formatted() } ?? "")")
                            .font(.caption)
                    }
                    HStack {
                        outcome(category: run.spam ? nil : run.result?.category, path: run.path)
                        Spacer()
                        Text("\(run.ms) ms").foregroundStyle(.secondary)
                    }
                    .font(.caption)
                    if let reasoning = run.result?.reasoning {
                        Text(reasoning).font(.caption).italic().foregroundStyle(.secondary)
                    }
                }
            }
        } header: {
            Text("Your own SMS")
        }
    }

    // MARK: Requests

    private func load() async {
        do {
            let reply: TaggerTestCases = try await store.api.get("tagger/test", cache: false)
            cases = reply.cases
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// One at a time: the model server answers one request at a time anyway.
    private func runAll() async {
        runs = [:]
        failures = [:]
        for testCase in cases { await run(testCase) }
    }

    private func run(_ testCase: TaggerTestCase) async {
        struct Body: Encodable { let caseId: String }
        running.insert(testCase.id)
        defer { running.remove(testCase.id) }
        failures[testCase.id] = nil
        do {
            runs[testCase.id] = try await store.api.send("POST", "tagger/test", body: Body(caseId: testCase.id))
        } catch {
            runs[testCase.id] = nil
            failures[testCase.id] = error.localizedDescription
        }
    }

    private func runCustom() async {
        struct Body: Encodable { let sms: String; let description: String }
        customRunning = true
        defer { customRunning = false }
        do {
            customRun = try await store.api.send(
                "POST", "tagger/test", body: Body(sms: customSMS, description: customDescription)
            )
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// MARK: - Models

struct TaggerTestCases: Decodable {
    let cases: [TaggerTestCase]
}

struct TaggerTestCase: Decodable, Identifiable {
    let id: String
    let title: String
    let sms: String
    let description: String?
    let expected: String?
    let expectedPath: String
    let why: String
}

struct TaggerTestRun: Decodable {
    struct Parsed: Decodable {
        let merchant: String?
        let amount: Double?
        let direction: String?
    }
    struct Result: Decodable {
        let category: String
        let confidence: Double
        let taggedBy: String
        let reasoning: String?
    }
    let spam: Bool
    let parsed: Parsed?
    let result: Result?
    let path: String?
    let ms: Int
    let passed: Bool?
}
