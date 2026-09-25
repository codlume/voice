import AppKit
import Darwin
import Foundation
import VoiceHelperCore

final class Helper {
    private let output: Output
    private let testMode: Bool
    private let transcriber: Transcriber
    private let capture: Capture
    private let insertion: Insertion
    private let hotkeyTap: HotkeyTap
    private let permissions: Permissions

    @MainActor
    init(output: Output, modelsDir: URL, environment: [String: String]) {
        self.output = output
        testMode = environment["VOICE_HELPER_TEST"] == "1"
        transcriber = Transcriber(modelsDir: modelsDir, output: output)
        let capture = Capture(output: output, transcriber: transcriber)
        if testMode { capture.testAudioPath = environment["VOICE_HELPER_TEST_AUDIO"] }
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
        case .hotkeyConfigure(let key):
            hotkeyTap.configure(key)
        case .captureStart(let id):
            let target = NSWorkspace.shared.frontmostApplication?.processIdentifier
            capture.start(id: id, frontmostPid: target, receivedAt: receivedAt)
            if let target { insertion.prepare(target: target) }
        case .captureStop(let id):
            capture.stop(id: id)
        case .captureCancel(let id):
            capture.cancel(id: id)
        case .insert(let id, let text):
            insertion.insert(id: id, text: text, target: capture.lastTarget)
        case .permissionsCheck:
            permissions.check()
        case .permissionsRequest(let kind):
            permissions.request(kind)
        case .asrPrepare(let download):
            transcriber.prepare(download: download)
        case .testAudioFile(let path):
            guard testMode else { return output.log(.error, "test hooks disabled") }
            capture.testAudioPath = path
        case .testHotkey(let action):
            guard testMode else { return output.log(.error, "test hooks disabled") }
            output.emit(.hotkey(action: action))
        }
    }

    @MainActor
    func shutdown() {
        capture.shutdown()
        insertion.shutdown()
    }
}

func modelsDirArgument() -> URL? {
    let args = CommandLine.arguments
    guard let index = args.firstIndex(of: "--models-dir"), index + 1 < args.count else { return nil }
    return URL(fileURLWithPath: args[index + 1])
}

guard let modelsDir = modelsDirArgument() else {
    FileHandle.standardError.write(Data("usage: voice-helper --models-dir <dir>\n".utf8))
    exit(64)
}

// A vanished parent must end the helper via stdin EOF, not a SIGPIPE mid-write.
signal(SIGPIPE, SIG_IGN)
let output = Output()
output.emit(.ready(version: 1))

let helper = MainActor.assumeIsolated {
    Helper(output: output, modelsDir: modelsDir, environment: ProcessInfo.processInfo.environment)
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
