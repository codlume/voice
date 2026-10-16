import AppKit
import Darwin
import Foundation
import VoiceHelperCore

final class Helper {
    private let output: Output
    private let testMode: Bool
    private let transcriber: Transcriber
    private let capture: Capture
    private let devices: AudioInputDevices
    private let insertion: Insertion
    private let hotkeyTap: HotkeyTap
    private let permissions: Permissions
    private var testTarget: TranscriptTarget?

    @MainActor
    init(output: Output, modelsDir: URL, stateDir: URL, environment: [String: String]) {
        self.output = output
        testMode = environment["VOICE_HELPER_TEST"] == "1"
        transcriber = Transcriber(modelsDir: modelsDir, output: output)
        let devices = AudioInputDevices(output: output)
        self.devices = devices
        let outputSilencer = OutputSilencer(output: output, stateDir: stateDir)
        outputSilencer.recover()
        let capture = Capture(output: output, transcriber: transcriber, devices: devices, outputSilencer: outputSilencer)
        devices.onChange = { [weak capture] in capture?.devicesChanged() }
        if testMode {
            capture.testAudioPath = environment["VOICE_HELPER_TEST_AUDIO"]
        }
        self.capture = capture
        insertion = Insertion(output: output, forcePaste: testMode && environment["VOICE_HELPER_FORCE_PASTE"] == "1")
        let hotkeyTap = HotkeyTap(output: output) { capture.isActive }
        self.hotkeyTap = hotkeyTap
        permissions = Permissions(output: output) { hotkeyTap.install() }
    }

    func installHotkeyTap() {
        hotkeyTap.install()
    }

    @MainActor
    func handle(line: String, receivedAt: DispatchTime) {
        switch HelperCommand.decode(line: line) {
        case .failure(let error):
            output.log(.error, "bad command: \(error.description)")
        case .success(let command):
            dispatch(command, receivedAt: receivedAt)
        }
    }

    @MainActor
    private func dispatch(_ command: HelperCommand, receivedAt: DispatchTime) {
        switch command {
        case .hotkeyConfigure(let key, let toggleKey):
            hotkeyTap.configure(key: key, toggleKey: toggleKey)
        case .microphoneConfigure(let microphone):
            capture.configure(microphone: microphone)
        case .captureStart(let id, let language, let muteWhileDictating, let microphone):
            let app = NSWorkspace.shared.frontmostApplication
            let target: InsertTarget
            if let override = testTarget {
                testTarget = nil
                target = insertion.recordTarget(pid: app?.processIdentifier, bundleId: override.bundleId)
                target.host = .read(override.host)
            } else {
                target = insertion.recordTarget(pid: app?.processIdentifier, bundleId: app?.bundleIdentifier)
            }
            capture.start(id: id, language: language, target: target, receivedAt: receivedAt, muteWhileDictating: muteWhileDictating, microphone: microphone)
        case .captureStop(let id):
            capture.stop(id: id)
        case .captureCancel(let id):
            capture.cancel(id: id)
        case .microphoneTestStart(let id, let microphone):
            capture.startTest(id: id, microphone: microphone)
        case .microphoneTestStop(let id):
            capture.stopTest(id: id)
        case .insert(let id, let text, let html):
            insertion.insert(id: id, text: text, html: html, target: capture.takeLastTarget(id: id))
        case .permissionsCheck:
            permissions.check()
        case .permissionsRequest(let kind):
            permissions.request(kind)
        case .asrPrepare(let download):
            transcriber.prepare(download: download)
        case .asrRemove:
            transcriber.remove()
        case .testAudioFile(let path):
            guard testMode else { return output.log(.error, "test hooks disabled") }
            capture.testAudioPath = path
        case .testTarget(let bundleId, let host):
            guard testMode else { return output.log(.error, "test hooks disabled") }
            testTarget = TranscriptTarget(bundleId: bundleId, host: host)
        }
    }

    @MainActor
    func shutdown() {
        devices.shutdown()
        capture.shutdown()
        insertion.shutdown()
    }
}

func directoryArgument(_ name: String) -> URL? {
    let args = CommandLine.arguments
    guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
    return URL(fileURLWithPath: args[index + 1])
}

guard let modelsDir = directoryArgument("--models-dir"), let stateDir = directoryArgument("--state-dir") else {
    FileHandle.standardError.write(Data("usage: voice-helper --models-dir <dir> --state-dir <dir>\n".utf8))
    exit(64)
}

// A vanished parent must end the helper via stdin EOF, not a SIGPIPE mid-write.
signal(SIGPIPE, SIG_IGN)
let output = Output()
output.emit(.ready(version: 11))

let helper = MainActor.assumeIsolated {
    Helper(output: output, modelsDir: modelsDir, stateDir: stateDir, environment: ProcessInfo.processInfo.environment)
}

let reader = Thread {
    while let line = readLine() {
        let receivedAt = DispatchTime.now()
        DispatchQueue.main.async {
            MainActor.assumeIsolated { helper.handle(line: line, receivedAt: receivedAt) }
        }
    }
    DispatchQueue.main.async {
        MainActor.assumeIsolated { helper.shutdown() }
        exit(0)
    }
}
reader.name = "stdin"
reader.start()

// SIGTERM ends the helper the way stdin EOF does, so a pending clipboard restore still runs.
signal(SIGTERM, SIG_IGN)
let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigterm.setEventHandler {
    MainActor.assumeIsolated { helper.shutdown() }
    exit(0)
}
sigterm.resume()

helper.installHotkeyTap()
RunLoop.main.run()
