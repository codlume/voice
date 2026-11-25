import Dispatch
import Testing
@testable import VoiceHelperCore

@Suite struct InsertDeadlineTests {
    private let receivedAt = DispatchTime.now()

    @Test func aWriteMayStartUntilFourSecondsAfterTheHelperReceivedTheInsert() {
        let deadline = InsertDeadline(receivedAt: receivedAt)
        #expect(!deadline.passed(at: receivedAt))
        #expect(!deadline.passed(at: receivedAt + .milliseconds(3999)))
    }

    @Test func noWriteMayStartFromFourSecondsAfterTheHelperReceivedTheInsert() {
        let deadline = InsertDeadline(receivedAt: receivedAt)
        #expect(deadline.passed(at: receivedAt + .seconds(4)))
        #expect(deadline.passed(at: receivedAt + .seconds(60)))
    }
}
