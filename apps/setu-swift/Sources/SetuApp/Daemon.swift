import Foundation

/// Errors from the socket. `down` means nothing is listening.
enum DaemonError: LocalizedError {
    case down
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .down: "Setu isn't running."
        case .failed(let m): m
        }
    }
}

/// Reply envelope: `{"ok":true,"data":...}` or `{"ok":false,"error":"..."}`.
private struct Reply<T: Decodable>: Decodable {
    var ok: Bool
    var data: T?
    var error: String?
}

/// Reply data we do not read.
struct Ignored: Decodable, Sendable {
    init() {}
    init(from decoder: Decoder) throws {}
}

/// Unwrap one reply line: the data on success, the daemon's own message on failure.
func decodeReply<T: Decodable>(_ line: Data) throws -> T {
    let reply: Reply<T>
    do {
        reply = try JSONDecoder().decode(Reply<T>.self, from: line)
    } catch {
        throw DaemonError.failed("Unexpected reply from Setu.")
    }
    guard reply.ok else { throw DaemonError.failed(reply.error ?? "Request failed.") }
    if let d = reply.data { return d }
    if let i = Ignored() as? T { return i }
    throw DaemonError.failed("Empty reply from Setu.")
}

/// Same rule as the daemon's `paths::socket_path()`.
func socketPath() -> String {
    let env = ProcessInfo.processInfo.environment
    if let home = env["SETU_HOME"], !home.isEmpty {
        return home + "/state/d.sock"
    }
    let h = env["HOME"] ?? "/"
    return h + "/Library/Application Support/Setu/d.sock"
}

/// Build one request line. Every request says it is the app. The bytes may hold a secret
/// value, so they are never printed or logged anywhere.
func request(_ cmd: String, _ fields: [String: Any] = [:]) -> Data {
    var m = fields
    m["cmd"] = cmd
    m["actor"] = "app"
    return (try? JSONSerialization.data(withJSONObject: m)) ?? Data()
}

/// One request, one reply, a fresh connection each time.
actor Daemon {
    func call<T: Decodable & Sendable>(_ req: Data, as type: T.Type = T.self, timeout: Int = 180) async throws -> T {
        let path = socketPath()
        var line: Data
        do {
            line = try await Self.exchange(path: path, req: req, timeout: timeout)
        } catch DaemonError.down {
            // A daemon that was just started may not have bound its socket yet.
            try? await Task.sleep(for: .milliseconds(200))
            line = try await Self.exchange(path: path, req: req, timeout: timeout)
        }
        return try decodeReply(line)
    }

    private static func exchange(path: String, req: Data, timeout: Int) async throws -> Data {
        try await withCheckedThrowingContinuation { cont in
            DispatchQueue.global(qos: .utility).async {
                do { cont.resume(returning: try blockingExchange(path: path, req: req, timeout: timeout)) }
                catch { cont.resume(throwing: error) }
            }
        }
    }
}

private func blockingExchange(path: String, req: Data, timeout: Int) throws -> Data {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw DaemonError.down }
    defer { close(fd) }
    var one: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    var snd = timeval(tv_sec: 5, tv_usec: 0)
    var rcv = timeval(tv_sec: timeout, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &snd, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &rcv, socklen_t(MemoryLayout<timeval>.size))

    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    guard bytes.count <= 103 else { throw DaemonError.failed("Socket path is too long.") }
    withUnsafeMutableBytes(of: &addr.sun_path) { buf in
        for (i, b) in bytes.enumerated() { buf[i] = b }
        buf[bytes.count] = 0
    }
    let rc = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard rc == 0 else { throw DaemonError.down }

    var out = req
    out.append(0x0A)
    try out.withUnsafeBytes { raw in
        var off = 0
        while off < raw.count {
            let n = write(fd, raw.baseAddress! + off, raw.count - off)
            if n <= 0 { throw DaemonError.failed("Could not send to Setu.") }
            off += n
        }
    }
    var reply = Data()
    var chunk = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
        let n = read(fd, &chunk, chunk.count)
        if n < 0 { throw DaemonError.failed("No reply from Setu.") }
        if n == 0 { break }
        reply.append(chunk, count: n)
        if chunk[n - 1] == 0x0A { break }
    }
    if reply.isEmpty { throw DaemonError.failed("Setu closed the connection.") }
    return reply
}
