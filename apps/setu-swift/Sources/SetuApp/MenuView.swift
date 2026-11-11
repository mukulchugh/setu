import SwiftUI

struct MenuView: View {
    @Environment(Store.self) private var store
    @Environment(\.openWindow) private var openWindow

    private var rows: [Run] {
        store.runs.sorted { ($0.isUp ? 0 : 1, $0.run) < ($1.isUp ? 0 : 1, $1.run) }
    }

    var body: some View {
        VStack(spacing: 0) {
            Group {
                if !store.loaded {
                    ProgressView()
                } else if !store.daemonUp {
                    ContentUnavailableView {
                        Label("Setu isn't running", systemImage: "bolt.slash")
                    } actions: {
                        Button("Start Setu", systemImage: "play.fill") { store.startDaemon() }
                            .buttonStyle(.glass)
                    }
                } else if rows.isEmpty {
                    ContentUnavailableView {
                        Label("No runs yet", systemImage: "square.stack.3d.up.slash")
                    } actions: {
                        Button("Add Worktree…", systemImage: "plus") { Task { await store.addWorktree() } }
                    }
                } else {
                    List(rows) { r in row(r) }
                        .listStyle(.plain)
                        .scrollContentBackground(.hidden)
                }
            }
            .frame(height: 6 * 40)
            footer
        }
        .frame(width: 340)
        .background(WindowVisibility { store.setMenuVisible($0) })
        .alert("Setu", isPresented: Binding(get: { store.alertMessage != nil }, set: { if !$0 { store.alertMessage = nil } })) {
            Button("OK") {}
        } message: {
            Text(store.alertMessage ?? "")
        }
    }

    private func row(_ r: Run) -> some View {
        HStack(spacing: 8) {
            StatusDot(run: r)
            VStack(alignment: .leading, spacing: 1) {
                Text(r.run).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                if r.isUp {
                    Text(humanBytes(r.ramBytes)).font(.system(size: 11)).monospacedDigit().foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 4)
            if r.staleEnv && r.isUp {
                IconButton(symbol: "arrow.clockwise.circle.fill", label: "Restart for new env", tint: .orange, subject: r.run) { Task { await store.act("restart", r.run) } }
            }
            if r.isUp {
                IconButton(symbol: "arrow.up.right.square", label: "Open", subject: r.run) { openURL(r.url) }
            } else {
                IconButton(symbol: "play.fill", label: "Start", subject: r.run) { Task { await store.act("start", r.run) } }
            }
            Menu {
                if r.isUp {
                    Button("Restart", systemImage: "arrow.clockwise") { Task { await store.act("restart", r.run) } }
                    Button("Stop", systemImage: "stop.fill") { Task { await store.act("down", r.run) } }
                }
                Button("Logs", systemImage: "text.alignleft") { showWindow(); store.requestLogs(r.run) }
                if let u = r.url { Button("Copy URL", systemImage: "doc.on.doc") { copyPlain(u) } }
            } label: { Image(systemName: "ellipsis") }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .help("More")
                .accessibilityLabel("More for \(r.run)")
        }
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { openURL(r.url) }
    }

    private var footer: some View {
        GlassEffectContainer {
            HStack(spacing: 8) {
                Button { showWindow() } label: { Image(systemName: "macwindow") }
                    .help("Open Setu").accessibilityLabel("Open Setu")
                Button { Task { await store.addWorktree() } } label: { Image(systemName: "plus") }
                    .help("Add Worktree").accessibilityLabel("Add Worktree")
                Spacer()
                Menu {
                    Button("Config", systemImage: "checklist") { store.pane = .setup; showWindow() }
                    Divider()
                    Button("Quit", systemImage: "power") { NSApplication.shared.terminate(nil) }
                } label: { Image(systemName: "ellipsis") }
                    .menuStyle(.button)
                    .fixedSize()
                    .help("More").accessibilityLabel("More")
            }
            .buttonStyle(.glass)
            .padding(10)
        }
    }

    private func showWindow() {
        // User clicked "Open Setu", so activation is allowed. The window's onAppear sets
        // the regular policy and onDisappear returns to accessory (menu bar only).
        openWindow(id: "main")
        NSApp.activate()
    }
}


/// Reports whether the hosting NSWindow is on screen. MenuBarExtra content is built once and
/// kept, so onAppear/onDisappear do not track the popover being shown and dismissed.
struct WindowVisibility: NSViewRepresentable {
    let changed: (Bool) -> Void

    func makeNSView(context: Context) -> NSView { Probe(changed) }
    func updateNSView(_ view: NSView, context: Context) { (view as? Probe)?.changed = changed }

    final class Probe: NSView {
        var changed: (Bool) -> Void
        private var obs: NSKeyValueObservation?
        init(_ changed: @escaping (Bool) -> Void) {
            self.changed = changed
            super.init(frame: .zero)
        }
        required init?(coder: NSCoder) { nil }
        override func viewDidMoveToWindow() {
            obs = nil
            guard let w = window else { return }
            obs = w.observe(\.isVisible, options: [.initial, .new]) { [weak self] _, change in
                let v = change.newValue ?? false
                Task { @MainActor in self?.changed(v) }
            }
        }
    }
}

