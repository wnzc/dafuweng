// OCR helper: 读取 PNG 并用 Vision 输出识别文字 + 像素坐标（左上原点）
// 用法: ocr <image.png> [minConfidence]
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1 else { FileHandle.standardError.write("usage: ocr <png> [conf]\n".data(using: .utf8)!); exit(2) }
let path = args[1]
let minConf = args.count > 2 ? Float(args[2]) ?? 0.3 : 0.3

guard let img = NSImage(contentsOfFile: path),
      let tiff = img.tiffRepresentation,
      let bmp = NSBitmapImageRep(data: tiff),
      let cg = bmp.cgImage else {
  FileHandle.standardError.write("cannot load image\n".data(using: .utf8)!); exit(1)
}

let W = Double(cg.width), H = Double(cg.height)

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = false

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do { try handler.perform([request]) } catch {
  FileHandle.standardError.write("vision error: \(error)\n".data(using: .utf8)!); exit(1)
}

var items: [[String: Any]] = []
for obs in (request.results ?? []) {
  guard let top = obs.topCandidates(1).first else { continue }
  if top.confidence < minConf { continue }
  let bb = obs.boundingBox
  let x = bb.minX * W
  let y = (1 - bb.maxY) * H
  let w = bb.width * W
  let h = bb.height * H
  items.append([
    "text": top.string,
    "conf": Double(top.confidence),
    "x": Int(x.rounded()), "y": Int(y.rounded()),
    "w": Int(w.rounded()), "h": Int(h.rounded())
  ])
}
items.sort { ($0["y"] as! Int) < ($1["y"] as! Int) }
let out: [String: Any] = ["size": ["w": Int(W), "h": Int(H)], "count": items.count, "items": items]
let data = try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
