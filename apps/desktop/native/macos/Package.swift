// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "F5ComputerHelper", platforms: [.macOS(.v14)], products: [.executable(name: "f5-computer-helper", targets: ["F5ComputerHelper"])], targets: [.target(name: "F5ComputerCore"), .executableTarget(name: "F5ComputerHelper", dependencies: ["F5ComputerCore"], linkerSettings: [.linkedFramework("AppKit"), .linkedFramework("ApplicationServices"), .linkedFramework("ScreenCaptureKit"), .linkedFramework("Carbon")]), .testTarget(name: "F5ComputerCoreTests", dependencies: ["F5ComputerCore"])])
