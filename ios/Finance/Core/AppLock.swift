import LocalAuthentication
import Observation
import SwiftUI

/// Face ID in front of the app. Locked at launch and whenever the app goes to
/// the background; unlocked with Face ID, or the device passcode when Face ID
/// fails. A device with neither set up is never locked, since nothing could
/// unlock it. Only the screen is locked: notification replies and the
/// Shortcuts action keep working in the background.
@Observable
final class AppLock {
    private(set) var locked: Bool
    private(set) var unlocking = false
    /// Set when the last attempt failed or was cancelled, so the lock screen
    /// offers a button instead of prompting again on its own.
    private(set) var failed = false

    init() {
        locked = AppLock.canLock
    }

    /// Whether this device can authenticate the owner at all.
    static var canLock: Bool {
        #if DEBUG
        // Simulator smoke tests and UI tests sign in with a launch token and
        // cannot answer a passcode prompt.
        if ProcessInfo.processInfo.environment["FINANCE_ACCESS_TOKEN"] != nil { return false }
        #endif
        return LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    }

    func lock() {
        guard AppLock.canLock else { return }
        locked = true
        failed = false
    }

    func unlock() async {
        guard locked, !unlocking else { return }
        unlocking = true
        defer { unlocking = false }
        let context = LAContext()
        context.localizedCancelTitle = "Not Now"
        do {
            let ok = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock Finance")
            withAnimation(.smooth) {
                locked = !ok
                failed = !ok
            }
        } catch {
            failed = true
        }
    }
}

/// What shows over the app while it is locked.
struct LockScreen: View {
    @Environment(AppLock.self) private var lock

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "faceid")
                .font(.system(size: 56, weight: .light))
                .foregroundStyle(.tint)
                .symbolEffect(.pulse, isActive: lock.unlocking)
            Text("Finance is locked")
                .font(.title3.weight(.semibold))
            if lock.failed {
                Button("Unlock") { Task { await lock.unlock() } }
                    .buttonStyle(.borderedProminent)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.regularMaterial)
        .animation(.smooth, value: lock.failed)
    }
}

/// Covers the app while it is not active, so the app switcher's snapshot shows
/// no balances.
struct PrivacyCover: View {
    var body: some View {
        Image(systemName: "indianrupeesign.circle.fill")
            .font(.system(size: 56))
            .foregroundStyle(.tint)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(.regularMaterial)
    }
}
