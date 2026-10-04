import AppIntents

/// The step the Shortcuts message automation runs on a bank SMS. Runs in the
/// background: the app sends the message, the server files it, and the app
/// shows its own notification. Turn off "Notify When Run" on the automation.
struct LogTransactionIntent: AppIntent {
    static let title: LocalizedStringResource = "Log Transaction"
    static let description = IntentDescription(
        "Sends a bank SMS to Finance. It is filed on the server and Finance shows a notification with the result."
    )
    static let openAppWhenRun = false

    @Parameter(title: "Message", description: "The SMS text, from the automation's Shortcut Input.")
    var message: String

    @Parameter(title: "Sender", description: "Who sent the SMS, if the automation has it.")
    var sender: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Log \(\.$message) in Finance") {
            \.$sender
        }
    }

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<String> {
        guard APIClient.shared.isSignedIn else {
            throw LogTransactionError.signedOut
        }
        let result = await Ingestor.shared.log(body: message, sender: sender)
        return .result(value: result?.summary ?? "Saved on the phone; it will be sent when Finance can reach the server.")
    }
}

enum LogTransactionError: Error, CustomLocalizedStringResourceConvertible {
    case signedOut

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .signedOut: "Open Finance and sign in, then this action can log transactions."
        }
    }
}
