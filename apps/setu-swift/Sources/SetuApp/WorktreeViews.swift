import SwiftUI

/// Symbol-only claim and pending-removal markers (the popover shows only these).
struct RunBadges: View {
    let run: Run
    var body: some View {
        HStack(spacing: 4) {
            if let c = run.claim { ClaimBadge(claim: c, run: run.run) }
            if let r = run.removal {
                Image(systemName: "clock.badge.exclamationmark")
                    .foregroundStyle(.secondary)
                    .help("\(r.countdown()): \(r.reason)")
                    .accessibilityLabel("Pending removal, \(r.countdown()), \(run.run)")
            }
        }
    }
}

struct ClaimBadge: View {
    let claim: Claim
    let run: String
    var body: some View {
        Image(systemName: "person.crop.circle.badge.clock")
            .foregroundStyle(claim.stale ? AnyShapeStyle(.secondary) : AnyShapeStyle(.tint))
            .help(claim.tooltip)
            .accessibilityLabel("\(claim.tooltip), \(run)")
    }
}

/// Run name with its claim, pin and pending-removal markers (Runs table).
/// Table cells must not read the Store from the environment: on macOS 27, cells built during a
/// scroll can be laid out without it and SwiftUI traps. Everything a cell needs is passed in.
struct RunNameCell: View {
    let run: Run
    let onPin: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(run.run).fontWeight(.semibold)
                if run.staleEnv && run.isUp {
                    Image(systemName: "arrow.clockwise.circle.fill")
                        .foregroundStyle(.orange)
                        .help("Restart for new env")
                        .accessibilityLabel("Restart for new env")
                }
                if let c = run.claim { ClaimBadge(claim: c, run: run.run) }
                if run.pinned {
                    Image(systemName: "pin.fill")
                        .foregroundStyle(.secondary)
                        .help("Pinned: kept")
                        .accessibilityLabel("Pinned, \(run.run)")
                }
            }
            if let r = run.removal {
                HStack(spacing: 4) {
                    Image(systemName: "clock.badge.exclamationmark")
                    Text(r.countdown())
                    IconButton(symbol: "pin.fill", label: "Pin", subject: run.run, action: onPin)
                }
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .help(r.reason)
            }
        }
    }
}

struct NewWorktreeSheet: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var project = ""
    @State private var branch = ""
    @State private var base = ""
    @State private var start = true
    @State private var error: String?
    @State private var working = false

    private var problem: String? { branchProblem(branch) }
    private var basePrompt: String { store.projects.first { $0.project == project }?.base ?? "Default" }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("New Worktree", systemImage: "plus.square.on.square").font(.headline)
            if store.projects.isEmpty {
                Text("No projects configured.").foregroundStyle(.secondary)
            } else {
                Form {
                    Picker("Project", selection: $project) {
                        ForEach(store.projects) { Text($0.project).tag($0.project) }
                    }
                    TextField("Branch", text: $branch, prompt: Text("feat/my-change"))
                        .autocorrectionDisabled()
                    TextField("Base", text: $base, prompt: Text(basePrompt))
                        .autocorrectionDisabled()
                    Toggle("Start", isOn: $start)
                }
                .formStyle(.columns)
                Text(branch.isEmpty ? " " : (problem ?? " ")).font(.caption).foregroundStyle(.secondary)
            }
            if let error {
                Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled)
            }
            HStack {
                if working { ProgressView().controlSize(.small) }
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Create") { submit() }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(problem != nil || project.isEmpty || working)
            }
        }
        .padding(20)
        .frame(width: 400)
        .task {
            await store.loadProjects()
            if project.isEmpty || !store.projects.contains(where: { $0.project == project }) {
                project = store.projects.first?.project ?? ""
            }
        }
    }

    private func submit() {
        working = true
        error = nil
        Task {
            let e = await store.newWorktree(project: project, branch: branch, base: base.trimmingCharacters(in: .whitespaces), start: start)
            working = false
            if let e { error = e } else { dismiss() }
        }
    }
}

struct RemovedSheet: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Recently Removed", systemImage: "arrow.uturn.backward").font(.headline)
            if store.removed.isEmpty {
                ContentUnavailableView("Nothing removed", systemImage: "tray")
                    .frame(maxWidth: .infinity, minHeight: 140)
            } else {
                List(store.removed) { r in
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(r.run).fontWeight(.semibold)
                            HStack(spacing: 6) {
                                if let b = r.branch {
                                    Label(b, systemImage: "arrow.triangle.branch").labelStyle(.titleAndIcon)
                                }
                                if let size = r.archiveSize { Text(humanBytes(size)).monospacedDigit() }
                                Text(Date(timeIntervalSince1970: TimeInterval(r.removedAt)), style: .relative)
                            }
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                        }
                        Spacer()
                        IconButton(symbol: "arrow.uturn.backward", label: "Restore", subject: r.run) {
                            Task { error = await store.restore(r.run) }
                        }
                    }
                }
                .frame(minHeight: 160)
            }
            if let error { Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 440)
        .task { await store.loadRemoved() }
    }
}
