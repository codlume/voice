import Foundation
import Testing
@testable import VoiceHelper

@Suite struct SelectionReadBudgetTests {
    @Test func aReadAnswersWithinTheBoundMainWaitsFor() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../test-fixtures/helper-protocol.json").standardizedFileURL
        let corpus = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
        let boundMs = try #require(corpus?["selectionReadMaxMs"] as? Double)
        #expect((selectionReadMaxDuration * 1000).rounded() <= boundMs)
    }
}
