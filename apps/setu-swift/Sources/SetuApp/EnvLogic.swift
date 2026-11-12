import Foundation
import Observation

/// The layer an env request targets. Hashable so a reply can be matched to the scope that asked.
struct EnvLayer: Hashable, Sendable {
    var scope: String
    var target: String?

    /// Wire fields for the daemon.
    var wire: [String: Any] {
        var m: [String: Any] = ["scope": scope]
        if let target { m["target"] = target }
        return m
    }
}

/// Loads rows for one scope at a time. A reply is applied only if it is still the newest
/// request, so a slow reply for a scope the user already left can never replace the rows of
/// the scope now on screen. `rowsScope` always names the scope `rows` came from; row actions
/// (edit, remove, reveal) must use it, not whatever scope is selected now.
@MainActor @Observable
final class EnvLoader {
    private(set) var rows: [EnvRow] = []
    private(set) var rowsScope: EnvLayer?
    private(set) var error: String?
    private(set) var loading = false
    @ObservationIgnored private var generation = 0

    /// `scope` nil means there is nothing to load (the rows are dropped).
    func load(_ scope: EnvLayer?, fetch: () async throws -> [EnvRow]) async {
        generation += 1
        let mine = generation
        if scope != rowsScope {
            rows = []
            rowsScope = scope
            error = nil
        }
        guard scope != nil else { loading = false; return }
        loading = true
        defer { if mine == generation { loading = false } }
        do {
            let fetched = try await fetch()
            guard mine == generation, !Task.isCancelled else { return }
            rows = fetched
            error = nil
        } catch is CancellationError {
        } catch {
            guard mine == generation, !Task.isCancelled else { return }
            rows = []
            self.error = (error as? LocalizedError)?.errorDescription ?? "Could not load."
        }
    }
}

extension ImportReport {
    /// Variables the file shares with the layer. A preview that does not overwrite reports them
    /// as `skipped`; one that does reports them as `overwritten`.
    var existing: [String] { skipped + overwritten }
    /// `imported` includes `overwritten`, so new variables are the rest.
    var newCount: Int { max(0, imported.count - overwritten.count) }
    var canOverwrite: Bool { !existing.isEmpty }

    var summary: String {
        var s = "\(newCount) new, \(existing.count) already set, \(secrets.count) secret."
        let fresh = imported.filter { !overwritten.contains($0) }
        if !fresh.isEmpty { s += "\nNew: " + fresh.prefix(30).joined(separator: ", ") }
        if !existing.isEmpty { s += "\nAlready set: " + existing.prefix(30).joined(separator: ", ") }
        if !problems.isEmpty { s += "\nProblems: " + problems.prefix(5).joined(separator: "; ") }
        return s
    }
}
