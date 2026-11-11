import SwiftUI

struct MainWindow: View {
    @Environment(Store.self) private var store
    /// The window object outlives its close, so its content is built only while shown.
    @State private var shown = false

    var body: some View {
        Group {
            if shown { content }
        }
        .onAppear {
            NSApp.setActivationPolicy(.regular)
            NSApp.activate()
            shown = true
            store.setWindowVisible(true)
        }
        .onDisappear {
            shown = false
            store.setWindowVisible(false)
            NSApp.setActivationPolicy(.accessory)
        }
    }

    private var content: some View {
        @Bindable var store = store
        return NavigationSplitView {
            List(Pane.allCases, selection: $store.pane) { p in
                Label(p.title, systemImage: p.symbol)
                    .badge(badge(p))
                    .tag(p)
            }
            .navigationSplitViewColumnWidth(min: 150, ideal: 170, max: 220)
        } detail: {
            switch store.pane {
            case .runs: RunsView()
            case .env: EnvView()
            case .disk: DiskView()
            case .setup: SetupView()
            }
        }
        .frame(minWidth: 760, minHeight: 440)
        .alert("Setu", isPresented: Binding(get: { store.alertMessage != nil }, set: { if !$0 { store.alertMessage = nil } })) {
            Button("OK") {}
        } message: {
            Text(store.alertMessage ?? "")
        }
    }

    private func badge(_ p: Pane) -> Int {
        switch p {
        case .runs: store.upCount
        case .env: 0
        case .disk: Int((store.cleanableBytes + 536_870_912) / 1_073_741_824)
        case .setup: store.failingChecks
        }
    }
}

/// Status item: symbol (filled while any run is up) plus the count.
struct StatusLabel: View {
    @Environment(Store.self) private var store

    var body: some View {
        let up = store.upCount
        HStack(spacing: 3) {
            Image(systemName: up > 0 ? "square.stack.3d.up.fill" : "square.stack.3d.up")
            if up > 0 { Text("\(up)") }
        }
        .accessibilityLabel(up > 0 ? "Setu, \(up) running" : "Setu, nothing running")
    }
}

@main
struct SetuApp: App {
    @State private var store = Store()

    var body: some Scene {
        MenuBarExtra {
            MenuView().environment(store)
        } label: {
            StatusLabel().environment(store)
        }
        .menuBarExtraStyle(.window)

        Window("Setu", id: "main") {
            MainWindow().environment(store)
        }
        .defaultLaunchBehavior(.suppressed)
        .commands {
            CommandMenu("View") {
                ForEach(Array(Pane.allCases.enumerated()), id: \.element) { i, p in
                    Button(p.title) { store.pane = p }
                        .keyboardShortcut(KeyEquivalent(Character("\(i + 1)")), modifiers: .command)
                }
            }
        }

        Settings {
            SetupView().environment(store).frame(width: 640, height: 300)
        }
    }

    init() {
        let s = _store.wrappedValue
        s.startPolling()
    }
}
