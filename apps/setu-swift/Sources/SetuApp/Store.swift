import AppKit
import Darwin
import Observation
import SwiftUI

enum Pane: String, CaseIterable, Identifiable {
    case runs, env, disk, setup
    var id: String { rawValue }
    var title: String {
        switch self {
        case .runs: "Runs"
        case .env: "Environments"
        case .disk: "Disk"
        case .setup: "Config"
        }
    }
    var symbol: String {
        switch self {
        case .runs: "play.square.stack"
        case .env: "list.bullet.rectangle"
        case .disk: "internaldrive"
        case .setup: "checklist"
        }
    }
}

/// Main-thread model. Plain data only: run state, masked previews, disk numbers.
/// No secret value is ever stored here.
@MainActor @Observable
final class Store {
    var daemonUp = true
    var loaded = false
    var runs: [Run] = []
    var disk: DiskReport?
    var checks: [Check]?
    var pane: Pane = {
        switch ProcessInfo.processInfo.environment["SETU_SECTION"] ?? "" {
        case "environments", "env": .env
        case "disk": .disk
        case "config", "setup": .setup
        default: .runs
        }
    }()
    var busy = 0
    var alertMessage: String?
    var showLogs = false
    var runSelection: Set<String> = []
    /// Plain-word reasons the daemon gave for refusing a removal.
    var refusal: Refusal?
    var projects: [ProjectInfo] = []
    var removed: [RemovedRun] = []

    @ObservationIgnored let daemon = Daemon()
    @ObservationIgnored private var poller: Task<Void, Never>?
    @ObservationIgnored private var windowVisible = false
    @ObservationIgnored private var menuVisible = false
    @ObservationIgnored private var checking = false
    /// Newest-wins: a slow reply to an older request must not overwrite a newer one.
    @ObservationIgnored private var refreshSeq = 0
    @ObservationIgnored private var diskSeq = 0
    /// Bumped when the window closes; replies that started before it are dropped.
    @ObservationIgnored private var windowEpoch = 0

    var upCount: Int { daemonUp ? runs.filter(\.isUp).count : 0 }
    var failingChecks: Int { checks?.filter { !$0.ok }.count ?? 0 }
    var cleanableBytes: UInt64 { disk?.cleanableBytes ?? 0 }

    var visible: Bool { windowVisible || menuVisible }

    func setWindowVisible(_ v: Bool) {
        windowVisible = v
        if v { nudge() } else { releaseWindowState() }
        if v, checks == nil { runDoctor() }
    }

    /// The window closed: drop everything only it needed so it costs nothing while hidden.
    private func releaseWindowState() {
        windowEpoch += 1
        diskSeq += 1
        disk = nil
        checks = nil
        showLogs = false
        runSelection = []
        alertMessage = nil
        refusal = nil
        removed = []
        projects = []
        pane = .runs
        nudge()
        // Hand the pages the window's views freed back to the system.
        Task {
            try? await Task.sleep(for: .seconds(1))
            malloc_zone_pressure_relief(nil, 0)
        }
    }

    func setMenuVisible(_ v: Bool) {
        menuVisible = v
        if v { nudge() }
    }

    // MARK: polling

