import AVFoundation
import ApplicationServices
import Foundation
import VoiceHelperCore

final class Permissions {
    private let output: Output
    private let onAccessibilityGranted: () -> Void
    // There is no API that distinguishes "never asked" from "denied", so a
    // request issued by this process is the only signal we have.
    private var accessibilityRequested = false
    private var poll: DispatchSourceTimer?

    init(output: Output, onAccessibilityGranted: @escaping () -> Void) {
        self.output = output
        self.onAccessibilityGranted = onAccessibilityGranted
    }

    func check() {
        output.emit(.permissions(microphone: microphone, accessibility: accessibility))
    }

    func request(_ kind: PermissionKind) {
        switch kind {
        case .microphone:
            AVCaptureDevice.requestAccess(for: .audio) { _ in
                DispatchQueue.main.async { self.check() }
            }
        case .accessibility:
            accessibilityRequested = true
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            AXIsProcessTrustedWithOptions(options)
            check()
            pollUntilAccessibilityGranted()
        }
    }

    private var microphone: PermissionState {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return .granted
        case .denied, .restricted: return .denied
        case .notDetermined: return .notDetermined
        @unknown default: return .denied
        }
    }

    private var accessibility: PermissionState {
        if AXIsProcessTrusted() { return .granted }
        return accessibilityRequested ? .denied : .notDetermined
    }

    private func pollUntilAccessibilityGranted() {
        poll?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        let deadline = DispatchTime.now() + 120
        timer.schedule(deadline: .now() + 0.5, repeating: 0.5)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            if AXIsProcessTrusted() {
                self.poll?.cancel()
                self.poll = nil
                self.check()
                self.onAccessibilityGranted()
            } else if DispatchTime.now() > deadline {
                self.poll?.cancel()
                self.poll = nil
            }
        }
        poll = timer
        timer.resume()
    }
}
