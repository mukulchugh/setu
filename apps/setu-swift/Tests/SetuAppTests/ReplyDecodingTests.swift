import Foundation
import Testing
@testable import SetuApp

/// Every fixture is a real reply line captured from a sandbox daemon (no secret values).
/// The models decode leniently (unknown keys fall back to defaults), so these tests assert
/// actual values: a renamed field would otherwise pass silently and show blanks in the UI.
private func fixture(_ name: String) throws -> Data {
    let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
    return try Data(contentsOf: url)
}

@Test func runsList() throws {
    let runs: [Run] = try decodeReply(fixture("ls"))
    #expect(runs.count == 2)
    let main = try #require(runs.first { $0.run == "acme-web/main" })
    #expect(main.status == "running")
    #expect(main.isUp)
    #expect(main.url == "http://acme-web.acme.localhost:7777")
    #expect(main.ramBytes > 0)
    #expect(!main.staleEnv) // restarted after the env change when captured
    #expect(main.worktree.hasSuffix("/demo/main"))
    let stopped = try #require(runs.first { $0.run == "acme-web/feat-checkout-flow" })
    #expect(stopped.status == "stopped")
    #expect(!stopped.isUp)
}

@Test func staleEnvKeyMaps() throws {
    let line = Data(#"{"ok":true,"data":[{"run":"p/r","status":"running","stale_env":true,"ram_bytes":5,"pinned":true}]}"#.utf8)
    let runs: [Run] = try decodeReply(line)
    #expect(runs[0].staleEnv)
    #expect(runs[0].pinned)
    #expect(runs[0].ramBytes == 5)
}

@Test func envListMasksSecrets() throws {
    let g: EnvList = try decodeReply(fixture("env-list-global"))
    let v = try #require(g.vars.first { $0.name == "STRIPE_SECRET_KEY" })
    #expect(v.secret)
    // Stricter than the daemon: the app never keeps even a masked preview of a secret.
    #expect(v.preview == nil)
    let p: EnvList = try decodeReply(fixture("env-list-project"))
    let api = try #require(p.vars.first { $0.name == "API_BASE" })
    #expect(!api.secret)
    #expect(api.preview == "https://api.acme.dev")
}

@Test func envEffectiveSources() throws {
    let e: EnvEffective = try decodeReply(fixture("env-effective"))
    let port = try #require(e.vars.first { $0.name == "PORT" })
    #expect(port.source == "computed")
    let secret = try #require(e.vars.first { $0.name == "STRIPE_SECRET_KEY" })
    #expect(secret.source == "global")
    #expect(secret.secret)
}

@Test func diskReportUsesRealSize() throws {
    let d: DiskReport = try decodeReply(fixture("disk-report"))
    #expect(d.freeBytes > 0)
    let item = try #require(d.items.first { $0.item == "build-cache" })
    #expect(item.eligible)
    #expect(!item.reason.isEmpty)
    let size = try #require(item.size)
    #expect(size.logical >= 6_000_000)
    #expect(size.real > 0)
    #expect(d.cleanableBytes == size.real)
}

@Test func importPreviewNamesOnly() throws {
    let r: ImportReport = try decodeReply(fixture("env-import-preview"))
    #expect(r.imported == ["A", "B_TOKEN"])
    #expect(r.secrets == ["B_TOKEN"])
}

@Test func logsText() throws {
    let l: LogsReply = try decodeReply(fixture("logs"))
    #expect(!l.text.isEmpty)
}

@Test func daemonErrorMessageIsShown() throws {
    do {
        let _: Ignored = try decodeReply(fixture("error"))
        Issue.record("expected an error")
    } catch DaemonError.failed(let msg) {
        #expect(msg.contains("no run named nope"))
    }
}
