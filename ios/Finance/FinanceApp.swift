import SwiftUI

@main
struct FinanceApp: App {
    @State private var store: AppStore
    @State private var lock = AppLock()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let store = AppStore(api: .shared)
        _store = State(initialValue: store)
        Notifier.shared.attach(store)
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if store.api.isSignedIn {
                    RootView()
                        .transition(.opacity)
                } else {
                    SignInView()
                        .transition(.opacity)
                }
            }
            .animation(.smooth, value: store.api.isSignedIn)
            .overlay {
                if store.api.isSignedIn {
                    if lock.locked {
                        LockScreen().transition(.opacity)
                    } else if scenePhase != .active {
                        PrivacyCover()
                    }
                }
            }
            .animation(.smooth, value: lock.locked)
            .onChange(of: scenePhase, initial: true) { _, phase in
                if phase == .background {
                    lock.lock()
                    store.balancesHidden = true
                }
                // A cancelled prompt waits for the Unlock button, not another prompt.
                if phase == .active, lock.locked, !lock.failed {
                    Task { await lock.unlock() }
                }
            }
            .environment(lock)
            .environment(store)
            .onOpenURL { store.receive($0) }
        }
        // Sends SMS the Shortcuts action could not, without the app being opened.
        .backgroundTask(.appRefresh(Ingestor.backgroundTask)) {
            await Ingestor.shared.flush()
        }
    }
}
