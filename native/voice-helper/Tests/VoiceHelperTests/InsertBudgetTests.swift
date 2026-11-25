import Foundation
import Testing
@testable import VoiceHelper

@Suite struct InsertBudgetTests {
    @Test func anInsertThatCanReachTheAppAnswersWithinTheBoundMainWaitsFor() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../test-fixtures/helper-protocol.json").standardizedFileURL
        let corpus = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
        let boundMs = try #require(corpus?["insertMaxMs"] as? Double)
        #expect((insertMaxDuration * 1000).rounded() <= boundMs)
    }
}
