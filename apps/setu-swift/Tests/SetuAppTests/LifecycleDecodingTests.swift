import Foundation
import Testing
@testable import SetuApp

/// Fixtures are real reply lines captured over the socket from a sandbox daemon
/// (a temp project with a claimed run, a pending-removal run, a pinned run and one removed run).
private func fixture(_ name: String) throws -> Data {
    let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
    return try Data(contentsOf: url)
}

@Test func lsCarriesClaimRemovalAndPin() throws {
    let runs: [Run] = try decodeReply(fixture("ls-lifecycle"))
    #expect(runs.count == 3)

    let claimed = try #require(runs.first { $0.run == "acme/feat-claimed" })
    let claim = try #require(claimed.claim)
    #expect(claim.holder == "agent-a")
    #expect(!claim.stale)
    #expect((claim.pid ?? 0) > 0)
    #expect((claim.since ?? 0) > 1_700_000_000)
    #expect((claim.heartbeat ?? 0) >= (claim.since ?? 1))
    #expect(claim.tooltip == "Claimed by agent-a")
    #expect(claimed.removal == nil)

    let pending = try #require(runs.first { $0.run == "acme/feat-merged" })
    let removal = try #require(pending.removal)
    #expect(pending.claim == nil)
    #expect(removal.reason == "merged (ancestor), idle 0s")
    #expect(removal.removesAfter == removal.candidateSince + 3600) // grace = 1h in the sandbox
    // The countdown reads the real timestamps.
    #expect(removal.countdown(now: Date(timeIntervalSince1970: TimeInterval(removal.candidateSince))) == "removes in 1h")
    #expect(removal.countdown(now: Date(timeIntervalSince1970: TimeInterval(removal.removesAfter - 300))) == "removes in 5m")

    let pinned = try #require(runs.first { $0.run == "acme/feat-pinned" })
    #expect(pinned.pinned)
    #expect(pinned.removal == nil) // a pinned run is never listed for removal
}

@Test func staleClaimTooltip() throws {
    let line = Data(#"{"ok":true,"data":[{"run":"p/r","claim":{"holder":"agent-b","stale":true,"pid":9,"since":1,"heartbeat":2},"removal":null}]}"#.utf8)
    let runs: [Run] = try decodeReply(line)
    #expect(runs[0].claim?.tooltip == "Stale claim by agent-b")
    #expect(runs[0].removal == nil)
}

@Test func claimsList() throws {
    let c: [Claim] = try decodeReply(fixture("claims"))
    #expect(c.count == 1)
    #expect(c[0].run == "acme/feat-claimed")
    #expect(c[0].holder == "agent-a")
    let none: [Claim] = try decodeReply(fixture("claims-empty"))
    #expect(none.isEmpty)
}

@Test func projectsList() throws {
    let p: [ProjectInfo] = try decodeReply(fixture("projects"))
    #expect(p.count == 1)
    #expect(p[0].project == "acme")
    #expect(p[0].base == "origin/main")
}

@Test func removedList() throws {
    let r: [RemovedRun] = try decodeReply(fixture("worktree-removed"))
    #expect(r.count == 1)
    #expect(r[0].run == "acme/feat-gone")
    #expect(r[0].project == "acme")
    #expect(r[0].branch == "feat/gone")
    #expect(r[0].removedAt > 1_700_000_000)
    #expect(try #require(r[0].archive).hasSuffix(".tar"))
    #expect((r[0].archiveSize ?? 0) > 0)
}

@Test func removeAndReleaseReplies() throws {
    let rm: RemoveReply = try decodeReply(fixture("worktree-rm"))
    #expect(rm.removed)
    #expect(!rm.already)
    #expect(rm.archivedFiles == 1)
    let rel: ReleaseReply = try decodeReply(fixture("release"))
    #expect(rel.released)
    #expect(rel.holder == "agent-a")
}

@Test func newWorktreeReplyIsARun() throws {
    let r: Run = try decodeReply(fixture("worktree-new"))
    #expect(r.run == "acme/feat-merged")
    #expect(r.status == "running" || r.status == "starting")
}

@Test func newWorktreeErrorIsShownInline() throws {
    do {
        let _: Ignored = try decodeReply(fixture("worktree-new-error"))
        Issue.record("expected an error")
    } catch DaemonError.failed(let msg) {
        #expect(msg == "no project config named nope")
    }
}

@Test func removalRefusalReadsInPlainWords() throws {
    do {
        let _: RemoveReply = try decodeReply(fixture("worktree-rm-refused"))
        Issue.record("expected a refusal")
    } catch DaemonError.failed(let msg) {
        let reasons = try #require(removalRefusals(msg))
        #expect(reasons == ["Claimed by agent-a. Release the claim first."])
    }
}

@Test func refusalWithSeveralReasons() {
    let m = "refusing to remove: [dirty] 2 uncommitted or untracked file(s), e.g. a.txt, b.txt; [unpushed] 1 commit(s) are on no remote branch, e.g. abc fix; thing"
    let r = removalRefusals(m)
    #expect(r?.count == 2)
    #expect(r?[0] == "2 uncommitted or untracked file(s), e.g. a.txt, b.txt.")
    #expect(r?[1] == "1 commit(s) are on no remote branch, e.g. abc fix; thing.")
    #expect(removalRefusals("no run named x") == nil)
}

@Test func branchValidation() {
    #expect(branchProblem("") != nil)
    #expect(branchProblem("feat x") != nil)
    #expect(branchProblem("feat\tx") != nil)
    #expect(branchProblem("feat/x") == nil)
}
