import AppKit
import SwiftUI

/// Setu brand assets in code. Source of truth: brand/BRAND.md, brand/glyph/*.svg, brand/palette.json.
enum Brand {
    /// Iris: the one brand hue. Light value on light surfaces, dark value on dark ones (BRAND.md contrast table).
    static let iris = Color(nsColor: NSColor(name: "SetuIris") { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0xB3 / 255.0, green: 0xA0 / 255.0, blue: 0xFF / 255.0, alpha: 1)
            : NSColor(srgbRed: 0x65 / 255.0, green: 0x50 / 255.0, blue: 0xC7 / 255.0, alpha: 1)
    })

    /// brand/glyph/setu-glyph.svg: three lanes rising into one span (stroked).
    static let glyphPath = "M2.5 8H5.2C8.8 8 9.2 4 13.2 4H15.5M2.5 11H5.2C9.2 11 9.4 4 13.2 4H15.5M2.5 14H5.2C9.6 14 9.6 4 13.2 4H15.5"
    /// brand/glyph/setu-glyph-fill.svg: the filled "running" variant.
    static let glyphFillPath = "M2.5 6.875H5.2C8.1 6.875 8.8 2.875 13.2 2.875H15.5Q16.625 2.875 16.625 4Q16.625 5.125 15.5 5.125H13.2C10.3 5.125 10.3 15.125 5.2 15.125H2.5Q1.375 15.125 1.375 14Q1.375 12.875 2.5 12.875H5.2C8.5 12.875 8.8 7.9 10.4 5.8C8.8 7.7 8.7 12.125 5.2 12.125H2.5Q1.375 12.125 1.375 11Q1.375 9.875 2.5 9.875H5.2C8 9.875 8.5 6.7 10 5.4C8.5 6.5 8.1 9.125 5.2 9.125H2.5Q1.375 9.125 1.375 8Q1.375 6.875 2.5 6.875Z"

    /// The menu-bar glyph as an 18 pt template image (the system tints it for light, dark and highlighted bars).
    static func glyph(running: Bool) -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { _ in
            let path = svgPath(running ? glyphFillPath : glyphPath)
            NSColor.black.set()
            if running {
                path.fill()
            } else {
                path.lineWidth = 1.5
                path.lineCapStyle = .round
                path.lineJoinStyle = .round
                path.stroke()
            }
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Setu"
        return image
    }

    /// Minimal parser for the absolute commands the brand SVGs use: M H C Q Z.
    static func svgPath(_ d: String) -> NSBezierPath {
        let path = NSBezierPath()
        let scanner = Scanner(string: d)
        scanner.charactersToBeSkipped = CharacterSet(charactersIn: " ,\n")
        var current = NSPoint.zero
        var command: Character = "M"
        func num() -> CGFloat { CGFloat(scanner.scanDouble() ?? 0) }
        while !scanner.isAtEnd {
            if let c = scanner.scanCharacter(), c.isLetter {
                command = c
            } else {
                scanner.currentIndex = d.index(before: scanner.currentIndex)
            }
            switch command {
            case "M":
                current = NSPoint(x: num(), y: num())
                path.move(to: current)
                command = "L"
            case "L":
                current = NSPoint(x: num(), y: num())
                path.line(to: current)
            case "H":
                current = NSPoint(x: num(), y: current.y)
                path.line(to: current)
            case "C":
                let c1 = NSPoint(x: num(), y: num()), c2 = NSPoint(x: num(), y: num())
                current = NSPoint(x: num(), y: num())
                path.curve(to: current, controlPoint1: c1, controlPoint2: c2)
            case "Q":
                // Quadratic to cubic: control points two thirds of the way toward the quad control.
                let q = NSPoint(x: num(), y: num()), end = NSPoint(x: num(), y: num())
                let c1 = NSPoint(x: current.x + 2 / 3 * (q.x - current.x), y: current.y + 2 / 3 * (q.y - current.y))
                let c2 = NSPoint(x: end.x + 2 / 3 * (q.x - end.x), y: end.y + 2 / 3 * (q.y - end.y))
                path.curve(to: end, controlPoint1: c1, controlPoint2: c2)
                current = end
            case "Z":
                path.close()
            default:
                return path
            }
        }
        return path
    }
}
