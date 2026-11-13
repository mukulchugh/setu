import SwiftUI

struct IconButton: View {
    let symbol: String
    let label: String
    var tint: Color?
    var subject = ""
    let action: () -> Void
    var body: some View {
        Button(action: action) { Label(label, systemImage: symbol).labelStyle(.iconOnly) }
            .buttonStyle(.borderless)
            .foregroundStyle(tint ?? Color.primary)
            .help(label)
            .accessibilityLabel(subject.isEmpty ? label : "\(label) \(subject)")
    }
}

struct StatusDot: View {
    let run: Run
    var body: some View {
        let s = statusSymbol(run)
        Label(s.word, systemImage: s.name)
            .labelStyle(.iconOnly)
            .foregroundStyle(s.color)
            .help(s.word)
            .accessibilityLabel("\(s.word), \(run.run)")
    }
}

struct RunsView: View {
    @Environment(Store.self) private var store
    @State private var query = ""
    @State private var creating = false
    @State private var showRemoved = false
    @State private var removing: Run?
    @State private var releasing: Run?

    private var rows: [Run] {
        let q = query.lowercased()
        let all = store.runs.sorted { ($0.isUp ? 0 : 1, $0.run) < ($1.isUp ? 0 : 1, $1.run) }
        return q.isEmpty ? all : all.filter { $0.run.lowercased().contains(q) || ($0.url ?? "").lowercased().contains(q) }
    }

    private var selected: [Run] { store.runs.filter { store.runSelection.contains($0.id) } }

