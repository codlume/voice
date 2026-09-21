import Testing
import Foundation
@testable import VoiceHelperProtocol

@Test func captureRequiresExplicitIdentityAndRejectsExtraFields() {
    #expect(CaptureRequest(["type": "capture.start", "session": "one", "attempt": "one", "device": NSNull()]) != nil)
    #expect(CaptureRequest(["type": "capture.start", "session": "one", "device": NSNull()]) == nil)
    #expect(CaptureRequest(["type": "capture.start", "session": "one", "attempt": "one", "device": NSNull(), "extra": true]) == nil)
}
