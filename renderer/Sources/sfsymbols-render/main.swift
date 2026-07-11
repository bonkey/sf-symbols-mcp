// sfsymbols-render — deterministic SF Symbol bitmap renderer.
//
// Public APIs only: NSImage(systemSymbolName:) + NSImage.SymbolConfiguration.
// Renders each symbol as a normalized monochrome PNG: fixed canvas, regular
// weight, medium scale, glyph bounding box uniformly scaled into the padded
// content box and centered, pure black on opaque white, sRGB, 1x.
//
// Usage:
//   sfsymbols-render --out <dir> [--size 256] [--padding 24] [--names-file <path>]
//   (symbol names are read newline-delimited from stdin unless --names-file is given)
//
// Output: <out>/<symbol.name>.png per symbol + <out>/render-manifest.json.

import AppKit
import CryptoKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

let RENDERER_VERSION = "1"

// MARK: - Argument parsing

struct Options {
    var out: String = ""
    var size = 256
    var padding = 24
    var pointSize: CGFloat = 200
    var namesFile: String?
}

func parseOptions() -> Options {
    var opts = Options()
    var args = Array(CommandLine.arguments.dropFirst())
    while !args.isEmpty {
        let arg = args.removeFirst()
        func value(_ flag: String) -> String {
            guard !args.isEmpty else {
                FileHandle.standardError.write("missing value for \(flag)\n".data(using: .utf8)!)
                exit(2)
            }
            return args.removeFirst()
        }
        switch arg {
        case "--out": opts.out = value(arg)
        case "--size": opts.size = Int(value(arg)) ?? 256
        case "--padding": opts.padding = Int(value(arg)) ?? 24
        case "--point-size": opts.pointSize = CGFloat(Double(value(arg)) ?? 200)
        case "--names-file": opts.namesFile = value(arg)
        default:
            FileHandle.standardError.write("unknown argument: \(arg)\n".data(using: .utf8)!)
            exit(2)
        }
    }
    if opts.out.isEmpty {
        FileHandle.standardError.write("--out <dir> is required\n".data(using: .utf8)!)
        exit(2)
    }
    return opts
}

// MARK: - Rendering

struct GlyphBounds {
    let minX: Int, minY: Int, maxX: Int, maxY: Int
    var width: Int { maxX - minX + 1 }
    var height: Int { maxY - minY + 1 }
}

let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