    var body: some View {
        @Bindable var store = store
        Group {
            if !store.loaded {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if !store.daemonUp {
                ContentUnavailableView {
                    Label("Setu isn't running", systemImage: "bolt.slash")
                } actions: {
                    Button("Start Setu", systemImage: "play.fill") { store.startDaemon() }
                        .buttonStyle(.borderedProminent)
                }
            } else if store.runs.isEmpty {
                ContentUnavailableView {
                    Label("No runs yet", systemImage: "square.stack.3d.up.slash")
                } actions: {
                    Button("New Worktree", systemImage: "plus.square.on.square") { creating = true }
                }
            } else if rows.isEmpty {
                ContentUnavailableView.search(text: query)
            } else {
                table
            }
        }
        .navigationTitle("Runs")
        .searchable(text: $query, placement: .toolbar, prompt: "Search")
        .inspector(isPresented: $store.showLogs) {
            LogsPane(run: selected.count == 1 ? selected[0] : nil)
                .inspectorColumnWidth(min: 260, ideal: 380, max: 700)
        }
        .toolbar { toolbar }
        .sheet(isPresented: $creating) { NewWorktreeSheet() }
        .sheet(isPresented: $showRemoved) { RemovedSheet() }
        .confirmationDialog("Remove \(removing?.run ?? "")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible, presenting: removing) { r in
            Button("Remove", role: .destructive) { Task { await store.removeWorktree(r.run) } }
        } message: { _ in
            Text("The branch is kept; ignored files are archived for 30 days.")
        }
        .confirmationDialog("Release \(releasing?.claim?.holder ?? "")'s claim?", isPresented: Binding(get: { releasing != nil }, set: { if !$0 { releasing = nil } }), titleVisibility: .visible, presenting: releasing) { r in
            Button("Release Claim", role: .destructive) { Task { await store.releaseClaim(r.run) } }
        } message: { r in
            Text("\(r.claim?.holder ?? "It") may still be working in \(r.run).")
        }
        .alert("Can't remove \(store.refusal?.run ?? "")", isPresented: Binding(get: { store.refusal != nil }, set: { if !$0 { store.refusal = nil } })) {
            Button("OK") {}
        } message: {
            Text((store.refusal?.reasons ?? []).map { "• \($0)" }.joined(separator: "\n"))
        }
    }

    private var table: some View {
        @Bindable var store = store
        return Table(rows, selection: $store.runSelection) {
            TableColumn("") { r in StatusDot(run: r) }.width(24)
            TableColumn("Run") { r in RunNameCell(run: r) { Task { await store.setPinned(r.run, true) } } }
            TableColumn("URL") { r in
                if let u = r.url, r.isUp {
                    Button(u.replacingOccurrences(of: "http://", with: "")) { openURL(u) }
                        .buttonStyle(.link)
                        .help("Open")
                        .accessibilityLabel("Open \(r.run)")
                }
            }
            TableColumn("RAM") { r in
                Text(r.isUp ? humanBytes(r.ramBytes) : "").monospacedDigit().foregroundStyle(.secondary)
            }.width(80)
            TableColumn("") { r in
                HStack(spacing: 10) {
                    if r.isUp {
                        IconButton(symbol: "arrow.up.right.square", label: "Open", subject: r.run) { openURL(r.url) }
                        IconButton(symbol: "stop.fill", label: "Stop", subject: r.run) { Task { await store.act("down", r.run) } }
                    } else {
                        IconButton(symbol: "play.fill", label: "Start", subject: r.run) { Task { await store.act("start", r.run) } }
                    }
                    Menu {
                        menu(for: [r])
                    } label: { Image(systemName: "ellipsis") }
                        .menuStyle(.borderlessButton)
                        .fixedSize()
                        .help("More")
                        .accessibilityLabel("More for \(r.run)")
                }
            }.width(110)
        }
        .contextMenu(forSelectionType: String.self) { ids in
            menu(for: store.runs.filter { ids.contains($0.id) })
        } primaryAction: { ids in
            for r in store.runs where ids.contains(r.id) { openURL(r.url) }
        }
    }

    @ViewBuilder
    private func menu(for rs: [Run]) -> some View {
        if !rs.isEmpty {
            let up = rs.contains(where: \.isUp)
            if up {
                Button("Open", systemImage: "arrow.up.right.square") { for r in rs { openURL(r.url) } }
                Button("Restart", systemImage: "arrow.clockwise") { Task { await store.act("restart", rs) } }
                Button("Stop", systemImage: "stop.fill") { Task { await store.act("down", rs) } }
            }
            if rs.contains(where: \.canStart) {
                Button("Start", systemImage: "play.fill") { Task { await store.act("start", rs.filter(\.canStart)) } }
            }
            if rs.count == 1 {
                Button("Logs", systemImage: "text.alignleft") { store.requestLogs(rs[0].run) }
                if let u = rs[0].url {
                    Button("Copy URL", systemImage: "doc.on.doc") { copyPlain(u) }
                }
                if !rs[0].aliases.isEmpty {
                    Menu("Other URLs", systemImage: "link") {
                        ForEach(rs[0].aliases, id: \.host) { a in
                            Button(a.host) { openURL(rs[0].aliasURL(a.host)) }
                        }
                    }
                }
                Divider()
                if rs[0].pinned {
                    Button("Unpin", systemImage: "pin.slash") { Task { await store.setPinned(rs[0].run, false) } }
                } else {
                    Button("Pin", systemImage: "pin.fill") { Task { await store.setPinned(rs[0].run, true) } }
                }
                if rs[0].claim != nil {
                    Button("Release Claim", systemImage: "person.crop.circle.badge.xmark") { releasing = rs[0] }
                }
                Button("Remove…", systemImage: "trash", role: .destructive) { removing = rs[0] }
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItemGroup {
            if store.busy > 0 { ProgressView().controlSize(.small) }
            ToolbarBtn("New Worktree", "plus.square.on.square") { creating = true }
            ToolbarBtn("Open", "arrow.up.right.square", key: "o", disabled: !selected.contains(where: \.isUp)) {
                for r in selected where r.isUp { openURL(r.url) }
            }
            ToolbarBtn("Start", "play.fill", disabled: !selected.contains(where: \.canStart)) {
                Task { await store.act("start", selected.filter(\.canStart)) }
            }
            ToolbarBtn("Restart", "arrow.clockwise", key: "r", disabled: !selected.contains(where: \.isUp)) {
                Task { await store.act("restart", selected.filter(\.isUp)) }
            }
            ToolbarBtn("Stop", "stop.fill", key: ".", disabled: !selected.contains(where: \.isUp)) {
                Task { await store.act("down", selected.filter(\.isUp)) }
            }
            ToolbarBtn("Copy URL", "doc.on.doc", disabled: selected.count != 1 || selected[0].url == nil) {
                if let u = selected.first?.url { copyPlain(u) }
            }
            ToolbarBtn("Logs", "text.alignleft", key: "l") { store.showLogs.toggle() }
            Menu {
                Button("Add Worktree…", systemImage: "folder.badge.plus") { Task { await store.addWorktree() } }
                Button("Recently Removed", systemImage: "arrow.uturn.backward") { showRemoved = true }
            } label: { Label("More", systemImage: "ellipsis") }
                .help("More")
                .accessibilityLabel("More")
        }
    }
}

/// Symbol-only toolbar button with tooltip and accessibility label.
struct ToolbarBtn: View {
    let title: String
    let symbol: String
    var key: KeyEquivalent?
    var disabled = false
    let action: () -> Void
    init(_ title: String, _ symbol: String, key: KeyEquivalent? = nil, disabled: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.symbol = symbol
        self.key = key
        self.disabled = disabled
        self.action = action
    }
    var body: some View {
        let b = Button(action: action) { Label(title, systemImage: symbol) }
            .labelStyle(.iconOnly)
            .help(title)
            .accessibilityLabel(title)
            .disabled(disabled)
        if let key { b.keyboardShortcut(key, modifiers: .command) } else { b }
    }
}

struct LogsPane: View {
    @Environment(Store.self) private var store
    let run: Run?
    @State private var text = ""

    var body: some View {
        Group {
            if let run {
                ScrollView {
                    Text(text.isEmpty ? " " : text)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                }
                .defaultScrollAnchor(.bottom)
                .task(id: run.id) {
                    // Logs are fetched only while this pane is on screen.
                    text = ""
                    while !Task.isCancelled {
                        if let l: LogsReply = try? await store.daemon.call(request("logs", ["run": run.run, "lines": 200]), timeout: 5),
                           !Task.isCancelled {
                            if l.text != text { text = l.text }
                        }
                        try? await Task.sleep(for: .seconds(2))
                    }
                }
            } else {
                ContentUnavailableView("Pick a run", systemImage: "text.alignleft")
            }
        }
    }
}

struct LogsReply: Decodable, Sendable {
    var text: String
    init(from d: Decoder) throws {
        text = try d.container(keyedBy: CodingKeys.self).val(.text, "")
    }
    enum CodingKeys: String, CodingKey { case text }
}
