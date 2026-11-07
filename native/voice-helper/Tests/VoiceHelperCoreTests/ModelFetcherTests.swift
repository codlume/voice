import Foundation
import Testing
@testable import VoiceHelperCore

private struct Scenario {
    let dir: URL
    let fixture: SyntheticRelease
    let file: ModelFile
    let bytes: Data
    let staged: URL

    init() throws {
        dir = try temporaryDirectory("fetch")
        bytes = patternedData(200 << 10, seed: 9)
        fixture = SyntheticRelease(files: [("weights/weight.bin", bytes)])
        file = fixture.release.files[0]
        staged = dir.appendingPathComponent("staged")
    }

    var url: URL { fixture.url(for: file.path) }

    func script(_ replies: [StubHub.Reply]) {
        StubHub.script(url, replies)
    }

    var requests: [URLRequest] { StubHub.requests(for: fixture.release) }
    var stagedExists: Bool { FileManager.default.fileExists(atPath: staged.path) }

    func expectFailure(_ failure: ModelFetcher.Failure, _ body: () async throws -> Void) async {
        do {
            try await body()
            Issue.record("expected \(failure), nothing thrown")
        } catch let error as ModelFetcher.Failure {
            #expect(error == failure)
        } catch {
            Issue.record("expected \(failure), got \(error)")
        }
    }
}

struct ModelFetcherTests {
    @Test func aCleanFetchLandsTheExactBytes() async throws {
        let scenario = try Scenario()
        defer { try? FileManager.default.removeItem(at: scenario.dir) }
        scenario.script([.ok(scenario.bytes, chunk: 7_001)])
        let sleeps = RecordedSleeps()
        try await sleeps.fetcher().fetch(scenario.file, of: scenario.fixture.release, to: scenario.staged)
        #expect(try Data(contentsOf: scenario.staged) == scenario.bytes)
        #expect(scenario.requests.count == 1)
        #expect(scenario.requests[0].value(forHTTPHeaderField: "Range") == nil)
        #expect(sleeps.recorded.isEmpty)
    }

    @Test func everyRequestAsksForTheBytesAsStored() async throws {
        let scenario = try Scenario()
        defer { try? FileManager.default.removeItem(at: scenario.dir) }
        scenario.script([.resume(scenario.bytes, truncateAt: 64 << 10), .resume(scenario.bytes)])
        let sleeps = RecordedSleeps()
        try await sleeps.fetcher().fetch(scenario.file, of: scenario.fixture.release, to: scenario.staged)
        #expect(scenario.requests.count == 2)
        #expect(scenario.requests.map { $0.value(forHTTPHeaderField: "Accept-Encoding") } == ["identity", "identity"])
    }

    @Test func aCompleteBodyFollowedByADropIsKept() async throws {
        let scenario = try Scenario()
        defer { try? FileManager.default.removeItem(at: scenario.dir) }
        scenario.script([.resume(scenario.bytes, end: .fail(.networkConnectionLost))])
        try await RecordedSleeps().fetcher().fetch(scenario.file, of: scenario.fixture.release, to: scenario.staged)
        #expect(try Data(contentsOf: scenario.staged) == scenario.bytes)
        #expect(scenario.requests.count == 1)
    }

    @Test func aConnectionBelowTheMinimumRateCountsAsTimedOut() async throws {
        let scenario = try Scenario()
        defer { try? FileManager.default.removeItem(at: scenario.dir) }
        scenario.script([StubHub.Reply(status: 200, chunks: Data(scenario.bytes.prefix(100_000)).chunked(10_000), end: .hang)])
        let fetcher = ModelFetcher(configuration: StubHub.configuration(), minimumRate: (bytes: 1 << 40, per: .zero)) { _ in }
        await scenario.expectFailure(.transport(.timedOut)) {
            try await fetcher.fetch(scenario.file, of: scenario.fixture.release, to: scenario.staged)
        }
        #expect(scenario.requests.count == ModelFetcher.attempts)
        #expect(!scenario.stagedExists)
    }

    @Test func theFloorNeverStopsTheChunkThatCompletesTheFile() async throws {
        let dir = try temporaryDirectory("fetch")
        defer { try? FileManager.default.removeItem(at: dir) }
        let bytes = patternedData(20_000, seed: 3)
        let fixture = SyntheticRelease(files: [("w.bin", bytes)])
        StubHub.script(fixture.url(for: "w.bin"), [.ok(bytes, chunk: bytes.count)])
        let staged = dir.appendingPathComponent("staged")
        let fetcher = ModelFetcher(configuration: StubHub.configuration(), minimumRate: (bytes: 1 << 40, per: .zero)) { _ in }
        try await fetcher.fetch(fixture.release.files[0], of: fixture.release, to: staged)
        #expect(try Data(contentsOf: staged) == bytes)
    }

