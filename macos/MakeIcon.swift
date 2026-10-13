import AppKit

let directory = CommandLine.arguments[1]
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let image = NSImage(size: NSSize(width: pixels, height: pixels))
        image.lockFocus()
        let p = CGFloat(pixels)
        NSColor(calibratedRed: 0.06, green: 0.10, blue: 0.15, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: p * 0.06, y: p * 0.06, width: p * 0.88, height: p * 0.88),
                     xRadius: p * 0.20, yRadius: p * 0.20).fill()
        let points = [NSPoint(x: p * 0.30, y: p * 0.64), NSPoint(x: p * 0.70, y: p * 0.64),
                      NSPoint(x: p * 0.50, y: p * 0.30)]
        NSColor(calibratedRed: 0.31, green: 0.84, blue: 0.76, alpha: 1).setStroke()
        let edges = NSBezierPath()
        edges.lineWidth = p * 0.045
        edges.move(to: points[0]); edges.line(to: points[1]); edges.line(to: points[2]); edges.close()
        edges.stroke()
        for point in points {
            NSColor(calibratedRed: 0.31, green: 0.84, blue: 0.76, alpha: 1).setFill()
            NSBezierPath(ovalIn: NSRect(x: point.x - p * 0.09, y: point.y - p * 0.09,
                                      width: p * 0.18, height: p * 0.18)).fill()
        }
        image.unlockFocus()
        let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
        let name = "icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"
        try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: directory).appendingPathComponent(name))
    }
}
