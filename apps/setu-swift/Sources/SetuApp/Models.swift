import Foundation

extension KeyedDecodingContainer {
    func val<T: Decodable>(_ key: Key, _ fallback: T) -> T {
        (try? decodeIfPresent(T.self, forKey: key)) ?? fallback
    }
}

struct Proc: Decodable, Sendable, Hashable {
    var name: String
    var pid: Int
}

/// One entry of `ls`.
struct Run: Decodable, Sendable, Hashable, Identifiable {
    var run: String
    var url: String?
    var status: String
    var pinned: Bool
    var ramBytes: UInt64
    var worktree: String
    var note: String?
    var staleEnv: Bool
    /// A writer (usually an agent) that claimed this worktree, or nil.
    var claim: Claim?
    /// Set while auto-removal has the worktree on its list and it is not pinned.
    var removal: Removal?

    var id: String { run }
    var isUp: Bool { status == "running" || status == "starting" }
    /// A project with no `[procs]` has nothing to start and no URL (`status == "no-server"`).
    var canStart: Bool { !isUp && status != "no-server" }
    var project: String { run.split(separator: "/", maxSplits: 1).first.map(String.init) ?? run }
    var name: String { run.split(separator: "/", maxSplits: 1).last.map(String.init) ?? run }

    enum CodingKeys: String, CodingKey {
        case run, url, status, pinned, ramBytes = "ram_bytes", worktree, note, staleEnv = "stale_env", claim, removal
    }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        run = c.val(.run, "")
        url = try? c.decodeIfPresent(String.self, forKey: .url)
        status = c.val(.status, "stopped")
        pinned = c.val(.pinned, false)
        ramBytes = c.val(.ramBytes, 0)
        worktree = c.val(.worktree, "")
        note = try? c.decodeIfPresent(String.self, forKey: .note)
        staleEnv = c.val(.staleEnv, false)
        claim = try? c.decodeIfPresent(Claim.self, forKey: .claim)
        removal = try? c.decodeIfPresent(Removal.self, forKey: .removal)
    }
}

/// `claim` of an `ls` entry, and one row of `claims`.
struct Claim: Decodable, Sendable, Hashable {
    /// Only in the `claims` list; empty inside an `ls` entry.
    var run: String
    var holder: String
    var stale: Bool
    var pid: Int?
    var since: UInt64?
    var heartbeat: UInt64?
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        run = c.val(.run, "")
        holder = c.val(.holder, "")
        stale = c.val(.stale, false)
        pid = try? c.decodeIfPresent(Int.self, forKey: .pid)
        since = try? c.decodeIfPresent(UInt64.self, forKey: .since)
        heartbeat = try? c.decodeIfPresent(UInt64.self, forKey: .heartbeat)
    }
    enum CodingKeys: String, CodingKey { case run, holder, stale, pid, since, heartbeat }

    var tooltip: String { stale ? "Stale claim by \(holder)" : "Claimed by \(holder)" }
}

/// `removal` of an `ls` entry: when auto-removal listed the worktree, when it goes, and why.
struct Removal: Decodable, Sendable, Hashable {
    var candidateSince: UInt64
    var removesAfter: UInt64
    var reason: String
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        candidateSince = c.val(.candidateSince, 0)
        removesAfter = c.val(.removesAfter, 0)
        reason = c.val(.reason, "")
    }
    enum CodingKeys: String, CodingKey { case candidateSince = "candidate_since", removesAfter = "removes_after", reason }

    func countdown(now: Date = Date()) -> String { removesIn(removesAfter, now: now) }
}

/// "removes in 5h" style words for a unix time in the future.
func removesIn(_ at: UInt64, now: Date = Date()) -> String {
    let left = Int64(at) - Int64(now.timeIntervalSince1970)
    switch left {
    case ..<1: return "removing soon"
    case ..<60: return "removes in <1m"
    case ..<3600: return "removes in \(left / 60)m"
    case ..<86400: return "removes in \(left / 3600)h"
    default: return "removes in \(left / 86400)d"
    }
}

/// One entry of `projects`.
struct ProjectInfo: Decodable, Sendable, Hashable, Identifiable {
    var project: String
    /// The project's own `[worktree] base`, or nil when Setu picks one.
    var base: String?
    var id: String { project }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        project = c.val(.project, "")
        base = try? c.decodeIfPresent(String.self, forKey: .base)
    }
    enum CodingKeys: String, CodingKey { case project, base }
}