    @Test func cancellingAFetchLeavesNothing() async throws {
        let scenario = try Scenario()
        defer { try? FileManager.default.removeItem(at: scenario.dir) }
        scenario.script([.resume(scenario.bytes, truncateAt: 20_000, end: .hang)])
        let task = Task { try await RecordedSleeps().fetcher().fetch(scenario.file, of: scenario.fixture.release, to: scenario.staged) }
        while scenario.requests.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
        task.cancel()
        await scenario.expectFailure(.cancelled) { try await task.value }
        #expect(!scenario.stagedExists)
    }

    @Test(arguments: [
        URLError.Code.notConnectedToInternet, .timedOut, .cannotFindHost, .dnsLookupFailed, .cannotConnectToHost,
        .networkConnectionLost, .secureConnectionFailed, .serverCertificateUntrusted, .unknown, .badServerResponse,
    ])
    func transportFailuresReadAsPlainWords(code: URLError.Code) throws {
        let text = try #require(ModelFetcher.Failure.transport(code).errorDescription)
        #expect(!text.contains("NSURLError"))
        #expect(!text.contains("error -"))
        #expect(!text.hasSuffix("."), "the message continues after this text")
    }

    @Test func wrongBytesAreRefusedOnceAndLeaveNoFile() async throws {
        let scenario = try Scenario()
        defer { try? FileManager.default.removeItem(at: scenario.dir) }
        scenario.script([.ok(patternedData(200 << 10, seed: 10))])
        await scenario.expectFailure(.hashMismatch) { try await RecordedSleeps().fetcher().fetch(scenario.file, of: scenario.fixture.release, to: scenario.staged) }
        #expect(scenario.requests.count == 1, "wrong content is not retried")
        #expect(!scenario.stagedExists)
    }

    @Test func anOversizeBodyIsStoppedAtTheLimit() async throws {
        let scenario = try Scenario()
        defer { try? FileManager.default.removeItem(at: scenario.dir) }
        scenario.script([.ok(scenario.bytes + Data("extra".utf8), chunk: 4_096)])
        await scenario.expectFailure(.oversize) { try await RecordedSleeps().fetcher().fetch(scenario.file, of: scenario.fixture.release, to: scenario.staged) }
        #expect(scenario.requests.count == 1)
        #expect(!scenario.stagedExists)
        #expect(ModelFetcher.Failure.oversize.errorDescription == "the server sent more bytes than the file has")
    }

    @Test func aShortBodyResumesWithRangeAndTheHashCoversTheWhole() async throws {
        let scenario = try Scenario()
        defer { try? FileManager.default.removeItem(at: scenario.dir) }
        let cut = 70_000
        scenario.script([
            .ok(scenario.bytes.prefix(cut), chunk: 10_000),
            .partial(scenario.bytes.suffix(from: cut), of: scenario.bytes),
        ])
        let sleeps = RecordedSleeps()
        try await sleeps.fetcher().fetch(scenario.file, of: scenario.fixture.release, to: scenario.staged)
        #expect(try Data(contentsOf: scenario.staged) == scenario.bytes)
        #expect(scenario.requests.count == 2)
        #expect(scenario.requests[1].value(forHTTPHeaderField: "Range") == "bytes=\(cut)-")
        #expect(sleeps.recorded == [.seconds(1)])
    }

    @Test func a200ToARangeRequestStartsOver() async throws {
        let scenario = try Scenario()
        defer { try? FileManager.default.removeItem(at: scenario.dir) }
        scenario.script([
            StubHub.Reply(status: 200, chunks: scenario.bytes.prefix(50_000).chunked(10_000), end: .fail(.networkConnectionLost)),
            .ok(scenario.bytes),
        ])
        try await RecordedSleeps().fetcher().fetch(scenario.file, of: scenario.fixture.release, to: scenario.staged)
        #expect(try Data(contentsOf: scenario.staged) == scenario.bytes)
        let ranges = scenario.requests.map { $0.value(forHTTPHeaderField: "Range") }
        #expect(ranges.count == 2 && ranges[0] == nil)
        // Bytes the socket had but the delegate never saw are lost with the connection, so the
        // offset is what reached disk, somewhere below the cut.
        let offset = try #require(ranges[1].flatMap { Int($0.dropFirst("bytes=".count).dropLast()) })
        #expect(offset > 0 && offset <= 50_000)
    }

    @Test func aResumeThatDoesNotLineUpIsRefused() async throws {
        let scenario = try Scenario()
        defer { try? FileManager.default.removeItem(at: scenario.dir) }
        let misaligned = StubHub.Reply(status: 206, headers: ["Content-Range": "bytes 0-\(scenario.bytes.count - 1)/\(scenario.bytes.count)"], chunks: scenario.bytes.chunked(64 << 10))
        scenario.script([.ok(scenario.bytes.prefix(1_000)), misaligned])
        await scenario.expectFailure(.status(206)) { try await RecordedSleeps().fetcher().fetch(scenario.file, of: scenario.fixture.release, to: scenario.staged) }
        #expect(scenario.requests.count == 2, "a range the server did not honour is not retried")
        #expect(!scenario.stagedExists)
    }

