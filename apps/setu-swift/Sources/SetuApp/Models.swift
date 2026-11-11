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

    var id: String { run }
    var isUp: Bool { status == "running" || status == "starting" }
    var project: String { run.split(separator: "/", maxSplits: 1).first.map(String.init) ?? run }
    var name: String { run.split(separator: "/", maxSplits: 1).last.map(String.init) ?? run }

    enum CodingKeys: String, CodingKey {
        case run, url, status, pinned, ramBytes = "ram_bytes", worktree, note, staleEnv = "stale_env"
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
    }
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

/// One `setu-rs doctor --json` row.
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
