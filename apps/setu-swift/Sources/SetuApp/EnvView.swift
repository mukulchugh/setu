import SwiftUI

enum EnvKind: String, CaseIterable, Identifiable {
    case global, project, worktree, effective
    var id: String { rawValue }
    var symbol: String {
        switch self {
        case .global: "globe"
        case .project: "folder"
        case .worktree: "arrow.triangle.branch"
        case .effective: "checklist.checked"
        }
    }
    var word: String {
        switch self {
        case .global: "All projects"
        case .project: "This project"
        case .worktree: "This worktree"
        case .effective: "Effective for a run"
        }
    }
}

struct EnvRow: Identifiable, Hashable {
    var name: String
    var secret: Bool
    var preview: String?
    var source: String?
    var overrides: [String] = []
    var id: String { name }
}

struct EditorItem: Identifiable {
    let id = UUID()
    var existing: EnvRow?
}

private func sourceSymbol(_ s: String) -> String {
    switch s {
    case "global": "globe"
    case "project", "project-config": "folder"
    case "worktree": "arrow.triangle.branch"
    default: "gearshape"
    }
}

struct EnvView: View {
    @Environment(Store.self) private var store
    @State private var kind: EnvKind = .global
    @State private var project = ""
    @State private var runName = ""
    @State private var rows: [EnvRow] = []
    @State private var loading = false
    @State private var error: String?
    @State private var tick = 0
    @State private var query = ""
    @State private var editor: EditorItem?
    @State private var removing: EnvRow?
    @State private var importPlan: ImportPlan?

    struct ImportPlan {
        var path: String
        var report: ImportReport
    }

    private var projects: [String] { Array(Set(store.runs.map(\.project))).sorted() }
    private var runNames: [String] { store.runs.map(\.run).sorted() }
    private var effProject: String { project.isEmpty ? (projects.first ?? "") : project }
    private var effRun: String { runName.isEmpty ? (runNames.first ?? "") : runName }

    /// Wire fields for the layer being viewed. nil when the scope has no target.
    private var layer: [String: Any]? { layerFor(kind) }

    private func layerFor(_ k: EnvKind) -> [String: Any]? {
        switch k {
        case .global: ["scope": "global"]
        case .project: effProject.isEmpty ? nil : ["scope": "project", "target": effProject]
        case .worktree: effRun.isEmpty ? nil : ["scope": "worktree", "target": effRun]
        case .effective: nil
        }
    }

    private var loadKey: String { "\(kind.rawValue)|\(effProject)|\(effRun)|\(tick)|\(store.runs.isEmpty)" }

    private var shown: [EnvRow] {
        let q = query.lowercased()
        return q.isEmpty ? rows : rows.filter { $0.name.lowercased().contains(q) }
    }

    var body: some View {
        content
            .navigationTitle("Environments")
            .searchable(text: $query, placement: .toolbar, prompt: "Search")
            .toolbar { toolbar }
            .task(id: loadKey) { await load() }
            .sheet(item: $editor) { item in
                EnvEditor(existing: item.existing) { name, value, secret in
                    await save(item.existing, name: name, value: value, secret: secret)
                }
            }
            .confirmationDialog("Remove \(removing?.name ?? "")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible, presenting: removing) { row in
                Button("Remove", role: .destructive) { Task { await remove(row) } }
            } message: { _ in
                Text("Runs pick this up the next time they start.")
            }
            .confirmationDialog(importTitle, isPresented: Binding(get: { importPlan != nil }, set: { if !$0 { importPlan = nil } }), titleVisibility: .visible, presenting: importPlan) { plan in
                Button("Import") { Task { await runImport(plan, overwrite: false) } }
                if !plan.report.overwritten.isEmpty {
                    Button("Import and overwrite", role: .destructive) { Task { await runImport(plan, overwrite: true) } }
                }
            } message: { plan in
                Text(importBody(plan.report))
            }
    }

    private var importTitle: String { "Import variables?" }

    private func importBody(_ r: ImportReport) -> String {
        var s = "\(r.imported.count) new, \(r.overwritten.count) already set, \(r.secrets.count) secret."
        if !r.imported.isEmpty { s += "\n" + r.imported.prefix(30).joined(separator: ", ") }
        if !r.problems.isEmpty { s += "\nProblems: " + r.problems.prefix(5).joined(separator: "; ") }
        return s
    }