    @Test func serverErrorsBackOffAndHonourRetryAfterUpToThirtySeconds() async throws {
        let scenario = try Scenario()
        defer { try? FileManager.default.removeItem(at: scenario.dir) }
        scenario.script([.status(503), .status(429, headers: ["Retry-After": "7"]), .status(503, headers: ["Retry-After": "100"]), .ok(scenario.bytes)])
        let sleeps = RecordedSleeps()
        try await sleeps.fetcher().fetch(scenario.file, of: scenario.fixture.release, to: scenario.staged)
        #expect(sleeps.recorded == [.seconds(1), .seconds(7), .seconds(30)])
        #expect(scenario.requests.count == 4)
        #expect(try Data(contentsOf: scenario.staged) == scenario.bytes)
    }

    @Test func fourAttemptsAreTheLimit() async throws {
        let scenario = try Scenario()
        defer { try? FileManager.default.removeItem(at: scenario.dir) }
        scenario.script([.status(500)])
        let sleeps = RecordedSleeps()
        await scenario.expectFailure(.status(500)) { try await sleeps.fetcher().fetch(scenario.file, of: scenario.fixture.release, to: scenario.staged) }
        #expect(scenario.requests.count == 4)
        #expect(sleeps.recorded == [.seconds(1), .seconds(2), .seconds(4)])
        #expect(!scenario.stagedExists)
    }

    @Test(arguments: [401, 403, 404, 410])
    func clientErrorsFailAtOnce(status: Int) async throws {
        let scenario = try Scenario()
        defer { try? FileManager.default.removeItem(at: scenario.dir) }
        scenario.script([.status(status)])
        await scenario.expectFailure(.status(status)) { try await RecordedSleeps().fetcher().fetch(scenario.file, of: scenario.fixture.release, to: scenario.staged) }
        #expect(scenario.requests.count == 1)
        #expect(!scenario.stagedExists)
    }

    @Test func transportErrorsRetryAndResume() async throws {
        let scenario = try Scenario()
        defer { try? FileManager.default.removeItem(at: scenario.dir) }
        scenario.script([
            .resume(scenario.bytes, truncateAt: 30_000, end: .fail(.timedOut)),
            .resume(scenario.bytes, truncateAt: 30_000, end: .fail(.networkConnectionLost)),
            .resume(scenario.bytes),
        ])
        let sleeps = RecordedSleeps()
        try await sleeps.fetcher().fetch(scenario.file, of: scenario.fixture.release, to: scenario.staged)
        #expect(try Data(contentsOf: scenario.staged) == scenario.bytes)
        let offsets = scenario.requests.map { $0.value(forHTTPHeaderField: "Range").flatMap { Int($0.dropFirst("bytes=".count).dropLast()) } }
        #expect(offsets.count == 3 && offsets[0] == nil)
        let second = try #require(offsets[1])
        let third = try #require(offsets[2])
        #expect(second > 0 && third > second, "each attempt carries on from what reached disk: \(offsets)")
        #expect(sleeps.recorded == [.seconds(1), .seconds(2)])
    }

    @Test func aRedirectOffHttpsIsRefusedAndOneOnHttpsIsFollowed() async throws {
        let scenario = try Scenario()
        defer { try? FileManager.default.removeItem(at: scenario.dir) }
        let plain = URL(string: "http://cdn.example.invalid/\(scenario.fixture.release.repository)/plain.bin")!
        scenario.script([.redirect(to: plain)])
        StubHub.script(plain, [.ok(scenario.bytes)])
        await scenario.expectFailure(.insecureRedirect) { try await RecordedSleeps().fetcher().fetch(scenario.file, of: scenario.fixture.release, to: scenario.staged) }
        #expect(scenario.requests.map { $0.url!.scheme } == ["https"], "the http hop was never requested")
        #expect(!scenario.stagedExists)

        let secure = URL(string: "https://cdn.example.invalid/\(scenario.fixture.release.repository)/secure.bin")!
        scenario.script([.redirect(to: secure)])
        StubHub.script(secure, [.ok(scenario.bytes)])
        try await RecordedSleeps().fetcher().fetch(scenario.file, of: scenario.fixture.release, to: scenario.staged)
        #expect(try Data(contentsOf: scenario.staged) == scenario.bytes)
        #expect(scenario.requests.suffix(2).map { $0.url!.host } == ["huggingface.co", "cdn.example.invalid"])
    }

    @Test func noListingIsEverRequested() async throws {
        let scenario = try Scenario()
        defer { try? FileManager.default.removeItem(at: scenario.dir) }
        scenario.script([.ok(scenario.bytes)])
        try await RecordedSleeps().fetcher().fetch(scenario.file, of: scenario.fixture.release, to: scenario.staged)
        let paths = scenario.requests.map { $0.url!.path }
        #expect(paths == ["/\(scenario.fixture.release.repository)/resolve/\(scenario.fixture.release.revision)/weights/weight.bin"])
        #expect(!paths.contains { $0.hasPrefix("/api/") })
    }
}