func makeContext(size: Int) -> CGContext {
    guard
        let ctx = CGContext(
            data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
            space: sRGB, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { fatalError("cannot create CGContext") }
    return ctx
}

func draw(image: NSImage, in rect: CGRect, context: CGContext) {
    let previous = NSGraphicsContext.current
    NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
    image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
    NSGraphicsContext.current = previous
}

/// Scan the alpha channel for the tight bounding box of drawn pixels.
/// Bitmap memory is top-down while CG drawing coordinates are bottom-up, so
/// the y axis is flipped here to return bounds in drawing coordinates.
func alphaBounds(of ctx: CGContext) -> GlyphBounds? {
    guard let data = ctx.data else { return nil }
    let width = ctx.width, height = ctx.height, stride = ctx.bytesPerRow
    let pixels = data.bindMemory(to: UInt8.self, capacity: stride * height)
    var minX = Int.max, minY = Int.max, maxX = -1, maxY = -1
    for row in 0..<height {
        let y = height - 1 - row
        for x in 0..<width {
            let alpha = pixels[row * stride + x * 4 + 3]
            if alpha > 8 {
                if x < minX { minX = x }
                if x > maxX { maxX = x }
                if y < minY { minY = y }
                if y > maxY { maxY = y }
            }
        }
    }
    guard maxX >= 0 else { return nil }
    return GlyphBounds(minX: minX, minY: minY, maxX: maxX, maxY: maxY)
}

enum RenderError: Error {
    case unknownSymbol
    case emptyGlyph
    case encodingFailed
}

func renderSymbol(_ name: String, opts: Options) throws -> Data {
    guard let base = NSImage(systemSymbolName: name, accessibilityDescription: nil) else {
        throw RenderError.unknownSymbol
    }
    let config = NSImage.SymbolConfiguration(
        pointSize: opts.pointSize, weight: .regular, scale: .medium
    ).applying(.preferringMonochrome())
    guard let symbol = base.withSymbolConfiguration(config) else {
        throw RenderError.unknownSymbol
    }

    // Pass 1: rasterize aspect-fit into a measurement canvas and find the
    // tight glyph bounding box. Symbol images are templates: they draw black
    // on transparent, which is exactly the normalized form we want.
    let measure = opts.size * 2
    let measureCtx = makeContext(size: measure)
    let natural = symbol.size
    guard natural.width > 0, natural.height > 0 else { throw RenderError.emptyGlyph }
    let fit = min(CGFloat(measure) / natural.width, CGFloat(measure) / natural.height)
    let measureRect = CGRect(
        x: (CGFloat(measure) - natural.width * fit) / 2,
        y: (CGFloat(measure) - natural.height * fit) / 2,
        width: natural.width * fit,
        height: natural.height * fit)
    draw(image: symbol, in: measureRect, context: measureCtx)
    guard let bounds = alphaBounds(of: measureCtx) else { throw RenderError.emptyGlyph }

    // Pass 2: map the measured bbox into the padded content box of the final
    // canvas: uniform scale so the larger bbox dimension fills the content
    // box, bbox center at canvas center.
    // The measured bbox is in measurement-canvas pixels, where the image was
    // drawn at measureRect. Scaling the whole drawing by `scale` and
    // translating so the bbox center lands at the canvas center maps
    // measureRect to drawRect.
    let canvas = CGFloat(opts.size)
    let content = canvas - 2 * CGFloat(opts.padding)
    let scale = content / CGFloat(max(bounds.width, bounds.height))
    let bboxCenterX = (CGFloat(bounds.minX) + CGFloat(bounds.maxX) + 1) / 2
    let bboxCenterY = (CGFloat(bounds.minY) + CGFloat(bounds.maxY) + 1) / 2
    let translateX = canvas / 2 - bboxCenterX * scale
    let translateY = canvas / 2 - bboxCenterY * scale
    let drawRect = CGRect(
        x: measureRect.minX * scale + translateX,
        y: measureRect.minY * scale + translateY,
        width: measureRect.width * scale,
        height: measureRect.height * scale)

    let finalCtx = makeContext(size: opts.size)
    finalCtx.setFillColor(CGColor(colorSpace: sRGB, components: [1, 1, 1, 1])!)
    finalCtx.fill(CGRect(x: 0, y: 0, width: canvas, height: canvas))
    draw(image: symbol, in: drawRect, context: finalCtx)

    guard let cgImage = finalCtx.makeImage() else { throw RenderError.encodingFailed }
    let out = NSMutableData()
    guard
        let dest = CGImageDestinationCreateWithData(
            out, UTType.png.identifier as CFString, 1, nil)
    else { throw RenderError.encodingFailed }
    CGImageDestinationAddImage(dest, cgImage, nil)
    guard CGImageDestinationFinalize(dest) else { throw RenderError.encodingFailed }
    return out as Data
}

// MARK: - Manifest

struct Manifest: Codable {
    let rendererVersion: String
    let macosVersion: String
    let config: Config
    let renderedCount: Int
    let failed: [String]
    let hashes: [String: String]

    struct Config: Codable {
        let size: Int
        let padding: Int
        let pointSize: Double
        let weight: String
        let scale: String
        let mode: String
    }
}

// MARK: - Main

let opts = parseOptions()

let namesInput: String
if let namesFile = opts.namesFile {
    namesInput = try String(contentsOfFile: namesFile, encoding: .utf8)
} else {
    namesInput = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? ""
}
let names = namesInput.split(whereSeparator: \.isNewline).map(String.init).filter { !$0.isEmpty }

guard !names.isEmpty else {
    FileHandle.standardError.write("no symbol names provided\n".data(using: .utf8)!)
    exit(2)
}

let outDir = URL(fileURLWithPath: opts.out, isDirectory: true)
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

var failed: [String] = []
var hashes: [String: String] = [:]
var done = 0

for name in names {
    do {
        let png = try renderSymbol(name, opts: opts)
        let file = outDir.appendingPathComponent("\(name).png")
        try png.write(to: file)
        hashes[name] = SHA256.hash(data: png).map { String(format: "%02x", $0) }.joined()
    } catch {
        failed.append(name)
    }
    done += 1
    if done % 500 == 0 {
        FileHandle.standardError.write("rendered \(done)/\(names.count)\n".data(using: .utf8)!)
    }
}

let manifest = Manifest(
    rendererVersion: RENDERER_VERSION,
    macosVersion: ProcessInfo.processInfo.operatingSystemVersionString,
    config: .init(
        size: opts.size, padding: opts.padding, pointSize: Double(opts.pointSize),
        weight: "regular", scale: "medium", mode: "monochrome"),
    renderedCount: hashes.count,
    failed: failed.sorted(),
    hashes: hashes)

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
try encoder.encode(manifest).write(to: outDir.appendingPathComponent("render-manifest.json"))

FileHandle.standardError.write(
    "done: \(hashes.count) rendered, \(failed.count) failed\n".data(using: .utf8)!)
exit(failed.count == names.count ? 1 : 0)