    @ViewBuilder private var content: some View {
        if kind == .effective ? runNames.isEmpty : layer == nil {
            ContentUnavailableView("No runs yet", systemImage: "square.stack.3d.up.slash")
        } else if let error {
            ContentUnavailableView {
                Label(error, systemImage: "exclamationmark.triangle")
            } actions: {
                Button("Try again", systemImage: "arrow.clockwise") { tick += 1 }
            }
        } else if rows.isEmpty, !loading {
            ContentUnavailableView {
                Label("No variables", systemImage: "list.bullet.rectangle")
            } actions: {
                if kind != .effective {
                    Button("Add", systemImage: "plus") { editor = EditorItem() }
                }
            }
        } else {
            Table(shown) {
                TableColumn("Name") { r in
                    HStack(spacing: 6) {
                        if let s = r.source {
                            Image(systemName: sourceSymbol(s))
                                .foregroundStyle(.secondary)
                                .help(r.overrides.isEmpty ? s : "\(s), overrides \(r.overrides.joined(separator: ", "))")
                                .accessibilityLabel(s)
                        }
                        Text(r.name).fontWeight(.semibold)
                    }
                }
                TableColumn("Value") { r in
                    if r.secret {
                        Label("••••", systemImage: "lock.fill")
                            .foregroundStyle(.secondary)
                            .help("Secret")
                            .accessibilityLabel("Secret, hidden")
                    } else {
                        Text(r.preview ?? "").font(.system(.body, design: .monospaced)).lineLimit(1)
                    }
                }
                TableColumn("") { r in actions(r) }.width(96)
            }
        }
    }