    func startPolling() {
        guard poller == nil else { return }
        poller = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refresh()
                let secs: Double = self.visible ? 2 : 10
                try? await Task.sleep(for: .seconds(secs))
            }
        }
    }

    /// Visibility changed: look now instead of waiting out a slow tick.
    private func nudge() {
        poller?.cancel()
        poller = nil
        startPolling()
    }

    func refresh() async {
        refreshSeq += 1
        let seq = refreshSeq
        do {
            let r: [Run] = try await daemon.call(request("ls"), timeout: 5)
            guard seq == refreshSeq else { return }
            runs = r
            daemonUp = true
        } catch DaemonError.down {
            guard seq == refreshSeq else { return }
            daemonUp = false
            runs = []
        } catch {
            // Keep the last good list; the next tick tries again.
        }
        loaded = true
        runSelection.formIntersection(Set(runs.map(\.id)))
    }

    // MARK: work

    func work<T>(_ body: () async throws -> T) async -> T? {
        busy += 1
        defer { busy -= 1 }
        do { return try await body() } catch {
            alertMessage = (error as? LocalizedError)?.errorDescription ?? "Something went wrong."
            return nil
        }
    }

    func act(_ cmd: String, _ run: String) async {
        _ = await work { () -> Ignored in try await daemon.call(request(cmd, ["run": run])) }
        await refresh()
    }

    func act(_ cmd: String, _ runs: [Run]) async {
        for r in runs { await act(cmd, r.run) }
    }

    func startDaemon() {
        let p = setuProcess(["daemon"])
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch {
            alertMessage = "Could not start Setu."
            return
        }
        Task {
            try? await Task.sleep(for: .milliseconds(900))
            await refresh()
        }
    }

    func addWorktree() async {
        guard let url = await choose(files: false, message: "Choose a worktree folder to start") else { return }
        _ = await work { () -> Ignored in try await daemon.call(request("up", ["path": url.path])) }
        await refresh()
    }

    // MARK: worktree lifecycle

    func loadProjects() async {
        let epoch = windowEpoch
        if let p: [ProjectInfo] = try? await daemon.call(request("projects"), timeout: 10), epoch == windowEpoch { projects = p }
    }

    /// Create a worktree. Returns the daemon's message on failure so the sheet can show it inline.
    func newWorktree(project: String, branch: String, base: String, start: Bool) async -> String? {
        busy += 1
        defer { busy -= 1 }
        var f: [String: Any] = ["project": project, "branch": branch, "start": start]
        if !base.isEmpty { f["base"] = base }
        do {
            let _: Ignored = try await daemon.call(request("worktree.new", f))
            await refresh()
            return nil
        } catch {
            return (error as? LocalizedError)?.errorDescription ?? "Something went wrong."
        }
    }

    func removeWorktree(_ run: String) async {
        busy += 1
        defer { busy -= 1 }
        do {
            let _: RemoveReply = try await daemon.call(request("worktree.rm", ["run": run]))
        } catch {
            let m = (error as? LocalizedError)?.errorDescription ?? "Something went wrong."
            if let reasons = removalRefusals(m) { refusal = Refusal(run: run, reasons: reasons) } else { alertMessage = m }
        }
        await refresh()
    }

    /// The person at the app releases whatever claim is there (the CLI's `release` with no holder).
    func releaseClaim(_ run: String) async {
        _ = await work { () -> ReleaseReply in try await daemon.call(request("release", ["run": run])) }
        await refresh()
    }

    func setPinned(_ run: String, _ on: Bool) async {
        await act(on ? "pin" : "unpin", run)
    }

    func loadRemoved() async {
        let epoch = windowEpoch
        if let r: [RemovedRun] = try? await daemon.call(request("worktree.removed"), timeout: 10), epoch == windowEpoch { removed = r }
    }

    /// Restore a removed worktree. Returns the daemon's message on failure.
    func restore(_ run: String) async -> String? {
        busy += 1
        defer { busy -= 1 }
        do {
            let _: Ignored = try await daemon.call(request("worktree.restore", ["run": run]))
            await refresh()
            await loadRemoved()
            return nil
        } catch {
            return (error as? LocalizedError)?.errorDescription ?? "Something went wrong."
        }
    }

    func refreshDisk() async {
        diskSeq += 1
        let seq = diskSeq
        if let d: DiskReport = await work({ try await daemon.call(request("disk.report", ["deps": false])) }), seq == diskSeq {
            disk = d
        }
    }

    func freeDisk() async {
        if let r: CleanReport = await work({ try await daemon.call(request("disk.clean", ["apply": true])) }) {
            alertMessage = "Freed \(humanBytes(UInt64(max(0, r.freedBytes))))" + (r.failed > 0 ? ", \(r.failed) failed" : "")
        }
        await refreshDisk()
    }

    func runDoctor() {
        if checking { return }
        checking = true
        busy += 1
        let epoch = windowEpoch
        Task {
            let result = await Task.detached { Self.doctor() }.value
            if epoch == windowEpoch { checks = result }
            busy -= 1
            checking = false
        }
    }

    nonisolated private static func doctor() -> [Check] {
        let p = setuProcess(["doctor", "--json"])
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch {
            return [Check(name: "Config check", ok: false, detail: "Could not run setu.", fix: nil)]
        }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let text = String(decoding: data, as: UTF8.self)
        guard let start = text.firstIndex(of: "["),
              let arr = try? JSONSerialization.jsonObject(with: Data(text[start...].utf8)) as? [[String: Any]]
        else { return [Check(name: "Config check", ok: false, detail: "Config check returned nothing.", fix: nil)] }
        return arr.map {
            Check(name: $0["name"] as? String ?? "", ok: $0["ok"] as? Bool ?? false, detail: $0["detail"] as? String ?? "", fix: $0["fix"] as? String)
        }
    }

    func requestLogs(_ run: String) {
        pane = .runs
        runSelection = [run]
        showLogs = true
    }
}

