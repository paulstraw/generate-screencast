// Camera + mic recorder for a human-read voiceover with a face. One capture
// session writes both into one .mov (H.264 + Linear PCM), so picture and sound
// are in sync by construction.
//
//   camrec list                                   cameras (with formats), mics, permission status
//   camrec snapshot <camera> <out.jpg>            one frame after exposure settles, to check framing
//   camrec record <camera> <mic|default> <out.mov>
//
// record prints "rec" once frames are being written, then stops on SIGINT, a
// "stop" line on stdin, or stdin closing; it prints "done" after the file is
// finalized (stopRecording → delegate callback), and exits non-zero on error.
// Device names match exactly first, then by case-insensitive substring. The
// format is read from the device: the smallest one at least 1080 lines tall,
// at 30fps when it supports it. Capture cards and Continuity Camera only
// accept their own exact formats, so nothing is hard-coded.
//
// Build: swiftc -O camrec.swift -o camrec
import AVFoundation
import CoreImage
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func fail(_ msg: String) -> Never {
  FileHandle.standardError.write("camrec: \(msg)\n".data(using: .utf8)!)
  exit(1)
}

func devices(_ type: AVMediaType) -> [AVCaptureDevice] {
  let kinds: [AVCaptureDevice.DeviceType] = type == .video
    ? [.builtInWideAngleCamera, .external, .continuityCamera, .deskViewCamera]
    : [.microphone, .external]
  return AVCaptureDevice.DiscoverySession(deviceTypes: kinds, mediaType: type, position: .unspecified).devices
}

func find(_ name: String, _ type: AVMediaType) -> AVCaptureDevice {
  if type == .audio && name == "default" {
    guard let d = AVCaptureDevice.default(for: .audio) else { fail("no default microphone") }
    return d
  }
  let all = devices(type)
  if let d = all.first(where: { $0.localizedName == name })
    ?? all.first(where: { $0.localizedName.lowercased().contains(name.lowercased()) }) {
    return d
  }
  fail("no \(type == .video ? "camera" : "microphone") matching \"\(name)\"; try: camrec list")
}

func authorize(_ type: AVMediaType) {
  switch AVCaptureDevice.authorizationStatus(for: type) {
  case .authorized: return
  case .notDetermined:
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    AVCaptureDevice.requestAccess(for: type) { ok = $0; sem.signal() }
    sem.wait()
    if ok { return }
  default: break
  }
  let pane = type == .video ? "Camera" : "Microphone"
  fail("\(pane) access denied: System Settings → Privacy & Security → \(pane), allow the app running this terminal")
}

func dims(_ f: AVCaptureDevice.Format) -> CMVideoDimensions {
  CMVideoFormatDescriptionGetDimensions(f.formatDescription)
}

// Smallest format ≥1080 lines (else the tallest), preferring ones that run at
// 30fps; returns the frame duration to use, or nil to leave the default.
func pickFormat(_ d: AVCaptureDevice) -> (AVCaptureDevice.Format, CMTime?) {
  let fmts = d.formats.filter { !$0.videoSupportedFrameRateRanges.isEmpty }
  guard !fmts.isEmpty else { fail("\(d.localizedName) reports no video formats") }
  let has30 = { (f: AVCaptureDevice.Format) in
    f.videoSupportedFrameRateRanges.contains { $0.minFrameRate <= 30.01 && $0.maxFrameRate >= 29.97 }
  }
  let ranked = fmts.sorted { a, b in
    let (ha, hb) = (dims(a).height, dims(b).height)
    let (ba, bb) = (ha >= 1080, hb >= 1080)
    if ba != bb { return ba }
    if ha != hb { return ba ? ha < hb : ha > hb }
    return has30(a) && !has30(b)
  }
  let f = ranked[0]
  if f.videoSupportedFrameRateRanges.contains(where: { $0.minFrameRate <= 30.01 && $0.maxFrameRate >= 30.01 }) {
    return (f, CMTime(value: 1, timescale: 30))
  }
  if let r = f.videoSupportedFrameRateRanges.first(where: { $0.maxFrameRate >= 29.97 && $0.maxFrameRate <= 30.01 }) {
    return (f, r.minFrameDuration)  // 29.97
  }
  return (f, nil)
}

func describe(_ f: AVCaptureDevice.Format) -> String {
  let d = dims(f)
  let fps = f.videoSupportedFrameRateRanges.map { r in
    r.minFrameRate == r.maxFrameRate ? String(format: "%.2f", r.maxFrameRate)
      : String(format: "%.2f–%.2f", r.minFrameRate, r.maxFrameRate)
  }
  return "\(d.width)x\(d.height) @ \(fps.joined(separator: ", ")) fps"
}

// Locks the device and applies the chosen format. The lock is held for the
// life of the process: unlocking before startRunning lets the session reset
// the format to its preset.
func openCamera(_ session: AVCaptureSession, _ cam: AVCaptureDevice) {
  guard let input = try? AVCaptureDeviceInput(device: cam), session.canAddInput(input) else {
    fail("can't open \(cam.localizedName)")
  }
  session.addInput(input)
  let (fmt, frame) = pickFormat(cam)
  do { try cam.lockForConfiguration() } catch { fail("can't configure \(cam.localizedName): \(error)") }
  cam.activeFormat = fmt
  if let frame {
    cam.activeVideoMinFrameDuration = frame
    cam.activeVideoMaxFrameDuration = frame
  }
  FileHandle.standardError.write("camrec: \(cam.localizedName) at \(describe(fmt))\n".data(using: .utf8)!)
}