    @ViewBuilder private func actions(_ r: EnvRow) -> some View {
        HStack(spacing: 10) {
            if r.secret, revealLayer(r) != nil {
                IconButton(symbol: "eye", label: "Reveal and copy", subject: r.name) { Task { await reveal(r) } }
            }
            if kind != .effective {
                IconButton(symbol: "pencil", label: "Edit", subject: r.name) { editor = EditorItem(existing: r) }
                IconButton(symbol: "trash", label: "Remove", subject: r.name) { removing = r }
            }
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItemGroup {
            if loading || store.busy > 0 { ProgressView().controlSize(.small) }
            Picker("Scope", selection: $kind) {
                ForEach(EnvKind.allCases) { k in
                    Image(systemName: k.symbol).help(k.word).accessibilityLabel(k.word).tag(k)
                }
            }
            .pickerStyle(.segmented)
            .help("Scope")
            if kind == .project {
                Picker("Project", selection: Binding(get: { effProject }, set: { project = $0 })) {
                    ForEach(projects, id: \.self) { Text($0).tag($0) }
                }
                .help("Project")
            }
            if kind == .worktree || kind == .effective {
                Picker("Run", selection: Binding(get: { effRun }, set: { runName = $0 })) {
                    ForEach(runNames, id: \.self) { Text($0).tag($0) }
                }
                .help("Run")
            }
        }
        ToolbarItemGroup {
            if kind != .effective {
                ToolbarBtn("Add", "plus", disabled: layer == nil) { editor = EditorItem() }
                ToolbarBtn("Import", "square.and.arrow.down", disabled: layer == nil) { Task { await startImport() } }
            }
            ToolbarBtn("Refresh", "arrow.clockwise") { tick += 1 }
        }
    }

    // MARK: data

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            if kind == .effective {
                guard !effRun.isEmpty else { rows = []; return }
                let e: EnvEffective = try await store.daemon.call(request("env.effective", ["run": effRun]))
                rows = e.vars.map { EnvRow(name: $0.name, secret: $0.secret, preview: $0.preview, source: $0.source, overrides: $0.overrides) }
            } else {
                guard let layer else { rows = []; return }
                let l: EnvList = try await store.daemon.call(request("env.list", layer))
                rows = l.vars.map { EnvRow(name: $0.name, secret: $0.secret, preview: $0.preview) }
            }
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "Could not load."
        }
    }

    private func revealLayer(_ r: EnvRow) -> [String: Any]? {
        guard kind == .effective else { return layer }
        switch r.source ?? "" {
        case "global": return ["scope": "global"]
        case "project":
            let p = store.runs.first { $0.run == effRun }?.project ?? ""
            return p.isEmpty ? nil : ["scope": "project", "target": p]
        case "worktree": return ["scope": "worktree", "target": effRun]
        default: return nil
        }
    }

    private func reveal(_ r: EnvRow) async {
        guard var f = revealLayer(r) else { return }
        f["name"] = r.name
        if let rev: Reveal = await store.work({ try await store.daemon.call(request("env.reveal", f)) }) {
            copyConcealed(rev.value)
            store.alertMessage = "Copied \(r.name). Clears in 30 s."
        }
    }

    private func save(_ ex: EnvRow?, name: String, value: String, secret: Bool) async {
        guard var f = layer else { return }
        f["name"] = name
        var v = value
        if v.isEmpty, let ex {
            if ex.secret == secret { return }
            // Flag flipped with no new value: carry the stored value across.
            var rf = f
            rf["name"] = name
            guard let rev: Reveal = await store.work({ try await store.daemon.call(request("env.reveal", rf)) }) else { return }
            v = rev.value
        }
        f["value"] = v
        f["secret"] = secret
        v = ""
        _ = await store.work { () -> Ignored in try await store.daemon.call(request("env.set", f)) }
        f["value"] = nil
        tick += 1
    }

    private func remove(_ r: EnvRow) async {
        guard var f = layer else { return }
        f["name"] = r.name
        _ = await store.work { () -> Ignored in try await store.daemon.call(request("env.unset", f)) }
        tick += 1
    }

    private func startImport() async {
        guard var f = layer, let url = await choose(files: true, message: "Choose a .env file to import") else { return }
        f["path"] = url.path
        f["preview"] = true
        f["overwrite"] = false
        if let rep: ImportReport = await store.work({ try await store.daemon.call(request("env.import", f)) }) {
            importPlan = ImportPlan(path: url.path, report: rep)
        }
    }

    private func runImport(_ plan: ImportPlan, overwrite: Bool) async {
        guard var f = layer else { return }
        f["path"] = plan.path
        f["preview"] = false
        f["overwrite"] = overwrite
        _ = await store.work { () -> ImportReport in try await store.daemon.call(request("env.import", f)) }
        tick += 1
    }
}

struct EnvEditor: View {
    @Environment(\.dismiss) private var dismiss
    let existing: EnvRow?
    let onSave: (String, String, Bool) async -> Void
    @State private var name = ""
    @State private var value = ""
    @State private var secret = false
    @State private var touched = false
    @FocusState private var focus: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(existing == nil ? "Add variable" : "Edit variable").font(.headline)
            TextField("NAME", text: $name)
                .textFieldStyle(.roundedBorder)
                .disabled(existing != nil)
                .focused($focus)
                .accessibilityLabel("Name")
                .onChange(of: name) { _, n in
                    if existing == nil, !touched { secret = isSecretName(n) }
                }
            Group {
                if secret {
                    SecureField(existing == nil ? "Value" : "New value (blank keeps it)", text: $value)
                        .accessibilityLabel("Value, hidden")
                } else {
                    TextField(existing == nil ? "Value" : "New value (blank keeps it)", text: $value)
                        .accessibilityLabel("Value")
                }
            }
            .textFieldStyle(.roundedBorder)
            Toggle(isOn: Binding(get: { secret }, set: { secret = $0; touched = true })) {
                Image(systemName: "lock.fill")
            }
            .help("Secret: hide this value everywhere")
            .accessibilityLabel("Secret")
            Text("Applies the next time affected runs start.")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { value = ""; dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Save") {
                    let (n, v, s) = (name.trimmingCharacters(in: .whitespaces), value, secret)
                    value = ""
                    dismiss()
                    Task { await onSave(n, v, s) }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 360)
        .onAppear {
            if let e = existing { name = e.name; secret = e.secret; touched = true }
            focus = existing == nil
        }
        .onDisappear { value = "" }
    }
}