/// One entry of `worktree.removed`: a removed worktree that can be restored.
struct RemovedRun: Decodable, Sendable, Hashable, Identifiable {
    var run: String
    var project: String
    var branch: String?
    var removedAt: UInt64
    var archive: String?
    /// Nil once the archive was pruned: only the branch comes back.
    var archiveSize: UInt64?
    var id: String { run }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        run = c.val(.run, "")
        project = c.val(.project, "")
        branch = try? c.decodeIfPresent(String.self, forKey: .branch)
        removedAt = c.val(.removedAt, 0)
        archive = try? c.decodeIfPresent(String.self, forKey: .archive)
        archiveSize = try? c.decodeIfPresent(UInt64.self, forKey: .archiveSize)
    }
    enum CodingKeys: String, CodingKey { case run, project, branch, removedAt = "removed_at", archive, archiveSize = "archive_size" }
}

/// `release` reply.
struct ReleaseReply: Decodable, Sendable {
    var released: Bool
    var holder: String?
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        released = c.val(.released, false)
        holder = try? c.decodeIfPresent(String.self, forKey: .holder)
    }
    enum CodingKeys: String, CodingKey { case released, holder }
}

/// `worktree.rm` reply.
struct RemoveReply: Decodable, Sendable {
    var removed: Bool
    var already: Bool
    var archivedFiles: Int
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        removed = c.val(.removed, false)
        already = c.val(.already, false)
        archivedFiles = c.val(.archivedFiles, 0)
    }
    enum CodingKeys: String, CodingKey { case removed, already, archivedFiles = "archived_files" }
}

/// Why the new-worktree form can't submit yet, or nil. The daemon still has the last word.
func branchProblem(_ branch: String) -> String? {
    if branch.isEmpty { return "Enter a branch name." }
    if branch.contains(where: \.isWhitespace) { return "A branch name can't have spaces." }
    return nil
}

/// The daemon refuses a removal with `refusing to remove: [code] message; [code] message`.
/// Returns one plain sentence per reason; nil when the message is some other error.
func removalRefusals(_ message: String) -> [String]? {
    let prefix = "refusing to remove: "
    guard message.hasPrefix(prefix) else { return nil }
    let body = String(message.dropFirst(prefix.count))
    let codes = ["main", "dirty", "unpushed", "fetch", "processes", "claim", "running"]
    // Split at each "[code] " marker; reason text may itself contain "; ".
    var marks: [(code: String, start: String.Index, textStart: String.Index)] = []
    for code in codes {
        var from = body.startIndex
        while let r = body.range(of: "[\(code)] ", range: from..<body.endIndex) {
            marks.append((code, r.lowerBound, r.upperBound))
            from = r.upperBound
        }
    }
    marks.sort { $0.start < $1.start }
    guard !marks.isEmpty else { return [message] }
    var out: [String] = []
    for (i, m) in marks.enumerated() {
        let end = i + 1 < marks.count ? marks[i + 1].start : body.endIndex
        var text = String(body[m.textStart..<end]).trimmingCharacters(in: .whitespaces)
        if text.hasSuffix(";") { text.removeLast() }
        if m.code == "claim", let r = text.range(of: "held by ") {
            let holder = text[r.upperBound...].prefix { $0 != ";" && $0 != " " }
            out.append("Claimed by \(holder). Release the claim first.")
            continue
        }
        out.append(text.prefix(1).uppercased() + text.dropFirst() + ".")
    }
    return out
}

struct EnvVar: Decodable, Sendable, Hashable {
    var name: String
    var secret: Bool
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        name = c.val(.name, "")
        secret = c.val(.secret, false)
        // The daemon's masked preview is read only for plain variables.
        preview = secret ? nil : (try? c.decodeIfPresent(String.self, forKey: .preview))
    }
    var preview: String?
    enum CodingKeys: String, CodingKey { case name, secret, preview }
}

struct EnvList: Decodable, Sendable {
    var vars: [EnvVar]
    init(from d: Decoder) throws {
        vars = try d.container(keyedBy: CodingKeys.self).val(.vars, [])
    }
    enum CodingKeys: String, CodingKey { case vars }
}

struct EffectiveVar: Decodable, Sendable, Hashable {
    var name: String
    var source: String
    var overrides: [String]
    var secret: Bool
    var preview: String?
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        name = c.val(.name, "")
        source = c.val(.source, "")
        overrides = c.val(.overrides, [])
        secret = c.val(.secret, false)
        preview = secret ? nil : (try? c.decodeIfPresent(String.self, forKey: .preview))
    }
    enum CodingKeys: String, CodingKey { case name, source, overrides, secret, preview }
}

struct EnvEffective: Decodable, Sendable {
    var vars: [EffectiveVar]
    init(from d: Decoder) throws {
        vars = try d.container(keyedBy: CodingKeys.self).val(.vars, [])
    }
    enum CodingKeys: String, CodingKey { case vars }
}