struct Refusal: Identifiable {
    let run: String
    let reasons: [String]
    var id: String { run }
}

/// `setu` inside the bundle, next to the executable, or on PATH.
func setuURL() -> URL {
    if let exe = Bundle.main.executableURL {
        let dir = exe.deletingLastPathComponent()
        let bundled = dir.appendingPathComponent("../Resources/bin/setu").standardized
        if FileManager.default.isExecutableFile(atPath: bundled.path) { return bundled }
        let sibling = dir.appendingPathComponent("setu")
        if FileManager.default.isExecutableFile(atPath: sibling.path) { return sibling }
    }
    return URL(fileURLWithPath: "/usr/bin/env")
}

func setuProcess(_ args: [String]) -> Process {
    let p = Process()
    let u = setuURL()
    p.executableURL = u
    p.arguments = u.lastPathComponent == "env" ? ["setu"] + args : args
    return p
}

/// Open panel for a folder or a file.
@MainActor
func choose(files: Bool, message: String) async -> URL? {
    let panel = NSOpenPanel()
    panel.canChooseFiles = files
    panel.canChooseDirectories = !files
    panel.allowsMultipleSelection = false
    panel.showsHiddenFiles = files
    panel.message = message
    NSApp.activate()
    let resp = await panel.begin()
    return resp == .OK ? panel.url : nil
}

func openURL(_ s: String?) {
    if let s, let u = URL(string: s) { NSWorkspace.shared.open(u) }
}

func copyPlain(_ s: String) {
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.setString(s, forType: .string)
}

/// Copy marked concealed (clipboard managers skip it), clear after 30 s unless something
/// else was copied in the meantime.
@MainActor
func copyConcealed(_ value: String) {
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.setString(value, forType: .string)
    pb.setString("", forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
    let count = pb.changeCount
    Task { @MainActor in
        try? await Task.sleep(for: .seconds(30))
        if NSPasteboard.general.changeCount == count { NSPasteboard.general.clearContents() }
    }
}

// MARK: run presentation

func statusSymbol(_ r: Run) -> (name: String, color: Color, word: String) {
    switch r.status {
    case "running": ("circle.fill", .green, "Running")
    case "starting": ("circle.dotted", .orange, "Starting")
    case "stopping": ("circle.dotted", .orange, "Stopping")
    case "crashed": ("exclamationmark.circle.fill", .red, "Crashed")
    case "preparing": ("circle.dotted", .orange, "Preparing")
    case "setup-failed": ("exclamationmark.triangle.fill", .red, "Setup failed")
    case "no-server": ("minus.circle", .secondary, "No dev server")
    default: ("circle", .secondary, "Stopped")
    }
}
