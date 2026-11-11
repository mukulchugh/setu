import CoreGraphics
import Foundation

// usage: swift shot.swift <pid> <out-prefix>
// Captures each on-screen window owned by <pid> (by window ID only) to <out-prefix>-<n>.png.
let a = CommandLine.arguments
guard a.count == 3, let pid = Int32(a[1]) else { print("usage: shot.sh <pid> <out-prefix>"); exit(2) }
let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
var n = 0
for w in info where (w[kCGWindowOwnerPID as String] as? Int32) == pid {
    let layerNum = w[kCGWindowLayer as String] as? Int ?? 0
    let b = w[kCGWindowBounds as String] as? [String: Double] ?? [:]
    guard let id = w[kCGWindowNumber as String] as? Int, (b["Width"] ?? 0) > 50, (b["Height"] ?? 0) > 50 else { continue }
    n += 1
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    p.arguments = ["-x", "-o", "-l", String(id), "\(a[2])-\(n).png"]
    try? p.run(); p.waitUntilExit()
    print("window \(id) layer \(layerNum) -> \(a[2])-\(n).png")
}
if n == 0 { print("no on-screen windows for pid \(pid)"); exit(1) }
