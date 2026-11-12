import SwiftUI

struct DiskView: View {
    @Environment(Store.self) private var store
    @State private var query = ""
    @State private var confirming = false
    @State private var measured = false

    private var groups: [(run: String, items: [DiskItem])] {
        let q = query.lowercased()
        let all = (store.disk?.items ?? []).filter {
            q.isEmpty || $0.run.lowercased().contains(q) || plainItem($0.item).lowercased().contains(q)
        }
        return Dictionary(grouping: all, by: \.run)
            .map { (run: $0.key, items: $0.value.sorted { ($0.size?.real ?? 0) > ($1.size?.real ?? 0) }) }
            .sorted { $0.run < $1.run }
    }

    private var stores: [DiskStore] { store.disk?.stores ?? [] }

    private var summary: String {
        let n = store.disk?.cleanable.count ?? 0
        return "\(n) free-able" + (n > 0 ? " \u{00B7} \(humanBytes(store.cleanableBytes))" : "")
    }

    private var freeLabel: String { "Free \(humanBytes(store.cleanableBytes))" }

    var body: some View {
        Group {
            if store.disk == nil {
                if store.busy > 0 {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ContentUnavailableView {
                        Label("Not measured", systemImage: "internaldrive")
                    } actions: {
                        Button("Measure", systemImage: "arrow.clockwise") { Task { await store.refreshDisk() } }
                    }
                }
            } else if groups.isEmpty, stores.isEmpty {
                ContentUnavailableView("Nothing to free", systemImage: "checkmark.circle")
            } else {
                List {
                    Section {
                    } header: {
                        Text(summary).monospacedDigit()
                    }
                    ForEach(groups, id: \.run) { g in
                        Section(g.run) {
                            ForEach(g.items) { i in
                                HStack(spacing: 8) {
                                    Image(systemName: i.eligible ? "trash.circle" : "lock.circle")
                                        .foregroundStyle(.secondary)
                                        .help(i.eligible ? "Safe to free" : "Kept")
                                        .accessibilityLabel(i.eligible ? "Safe to free" : "Kept")
                                    Text(plainItem(i.item)).fontWeight(.semibold)
                                    Text(i.reason).foregroundStyle(.secondary).lineLimit(1)
                                    Spacer()
                                    Text(i.size.map { humanBytes($0.real) } ?? "").monospacedDigit()
                                }
                            }
                        }
                    }
                    if !stores.isEmpty {
                        Section("Shared") {
                            ForEach(stores) { st in
                                HStack(spacing: 8) {
                                    Image(systemName: "externaldrive").foregroundStyle(.secondary)
                                        .accessibilityHidden(true)
                                    Text(st.name).fontWeight(.semibold)
                                    Text(st.project).foregroundStyle(.secondary)
                                    Spacer()
                                    Text(humanBytes(st.logical)).monospacedDigit()
                                }
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Disk")
        .searchable(text: $query, placement: .toolbar, prompt: "Search")
        .toolbar {
            ToolbarItemGroup {
                if store.busy > 0 { ProgressView().controlSize(.small) }
                if let d = store.disk {
                    Text(humanBytes(d.freeBytes) + " free").monospacedDigit().foregroundStyle(.secondary)
                        .help("Free space on this Mac")
                }
                ToolbarBtn("Measure", "arrow.clockwise") { Task { await store.refreshDisk() } }
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if store.cleanableBytes > 0 {
                // The one floating control in this view, so it gets glass.
                GlassEffectContainer {
                    Button { confirming = true } label: {
                        Label(freeLabel, systemImage: "trash").monospacedDigit()
                    }
                    .buttonStyle(.glass)
                    .controlSize(.large)
                    .help(freeLabel)
                    .accessibilityLabel(freeLabel)
                }
                .padding(16)
            }
        }
        .confirmationDialog("Free \(humanBytes(store.cleanableBytes))?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Free", role: .destructive) { Task { await store.freeDisk() } }
        } message: {
            Text(confirmBody)
        }
        .task {
            if !measured, store.disk == nil { measured = true; await store.refreshDisk() }
        }
    }

    private var confirmBody: String {
        let items = (store.disk?.cleanable ?? [])
        var lines = items.prefix(14).map { "\($0.run)  \(plainItem($0.item))  \(humanBytes($0.size?.real ?? 0))" }
        if items.count > 14 { lines.append("+ \(items.count - 14) more") }
        lines.append("Nothing else is touched.")
        return lines.joined(separator: "\n")
    }
}
