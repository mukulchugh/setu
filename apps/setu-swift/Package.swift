// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "SetuApp",
    platforms: [.macOS(.v26)],
    targets: [
        .executableTarget(name: "SetuApp", path: "Sources/SetuApp"),
        // Decodes real daemon replies captured from a sandbox daemon (no app launch needed).
        .testTarget(
            name: "SetuAppTests",
            dependencies: ["SetuApp"],
            path: "Tests/SetuAppTests",
            resources: [.copy("Fixtures")]
        ),
    ]
)
