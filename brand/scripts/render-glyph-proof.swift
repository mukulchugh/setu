import Foundation
import CoreGraphics
import ImageIO

// Headless rendering of the actual SVG paths, with no window or application.
let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let space = CGColorSpaceCreateDeviceRGB()

func bitmap(_ width: Int, _ height: Int) -> CGContext {
    guard let context = CGContext(data: nil, width: width, height: height,
        bitsPerComponent: 8, bytesPerRow: width * 4, space: space,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        fatalError("Cannot create raster context")
    }
    return context
}

func pathFromSVG(_ name: String) throws -> CGPath {
    let svg = try String(contentsOf: root.appendingPathComponent("glyph/" + name), encoding: .utf8)
    let expression = try NSRegularExpression(pattern: "\\bd=\"([^\"]+)\"")
    let range = NSRange(svg.startIndex..., in: svg)
    guard let match = expression.firstMatch(in: svg, range: range),
          let pathRange = Range(match.range(at: 1), in: svg) else { fatalError("Missing SVG path") }
    let data = String(svg[pathRange])
    let tokenExpression = try NSRegularExpression(pattern: "[A-Za-z]|[-+]?(?:[0-9]*\\.[0-9]+|[0-9]+)")
    let tokens = tokenExpression.matches(in: data, range: NSRange(data.startIndex..., in: data))
        .map { String(data[Range($0.range, in: data)!]) }
    var index = 0
    func value() -> CGFloat {
        guard index < tokens.count, let number = Double(tokens[index]) else { fatalError("Invalid path value") }
        index += 1
        return CGFloat(number)
    }
    func point() -> CGPoint { CGPoint(x: value(), y: value()) }
    let path = CGMutablePath()
    while index < tokens.count {
        let command = tokens[index]
        index += 1
        switch command {
        case "M": path.move(to: point())
        case "H": path.addLine(to: CGPoint(x: value(), y: path.currentPoint.y))
        case "C":
            let first = point(), second = point(), end = point()
            path.addCurve(to: end, control1: first, control2: second)
        case "Q":
            let control = point(), end = point()
            path.addQuadCurve(to: end, control: control)
        case "Z": path.closeSubpath()
        default: fatalError("Unsupported path command: " + command)
        }
    }
    return path
}

let regular = try pathFromSVG("setu-glyph.svg")
let filled = try pathFromSVG("setu-glyph-fill.svg")
let proof = bitmap(640, 352)

for appearance in 0...1 {
    let isDark = appearance == 1
    let background = isDark ? CGColor(red: 25/255, green: 23/255, blue: 31/255, alpha: 1)
                            : CGColor(gray: 1, alpha: 1)
    proof.setFillColor(background)
    proof.fill(CGRect(x: appearance * 320, y: 0, width: 320, height: 352))
    for (row, size) in [16, 18].enumerated() {
        for variant in 0...1 {
            let glyph = bitmap(size, size)
            glyph.setFillColor(background)
            glyph.fill(CGRect(x: 0, y: 0, width: size, height: size))
            glyph.translateBy(x: 0, y: CGFloat(size))
            glyph.scaleBy(x: CGFloat(size) / 18, y: -CGFloat(size) / 18)
            let ink = CGColor(gray: isDark ? 1 : 0, alpha: 1)
            glyph.setStrokeColor(ink)
            glyph.setFillColor(ink)
            glyph.setLineWidth(1.5)
            glyph.setLineCap(.round)
            glyph.setLineJoin(.round)
            glyph.addPath(variant == 0 ? regular : filled)
            glyph.drawPath(using: variant == 0 ? .stroke : .fill)
            guard let image = glyph.makeImage() else { fatalError("Cannot render glyph") }
            proof.interpolationQuality = .none
            let pixels = size * 8
            proof.draw(image, in: CGRect(x: appearance * 320 + variant * 160 + (160 - pixels) / 2,
                y: row == 0 ? 192 : 16, width: pixels, height: pixels))
        }
    }
}

let output = root.appendingPathComponent("glyph/proof.png")
guard let image = proof.makeImage(),
      let destination = CGImageDestinationCreateWithURL(output as CFURL, "public.png" as CFString, 1, nil) else {
    fatalError("Cannot create proof PNG")
}
CGImageDestinationAddImage(destination, image, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("Cannot write proof PNG") }
print("Rendered glyph/proof.png: 16px top, 18px bottom; regular then filled, at 8x nearest-neighbour magnification")
