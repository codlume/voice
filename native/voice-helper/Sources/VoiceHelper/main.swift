import AppKit
import Darwin
import Foundation
import VoiceHelperCore
import os

final class Helper {
    private let output: Output
    private let testMode: Bool
    private let transcriber: Transcriber
    private let capture: Capture
    private let devices: AudioInputDevices
    private let pasteboard: Pasteboard
    private let insertion: Insertion
    private let selection: SelectionReader
    private let hotkeyTap: HotkeyTap
    private let permissions: Permissions
    private let installedApps: InstalledApps
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
        let capture = Capture(output: output, transcriber: transcriber, devices: devices, outputSilencer: outputSilencer,
                              source: .resolve(environment: environment))
        devices.onChange = { [weak capture] in capture?.devicesChanged() }
        self.capture = capture
        let pasteboard = Pasteboard(output: output)
        self.pasteboard = pasteboard
        let insertion = Insertion(output: output, forcePaste: testMode && environment["VOICE_HELPER_FORCE_PASTE"] == "1", pasteboard: pasteboard)
        self.insertion = insertion
        // Written by the tap when a shortcut fires, read by the reader waiting for its release.
        let firedKey = OSAllocatedUnfairLock<Int64?>(initialState: nil)
        let selection = SelectionReader(output: output, insertion: insertion, pasteboard: pasteboard, firedKey: firedKey,
                                        log: testMode ? { output.log(.info, $0) } : nil)
        self.selection = selection
        let hotkeyTap = HotkeyTap(output: output, firedKey: firedKey) {
            capture.isActive ? .capturing : selection.isActive ? .transforming : .idle
        }
        self.hotkeyTap = hotkeyTap
        permissions = Permissions(output: output) { hotkeyTap.install() }
        installedApps = InstalledApps(output: output)
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
        case .hotkeyConfigure(let key, let toggleKey, let transforms):
            hotkeyTap.configure(key: key, toggleKey: toggleKey, transforms: transforms)
        case .microphoneConfigure(let microphone):
            capture.configure(microphone: microphone)
        case .captureStart(let id, let language, let muteWhileDictating, let microphone, let detectHost):
            let app = NSWorkspace.shared.frontmostApplication
            let override = testTarget
            testTarget = nil
            let target = insertion.recordTarget(
                pid: app?.processIdentifier, bundleId: override?.bundleId ?? app?.bundleIdentifier,
                host: override.map { .read($0.host) } ?? (detectHost ? .pending : .read(nil)),
                log: testMode ? { [output] in output.log(.info, $0) } : nil)
            if !capture.start(id: id, language: language, target: target, receivedAt: receivedAt, muteWhileDictating: muteWhileDictating, microphone: microphone) {
                target.settleHost()
            }
        case .captureStop(let id):
            capture.stop(id: id)
        case .captureCancel(let id):
            capture.cancel(id: id)
        case .microphoneTestStart(let id, let microphone):
            capture.startTest(id: id, microphone: microphone)
        case .microphoneTestStop(let id):
            capture.stopTest(id: id)
        case .insert(let id, let text, let html):
            // Run ids never collide: a dictation id names a capture, a transform id names a read.
            insertion.insert(id: id, text: text, html: html, target: capture.takeLastTarget(id: id) ?? selection.take(id: id))
        case .selectionRead(let id):
            selection.read(id: id)
        case .transformEnd(let id):
            selection.end(id: id)
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
        case .testTarget(let target):
            guard testMode else { return output.log(.error, "test hooks disabled") }
            testTarget = target
        case .appsList:
            installedApps.list()
        case .iconsRender(let id, let paths):
            installedApps.renderIcons(id: id, paths: paths)
        }
    }

    @MainActor
    func shutdown() {
        devices.shutdown()
        capture.shutdown()
        pasteboard.flush()
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

// Electron's Crashpad registers task exception ports that a spawned child inherits, so a helper
// crash would also become a dump of the helper's memory and environment in Electron's crash folder.
// Without them macOS alone reports the crash, and main reads that report's stack instead.
task_set_exception_ports(
    mach_task_self_, exception_mask_t(EXC_MASK_CRASH | EXC_MASK_RESOURCE | EXC_MASK_GUARD),
    mach_port_t(MACH_PORT_NULL), exception_behavior_t(EXCEPTION_DEFAULT), thread_state_flavor_t(THREAD_STATE_NONE))

// A vanished parent must end the helper via stdin EOF, not a SIGPIPE mid-write.
signal(SIGPIPE, SIG_IGN)
let output = Output()
output.emit(.ready(version: helperProtocolVersion))

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