final class Recorder: NSObject, AVCaptureFileOutputRecordingDelegate {
  // isRecording reads false on macOS even mid-recording; trust the callback.
  var started = false

  func fileOutput(_ output: AVCaptureFileOutput, didStartRecordingTo url: URL, from connections: [AVCaptureConnection]) {
    DispatchQueue.main.async { self.started = true }
    print("rec")
  }

  func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo url: URL, from connections: [AVCaptureConnection], error: Error?) {
    // AVFoundation reports some clean stops as errors; the flag says whether the file is usable.
    let ok = error == nil || ((error as NSError?)?.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool ?? false)
    if !ok { fail("recording failed: \(error!.localizedDescription)") }
    print("done")
    exit(0)
  }
}

final class Snapper: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  let out: URL
  var first: Date?
  var done = false
  init(_ out: URL) { self.out = out }

  func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
    guard !done, let px = CMSampleBufferGetImageBuffer(sample) else { return }
    first = first ?? Date()
    // Auto-exposure and white balance keep moving for a moment after the camera opens.
    if Date().timeIntervalSince(first!) < 2 { return }
    done = true
    let img = CIImage(cvPixelBuffer: px)
    do {
      try CIContext().writeJPEGRepresentation(of: img, to: out, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
    } catch { fail("can't write \(out.path): \(error)") }
    print(out.path)
    exit(0)
  }
}

let args = Array(CommandLine.arguments.dropFirst())
let session = AVCaptureSession()

switch args.first {
case "list":
  let status = { (t: AVMediaType) -> String in
    switch AVCaptureDevice.authorizationStatus(for: t) {
    case .authorized: return "authorized"
    case .notDetermined: return "not yet asked (the first capture prompts)"
    default: return "DENIED"
    }
  }
  print("Camera permission: \(status(.video))")
  print("Microphone permission: \(status(.audio))")
  print("\nCameras:")
  for d in devices(.video) {
    let (f, _) = pickFormat(d)
    print("  \(d.localizedName)  → would record \(describe(f))")
  }
  print("\nMicrophones (default: \(AVCaptureDevice.default(for: .audio)?.localizedName ?? "none")):")
  for d in devices(.audio) { print("  \(d.localizedName)") }
  exit(0)

case "snapshot" where args.count == 3:
  authorize(.video)
  let cam = find(args[1], .video)
  let snapper = Snapper(URL(fileURLWithPath: args[2]))
  session.beginConfiguration()
  openCamera(session, cam)
  let out = AVCaptureVideoDataOutput()
  out.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
  out.setSampleBufferDelegate(snapper, queue: DispatchQueue(label: "snap"))
  guard session.canAddOutput(out) else { fail("can't add video output") }
  session.addOutput(out)
  session.commitConfiguration()
  session.startRunning()
  DispatchQueue.main.asyncAfter(deadline: .now() + 15) { fail("no frames from \(cam.localizedName) in 15s") }
  dispatchMain()

case "record" where args.count == 4:
  authorize(.video)
  authorize(.audio)
  let cam = find(args[1], .video)
  let mic = find(args[2], .audio)
  let url = URL(fileURLWithPath: args[3])
  try? FileManager.default.removeItem(at: url)

  session.beginConfiguration()
  openCamera(session, cam)
  guard let micIn = try? AVCaptureDeviceInput(device: mic), session.canAddInput(micIn) else {
    fail("can't open \(mic.localizedName)")
  }
  session.addInput(micIn)
  let out = AVCaptureMovieFileOutput()
  guard session.canAddOutput(out) else { fail("can't add movie output") }
  session.addOutput(out)
  if let v = out.connection(with: .video) {
    out.setOutputSettings([AVVideoCodecKey: AVVideoCodecType.h264], for: v)
  }
  // Linear PCM, at the mic's own rate and channel count: no lossy codec, no
  // resampling. Channel selection happens afterwards, in ffmpeg.
  if let a = out.connection(with: .audio) {
    let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(mic.activeFormat.formatDescription)?.pointee
    out.setOutputSettings([
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVSampleRateKey: asbd?.mSampleRate ?? 48000,
      AVNumberOfChannelsKey: asbd?.mChannelsPerFrame ?? 1,
      AVLinearPCMBitDepthKey: 24,
      AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsBigEndianKey: false,
      AVLinearPCMIsNonInterleaved: false,
    ], for: a)
  }
  session.commitConfiguration()
  FileHandle.standardError.write("camrec: mic \(mic.localizedName)\n".data(using: .utf8)!)

  let recorder = Recorder()
  session.startRunning()
  out.startRecording(to: url, recordingDelegate: recorder)

  var stopping = false
  let stop = {
    DispatchQueue.main.async {
      if stopping { return }
      stopping = true
      if recorder.started { out.stopRecording() } else { fail("stopped before recording started") }
    }
  }
  signal(SIGINT, SIG_IGN)
  let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
  sigint.setEventHandler(handler: stop)
  sigint.resume()
  Thread.detachNewThread {
    while let line = readLine() { if line.trimmingCharacters(in: .whitespaces) == "stop" { break } }
    stop()
  }
  dispatchMain()

default:
  fail("usage: camrec list | snapshot <camera> <out.jpg> | record <camera> <mic|default> <out.mov>")
}
