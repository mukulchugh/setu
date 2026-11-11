import AppKit
import Testing
@testable import SetuApp

@Test func brandGlyphsParseInsideCanvas() {
    for d in [Brand.glyphPath, Brand.glyphFillPath] {
        let p = Brand.svgPath(d)
        #expect(p.elementCount > 10)
        let b = p.bounds
        #expect(b.minX >= 1 && b.maxX <= 17, "\(b)")
        #expect(b.minY >= 2 && b.maxY <= 16, "\(b)")
    }
}

@Test func brandGlyphIsTemplate() {
    #expect(Brand.glyph(running: false).isTemplate)
    #expect(Brand.glyph(running: true).isTemplate)
    #expect(Brand.glyph(running: true).size == NSSize(width: 18, height: 18))
}
