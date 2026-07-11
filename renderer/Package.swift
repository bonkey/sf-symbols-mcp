// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "sfsymbols-render",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "sfsymbols-render", path: "Sources/sfsymbols-render")
    ]
)
