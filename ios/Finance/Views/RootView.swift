import SwiftUI

struct RootView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @State private var wasInBackground = false

    var body: some View {
        @Bindable var store = store
        TabView(selection: $store.selectedTab) {
            Tab("Home", systemImage: "house.fill", value: AppTab.home) {
                HomeView()
            }
            Tab("Inbox", systemImage: "tray.fill", value: AppTab.inbox) {
                InboxView()
            }
            .badge(store.inboxCount)
            Tab("Transactions", systemImage: "list.bullet.rectangle.portrait.fill", value: AppTab.transactions) {
                TransactionsView()
            }
            Tab("Parkings", systemImage: "parkingsign.circle.fill", value: AppTab.parkings) {
                ParkingsView()
            }
        }
        .sheet(item: $store.sharedStatement) { file in
            StatementSyncView(file: file)
        }
        .task {
            await Notifier.shared.requestPermission()
            #if DEBUG
            // Simulator smoke test for the Log Transaction action.
            if let sms = ProcessInfo.processInfo.environment["FINANCE_LOG_SMS"] {
                await Ingestor.shared.log(body: sms, sender: nil)
            }
            #endif
            await store.refreshAll(reloadVisible: false)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { wasInBackground = true }
            if phase == .active, wasInBackground {
                wasInBackground = false
                Task { await store.refreshAll(reloadVisible: true) }
            }
        }
    }
}
