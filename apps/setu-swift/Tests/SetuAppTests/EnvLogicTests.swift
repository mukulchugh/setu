import Foundation
import Testing
@testable import SetuApp

private func row(_ n: String) -> EnvRow { EnvRow(name: n, secret: false, preview: n) }

/// Hands out replies the test completes by hand, in any order.
private actor Gate {
    private var waiting: [String: CheckedContinuation<[EnvRow], Never>] = [:]
    func wait(_ key: String) async -> [EnvRow] {
        await withCheckedContinuation { waiting[key] = $0 }
    }
    func release(_ key: String, _ rows: [EnvRow]) { waiting.removeValue(forKey: key)?.resume(returning: rows) }
    func isWaiting(_ key: String) -> Bool { waiting[key] != nil }
}

@MainActor
private func settle(_ gate: Gate, _ key: String) async {
    while !(await gate.isWaiting(key)) { await Task.yield() }
}

/// Finding 20: a slow reply for project A, finishing after project B's, must not replace B's rows.
@MainActor @Test func staleScopeReplyIsDropped() async throws {
    let loader = EnvLoader()
    let gate = Gate()
    let a = EnvLayer(scope: "project", target: "A")
    let b = EnvLayer(scope: "project", target: "B")
    let taskA = Task { await loader.load(a) { await gate.wait("A") } }
    await settle(gate, "A")
    // The user switches to B; SwiftUI cancels A's task, but the socket call cannot be interrupted.
    taskA.cancel()
    let taskB = Task { await loader.load(b) { await gate.wait("B") } }
    await settle(gate, "B")
    await gate.release("B", [row("FROM_B")])
    await taskB.value
    await gate.release("A", [row("FROM_A")])
    await taskA.value
    #expect(loader.rows.map(\.name) == ["FROM_B"])
    #expect(loader.rowsScope == b)
    #expect(!loader.loading)
}

/// The same race without cancellation (the old task is still running when the new one starts).
@MainActor @Test func olderRequestNeverWinsEvenUncancelled() async throws {
    let loader = EnvLoader()
    let gate = Gate()
    let a = EnvLayer(scope: "global")
    let b = EnvLayer(scope: "worktree", target: "p/b")
    let taskA = Task { await loader.load(a) { await gate.wait("A") } }
    await settle(gate, "A")
    let taskB = Task { await loader.load(b) { await gate.wait("B") } }
    await settle(gate, "B")
    await gate.release("B", [row("B1")])
    await taskB.value
    await gate.release("A", [row("A1")])
    await taskA.value
    #expect(loader.rows.map(\.name) == ["B1"])
}

/// Row actions read `rowsScope`; it must change together with the rows, not before the reply.
@MainActor @Test func rowsAreClearedWhenScopeChanges() async throws {
    let loader = EnvLoader()
    let a = EnvLayer(scope: "project", target: "A")
    let b = EnvLayer(scope: "project", target: "B")
    await loader.load(a) { [row("SHARED")] }
    #expect(loader.rowsScope == a)
    let gate = Gate()
    let t = Task { await loader.load(b) { await gate.wait("B") } }
    await settle(gate, "B")
    // While B is loading, A's row must not remain actionable under B.
    #expect(loader.rows.isEmpty)
    #expect(loader.rowsScope == b)
    await gate.release("B", [])
    await t.value
}

@MainActor @Test func sameScopeRefreshKeepsRows() async throws {
    let loader = EnvLoader()
    let a = EnvLayer(scope: "global")
    await loader.load(a) { [row("X")] }
    let gate = Gate()
    let t = Task { await loader.load(a) { await gate.wait("again") } }
    await settle(gate, "again")
    #expect(loader.rows.map(\.name) == ["X"])
    await gate.release("again", [row("Y")])
    await t.value
    #expect(loader.rows.map(\.name) == ["Y"])
}

@Test func layerWire() {
    let w = EnvLayer(scope: "project", target: "A").wire
    #expect(w["scope"] as? String == "project")
    #expect(w["target"] as? String == "A")
    #expect(EnvLayer(scope: "global").wire["target"] == nil)
}

// Finding 21. The daemon, for overwrite=false, lists collisions in `skipped` and leaves `overwritten` empty.
private func report(_ json: String) throws -> ImportReport {
    try JSONDecoder().decode(ImportReport.self, from: Data(json.utf8))
}

@Test func importPreviewOffersOverwriteForSkippedCollisions() throws {
    let r = try report(#"{"imported":["NEW"],"skipped":["DB_URL","API_KEY"],"overwritten":[],"secrets":[],"problems":[]}"#)
    #expect(r.canOverwrite)
    #expect(r.existing == ["DB_URL", "API_KEY"])
    #expect(r.newCount == 1)
    #expect(r.summary.hasPrefix("1 new, 2 already set"))
    #expect(r.summary.contains("DB_URL"))
}

@Test func importPreviewWithoutCollisionsHasNoOverwrite() throws {
    let r = try report(#"{"imported":["A","B"],"skipped":[],"overwritten":[],"secrets":["B"],"problems":[]}"#)
    #expect(!r.canOverwrite)
    #expect(r.newCount == 2)
}

@Test func overwritingReportCountsExistingOnce() throws {
    // overwrite=true: `imported` includes `overwritten`.
    let r = try report(#"{"imported":["NEW","OLD"],"skipped":[],"overwritten":["OLD"],"secrets":[],"problems":[]}"#)
    #expect(r.newCount == 1)
    #expect(r.existing == ["OLD"])
}