struct ImportReport: Decodable, Sendable {
    var imported: [String]
    var skipped: [String]
    var overwritten: [String]
    var secrets: [String]
    var problems: [String]
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        imported = c.val(.imported, [])
        skipped = c.val(.skipped, [])
        overwritten = c.val(.overwritten, [])
        secrets = c.val(.secrets, [])
        problems = c.val(.problems, [])
    }
    enum CodingKeys: String, CodingKey { case imported, skipped, overwritten, secrets, problems }
}

/// The one reply that carries a value. Never printed, never stored in the model.
struct Reveal: Decodable, Sendable {
    var value: String
    init(from d: Decoder) throws {
        value = try d.container(keyedBy: CodingKeys.self).val(.value, "")
    }
    enum CodingKeys: String, CodingKey { case value }
}

struct Size: Decodable, Sendable, Hashable {
    var logical: UInt64
    /// Bytes not shared with any other file (APFS clones counted once): what deleting frees.
    var real: UInt64
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        logical = c.val(.logical, 0)
        real = c.val(.real, logical)
    }
    enum CodingKeys: String, CodingKey { case logical, real = "private" }
}

struct DiskItem: Decodable, Sendable, Hashable, Identifiable {
    var run: String
    var item: String
    var path: String
    var size: Size?
    var eligible: Bool
    var reason: String
    var id: String { path }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        run = c.val(.run, "")
        item = c.val(.item, "")
        path = c.val(.path, "")
        size = try? c.decodeIfPresent(Size.self, forKey: .size)
        eligible = c.val(.eligible, false)
        reason = c.val(.reason, "")
    }
    enum CodingKeys: String, CodingKey { case run, item, path, size, eligible, reason }
}

struct DiskWorktree: Decodable, Sendable {
    var items: [DiskItem]
    init(from d: Decoder) throws {
        items = try d.container(keyedBy: CodingKeys.self).val(.items, [])
    }
    enum CodingKeys: String, CodingKey { case items }
}

struct DiskStore: Decodable, Sendable, Hashable, Identifiable {
    var project: String
    var name: String
    var path: String
    var logical: UInt64
    var id: String { path }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        project = c.val(.project, "")
        name = c.val(.name, "")
        path = c.val(.path, "")
        logical = c.val(.logical, 0)
    }
    enum CodingKeys: String, CodingKey { case project, name, path, logical }
}

struct DiskReport: Decodable, Sendable {
    var freeBytes: UInt64
    var worktrees: [DiskWorktree]
    var stores: [DiskStore]
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        freeBytes = c.val(.freeBytes, 0)
        worktrees = c.val(.worktrees, [])
        stores = c.val(.stores, [])
    }
    enum CodingKeys: String, CodingKey { case freeBytes = "free_bytes", worktrees, stores }

    var items: [DiskItem] { worktrees.flatMap(\.items) }
    var cleanable: [DiskItem] { items.filter(\.eligible) }
    var cleanableBytes: UInt64 { cleanable.reduce(0) { $0 + ($1.size?.real ?? 0) } }
}

struct CleanReport: Decodable, Sendable {
    var freedBytes: Int64
    var failed: Int
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        freedBytes = c.val(.freedBytes, 0)
        let items: [CleanedItem] = c.val(.items, [])
        failed = items.filter { $0.error != nil }.count
    }
    enum CodingKeys: String, CodingKey { case freedBytes = "freed_bytes", items }
}

struct CleanedItem: Decodable, Sendable {
    var error: String?
}

/// One `setu doctor --json` row.
struct Check: Sendable, Identifiable, Hashable {
    var name: String
    var ok: Bool
    var detail: String
    var fix: String?
    var id: String { name }
}

func humanBytes(_ n: UInt64) -> String {
    let u = ["B", "KB", "MB", "GB", "TB"]
    var v = Double(n)
    var i = 0
    while v >= 1024, i < u.count - 1 { v /= 1024; i += 1 }
    return i == 0 ? "\(n) B" : String(format: "%.1f %@", v, u[i])
}

/// Plain words for the daemon's item names.
func plainItem(_ item: String) -> String {
    switch item {
    case "next-dev-cache": "Next.js dev cache"
    case "next-dev-output": "Next.js dev build"
    case "node_modules": "Dependencies"
    case ".next": "Next.js build"
    case ".turbo": "Turbo cache"
    case "dist", "build": "Build output"
    case ".cache": "Cache"
    case "target": "Rust build"
    default: item
    }
}

/// Same rule as the daemon's `is_secret_name`, so the switch matches what would be stored.
func isSecretName(_ name: String) -> Bool {
    let u = name.uppercased()
    return ["KEY", "TOKEN", "SECRET", "PASSWORD"].contains { u.contains($0) } || u.hasSuffix("PASS") || u == "DATABASE_URL" || u.hasSuffix("_DSN")
}
