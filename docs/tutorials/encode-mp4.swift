import Foundation
import AVFoundation
import CoreVideo
import CoreGraphics
import ImageIO

struct TutorialFrame: Decodable { let path: String; let duration: Double }
struct TutorialSequence: Decodable { let frames: [TutorialFrame] }
func fail(_ message: String) -> Never { fputs(message + "\n", stderr); exit(1) }
let args = CommandLine.arguments
if args.count < 3 { fail("Usage: encode-video sequence.json output.mp4 [poster.png]") }
let sequence = try JSONDecoder().decode(TutorialSequence.self, from: Data(contentsOf: URL(fileURLWithPath: args[1])))
if sequence.frames.isEmpty { fail("No frames") }
func readImage(_ path: String) -> CGImage {
 guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
       let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fail("Cannot read frame: " + path) }
 return image
}
let initial = readImage(sequence.frames[0].path)
let width = initial.width / 2 * 2, height = initial.height / 2 * 2
let outputURL = URL(fileURLWithPath: args[2])
if FileManager.default.fileExists(atPath: outputURL.path) { try FileManager.default.removeItem(at: outputURL) }
let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
writer.shouldOptimizeForNetworkUse = true
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
 AVVideoCodecKey: AVVideoCodecType.h264,
 AVVideoWidthKey: width, AVVideoHeightKey: height,
 AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 1_800_000, AVVideoMaxKeyFrameIntervalKey: 30]
])
input.expectsMediaDataInRealTime = false
let attributes: [String: Any] = [
 kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
 kCVPixelBufferWidthKey as String: width,
 kCVPixelBufferHeightKey as String: height,
 kCVPixelBufferCGImageCompatibilityKey as String: true,
 kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
]
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: attributes)
if !writer.canAdd(input) { fail("Cannot add H264 writer input") }
writer.add(input)
if !writer.startWriting() { fail("Cannot start writing: \(String(describing: writer.error))") }
writer.startSession(atSourceTime: .zero)
let fps: Int32 = 10
var frameIndex: Int64 = 0
for item in sequence.frames {
 let cgImage = readImage(item.path)
 var optionalBuffer: CVPixelBuffer?
 let status = CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, attributes as CFDictionary, &optionalBuffer)
 guard status == kCVReturnSuccess, let buffer = optionalBuffer else { fail("Pixel buffer allocation failed") }
 CVPixelBufferLockBaseAddress(buffer, [])
 guard let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue) else { fail("Cannot create bitmap context") }
 context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
 CVPixelBufferUnlockBaseAddress(buffer, [])
 let repeats = max(1, Int((item.duration * Double(fps)).rounded()))
 for _ in 0..<repeats {
  let deadline = Date().addingTimeInterval(20)
  while !input.isReadyForMoreMediaData {
   if writer.status == .failed || Date() > deadline { fail("Encoder stalled: \(String(describing: writer.error))") }
   Thread.sleep(forTimeInterval: 0.002)
  }
  if !adaptor.append(buffer, withPresentationTime: CMTime(value: frameIndex, timescale: fps)) { fail("Append failed: \(String(describing: writer.error))") }
  frameIndex += 1
 }
}
writer.endSession(atSourceTime: CMTime(value: frameIndex, timescale: fps))
input.markAsFinished()
let finished = DispatchSemaphore(value: 0)
writer.finishWriting { finished.signal() }
if finished.wait(timeout: .now() + 60) == .timedOut { fail("Finish timed out") }
if writer.status != .completed { fail("Encoding failed: \(String(describing: writer.error))") }
if args.count >= 4 {
 let asset = AVURLAsset(url: outputURL)
 let generator = AVAssetImageGenerator(asset: asset)
 generator.appliesPreferredTrackTransform = true
 let poster = try generator.copyCGImage(at: CMTime(value: 2, timescale: fps), actualTime: nil)
 guard let target = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[3]) as CFURL, "public.png" as CFString, 1, nil) else { fail("Cannot create poster") }
 CGImageDestinationAddImage(target, poster, nil)
 if !CGImageDestinationFinalize(target) { fail("Cannot save poster") }
}
print("Encoded \(width)x\(height), \(frameIndex) frames, \(Double(frameIndex)/Double(fps)) seconds: \(outputURL.lastPathComponent)")
