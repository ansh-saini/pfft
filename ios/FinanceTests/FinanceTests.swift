import Foundation
import Testing
@testable import Finance

struct DecodingTests {
    @Test func decodesATransactionFromTheAPI() throws {
        let json = """
        {"id":"t1","transaction_date":"2026-09-26","received_at":null,"merchant":"RAHUL VERMA",
         "amount":20,"direction":"debit","bank":"ICICI","source":"icici_bank","category":"Food & Dining",
         "sub_category":"Tea / Snacks","bucket_id":"b1","ai_confidence":0.4,"tagged_by":"ai","reviewed_at":null}
        """
        let t = try APIClient.decoder.decode(Transaction.self, from: Data(json.utf8))
        #expect(t.subCategory == "Tea / Snacks")
        #expect(t.value == 20)
        #expect(t.isUnsure)
        #expect(!t.isCredit)
    }

    @Test func readsAmountsSentAsStrings() throws {
        let amounts = try APIClient.decoder.decode([Amount].self, from: Data(#"["1500.50", 20]"#.utf8))
        #expect(amounts.map(\.value) == [1500.5, 20])
    }

    @Test func confidenceAtTheLineIsFiled() throws {
        let t = try APIClient.decoder.decode(
            Transaction.self, from: Data(#"{"id":"t","ai_confidence":0.5}"#.utf8)
        )
        #expect(!t.isUnsure)
    }
}

struct FormatTests {
    @Test func rupeesUseIndianGrouping() {
        #expect(Format.inr(215900.1) == "₹2,15,900")
        #expect(Format.inrExact(887.5) == "₹887.50" || Format.inrExact(887.5) == "₹887.5")
    }

    @Test func serverAddressIsNormalised() {
        #expect(APIClient.normaliseServer("localhost:3000/")?.absoluteString == "http://localhost:3000")
        #expect(APIClient.normaliseServer("money.example.com")?.absoluteString == "https://money.example.com")
        #expect(APIClient.normaliseServer("  ") == nil)
    }
}

struct ResponseCacheTests {
    private func tempDirectory() -> URL {
        FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
    }

    @Test func keyIgnoresQueryOrderAndNils() {
        #expect(ResponseCache.key("summary", query: ["cycle": nil]) == "summary")
        #expect(
            ResponseCache.key("transactions", query: ["b": "2", "a": "1"])
                == ResponseCache.key("transactions", query: ["a": "1", "b": "2"])
        )
    }

    @Test func aReplySurvivesARelaunch() async throws {
        let directory = tempDirectory()
        let data = Data(#"{"id":"t1","merchant":"Zepto"}"#.utf8)
        let row = try APIClient.decoder.decode(Transaction.self, from: data)
        ResponseCache(directory: directory).store(row, data: data, for: "transactions/t1")
        // The disk write is in the background; give it a moment.
        try await Task.sleep(for: .milliseconds(300))

        let relaunched = ResponseCache(directory: directory)
        let read: Transaction? = relaunched.value("transactions/t1")
        #expect(read?.merchant == "Zepto")
    }

    @Test func clearForgetsEverything() async throws {
        let directory = tempDirectory()
        let cache = ResponseCache(directory: directory)
        let data = Data(#"{"id":"t1"}"#.utf8)
        cache.store(try APIClient.decoder.decode(Transaction.self, from: data), data: data, for: "inbox")
        try await Task.sleep(for: .milliseconds(300))
        cache.clear()
        #expect((cache.value("inbox") as Transaction?) == nil)
        #expect((ResponseCache(directory: directory).value("inbox") as Transaction?) == nil)
    }
}

struct IngestNotificationTests {
    @Test func decodesTheIngestReply() throws {
        let json = """
        {"status":"ok","id":"t9","is_spam":false,"summary":"Rs 184 spent on Needs: Groceries (NEW ADARSH DAIR)",
         "confidence":0.85,"tagged_by":"history","needs_review":false,
         "parsed":{"category":"Groceries","sub_category":null,"bucket":"Needs","bank":"ICICI","source":"icici_bank",
                   "amount":184,"direction":"debit","merchant":"NEW ADARSH DAIR","transaction_date":"2026-10-01"}}
        """
        let result = try APIClient.decoder.decode(IngestResult.self, from: Data(json.utf8))
        #expect(result.needsReview == false)
        #expect(result.parsed?.bucket == "Needs")
        #expect(result.duplicate == nil)
    }

    @Test func titleReadsAsASentence() {
        let debit = IngestResult.Parsed(amount: Amount(184), direction: "debit", merchant: "NEW ADARSH DAIR")
        #expect(Notifier.title(debit) == "₹184 at New Adarsh Dair")
        let credit = IngestResult.Parsed(amount: Amount(75000), direction: "credit", merchant: "A Sharma")
        #expect(Notifier.title(credit).hasSuffix("from A Sharma"))
        #expect(Notifier.title(IngestResult.Parsed(amount: Amount(20), direction: "debit")).hasSuffix("spent"))
    }

    @Test func filedLineNamesCategoryAndBucket() {
        #expect(Notifier.filedLine(category: "Groceries", bucket: "Needs") == "Groceries · Needs")
        #expect(Notifier.filedLine(category: "Self Transfer", bucket: nil) == "Self Transfer")
    }
}

struct SelfTransferTests {
    @Test func aSelfTransferIsMarked() throws {
        let row = try APIClient.decoder.decode(
            Transaction.self, from: Data(#"{"id":"t","category":"Self Transfer","direction":"debit","amount":75000}"#.utf8)
        )
        #expect(row.isSelfTransfer)
        let spend = try APIClient.decoder.decode(
            Transaction.self, from: Data(#"{"id":"u","category":"Groceries","direction":"debit","amount":322}"#.utf8)
        )
        #expect(!spend.isSelfTransfer)
    }
}

/// Fails every request, so these tests never reach a server.
private final class OfflineProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
    }
    override func stopLoading() {}
}

struct OfflineQueueTests {
    private func offlineIngestor() -> (Ingestor, URL) {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [OfflineProtocol.self]
        let file = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).json")
        let api = APIClient(urlSession: URLSession(configuration: config), cache: ResponseCache(
            directory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        ))
        return (Ingestor(api: api, queueFile: file), file)
    }

    @Test func aMessageThatCannotBeSentStaysQueued() async {
        let (ingestor, _) = offlineIngestor()
        let result = await ingestor.log(body: "  ICICI Bank Acct XX123 debited for Rs 5.00  ", sender: "AM-ICICIB")
        #expect(result == nil)
        #expect(ingestor.pending.count == 1)
        #expect(ingestor.pending.first?.body == "ICICI Bank Acct XX123 debited for Rs 5.00")
    }

    @Test func messagesWaitInArrivalOrder() async {
        let (ingestor, _) = offlineIngestor()
        await ingestor.log(body: "first", sender: nil)
        await ingestor.log(body: "second", sender: nil)
        #expect(ingestor.pending.map(\.body) == ["first", "second"])
    }
}

struct StatementShareTests {
    @Test func bankIsGuessedFromTheFileName() {
        #expect(StatementSyncView.guessBank("OpTransactionHistory01-10-2026.xls") == "ICICI")
        #expect(StatementSyncView.guessBank("Axis_Statement_Sep.xls") == "AXIS")
        #expect(StatementSyncView.guessBank("statement.xlsx") == nil)
        // A name that says nothing: the headers inside decide.
        let axis = Data("SRL NO,Tran Date,CHQNO,PARTICULARS,DR,CR,BAL,SOL".utf8)
        #expect(StatementSyncView.guessBank("XXXXXXXX4321_1759.xls", data: axis) == "AXIS")
        let icici = ",S No.,Value Date,Transaction Date,Cheque Number,Transaction Remarks,Withdrawal Amount(INR)".data(using: .utf16LittleEndian)!
        #expect(StatementSyncView.guessBank("export.xls", data: icici) == "ICICI")
        let mine = [KnownAccount(bank: "AXIS", last4: "4321"), KnownAccount(bank: "ICICI", last4: "123")]
        #expect(StatementSyncView.guessBank("XXXXXXXX4321_1759.xls", accounts: mine) == "AXIS")
        #expect(StatementSyncView.guessBank("stmt.xls", data: Data("Account No: XXXXXXXXXX123".utf8), accounts: mine) == "ICICI")
        #expect(!StatementSyncView.mentionsAccount("Balance 14321.00", "4321"))
    }

    @Test func decodesTheStatementReport() throws {
        let json = """
        {"bank":"ICICI","parsed":58,"period_start":"2026-09-01","period_end":"2026-09-30","period_declared":true,
         "backfilled":2,"already_present":0,"unmatched_in_db":1,"matched_undated":0,
         "samples":[{"date":"2026-09-04","amount":120.5,"direction":"debit","description":"UPI/123/SHOP"}]}
        """
        let report = try APIClient.decoder.decode(StatementReport.self, from: Data(json.utf8))
        #expect(report.backfilled == 2)
        #expect(report.samples.first?.amount == 120.5)
    }
}

struct LeavesInboxTests {
    private func row(_ json: String) throws -> Transaction {
        try APIClient.decoder.decode(Transaction.self, from: Data(json.utf8))
    }

    @Test func aRowLeavesOnceFiledWithConfidence() throws {
        let store = AppStore(api: APIClient(urlSession: .shared, cache: ResponseCache(
            directory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        )))
        // Sure, with a bucket: done.
        #expect(store.leavesInbox(try row(#"{"id":"a","category":"Groceries","bucket_id":"b","ai_confidence":0.9}"#)))
        // Unsure: stays, unless the user decided.
        #expect(!store.leavesInbox(try row(#"{"id":"b","category":"Groceries","bucket_id":"b","ai_confidence":0.3,"tagged_by":"ai"}"#)))
        #expect(store.leavesInbox(try row(#"{"id":"c","category":"Groceries","bucket_id":"b","ai_confidence":0.3,"tagged_by":"user"}"#)))
        // No parking: still done. Spending sits in Float unless the user parks it.
        #expect(store.leavesInbox(try row(#"{"id":"d","category":"Groceries","ai_confidence":0.9}"#)))
        // No category: stays.
        #expect(!store.leavesInbox(try row(#"{"id":"e","bucket_id":"b","ai_confidence":0.9}"#)))
    }
}
