import Foundation
import Testing
@testable import VoiceHelperCore

private let big = Int(ModelCache.alwaysHashUpTo) + 1

private func bundleRelease(marker: String? = nil, shadows: [String] = []) -> SyntheticRelease {
    SyntheticRelease(files: [
        ("Enc.mlmodelc/analytics/coremldata.bin", patternedData(243, seed: 1)),
        ("Enc.mlmodelc/coremldata.bin", patternedData(485, seed: 2)),
        ("Enc.mlmodelc/metadata.json", Data("{\"k\":1}".utf8)),
        ("Enc.mlmodelc/model.mil", patternedData(9_000, seed: 3)),
        ("Enc.mlmodelc/weights/weight.bin", patternedData(big, seed: 4)),
        ("vocab.json", Data("{\"vocab\":[\"a\",\"b\"]}".utf8)),
    ], marker: marker, shadows: shadows)
}

private func flipByte(_ url: URL, at offset: Int = 0) throws {
    var data = try Data(contentsOf: url)
    data[offset] ^= 0x01
    try data.write(to: url)
}

private func expectKind(_ kind: ModelCacheError.Kind, _ body: () async throws -> Void, _ comment: Comment? = nil) async {
    do {
        try await body()
        Issue.record("expected \(kind), nothing thrown")
    } catch let error as ModelCacheError {
        #expect(error.kind == kind, comment)
        #expect(error.errorDescription?.isEmpty == false)
    } catch {
        Issue.record("expected \(kind), got \(error)")
    }
}

struct ModelCacheTests {
    @Test func anAbsentFolderIsMissingAndNotInstalled() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let fixture = bundleRelease()
        let cache = fixture.cache(in: dir)
        let presence = try cache.presence()
        #expect(presence.missing == fixture.release.files.map(\.path))
        #expect(presence.invalid.isEmpty && presence.blocked.isEmpty)
        await expectKind(.notInstalled) { try await cache.prepare(download: false, fetcher: RecordedSleeps().fetcher()) }
        #expect(!FileManager.default.fileExists(atPath: fixture.folder(in: dir).path), "a check creates nothing")
    }

    @Test func corruptTruncatedOversizeAndMissingFilesAreEachFound() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let fixture = bundleRelease()
        try fixture.write(into: dir, overriding: [
            "Enc.mlmodelc/model.mil": patternedData(9_000, seed: 99),
            "Enc.mlmodelc/coremldata.bin": patternedData(100, seed: 2),
            "vocab.json": fixture.contents["vocab.json"]! + Data("x".utf8),
        ], skipping: ["Enc.mlmodelc/metadata.json"])
        let presence = try fixture.cache(in: dir).presence()
        #expect(presence.missing == ["Enc.mlmodelc/metadata.json"])
        #expect(presence.invalid == ["Enc.mlmodelc/coremldata.bin", "vocab.json"], "stat alone finds the size changes")
        let audit = try fixture.cache(in: dir).audit()
        #expect(audit.missing == ["Enc.mlmodelc/metadata.json"])
        #expect(audit.invalid == ["Enc.mlmodelc/coremldata.bin", "Enc.mlmodelc/model.mil", "vocab.json"], "the hash finds the same-size corruption")
        #expect(audit.blocked.isEmpty)
        await expectKind(.notInstalled) { try await fixture.cache(in: dir).prepare(download: false, fetcher: RecordedSleeps().fetcher()) }
    }

    @Test func aSameSizeEditToASmallFileIsCaughtEvenWithAStampThatVouchesForIt() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let fixture = bundleRelease()
        try fixture.write(into: dir)
        let cache = fixture.cache(in: dir)
        try await cache.prepare(download: false, fetcher: RecordedSleeps().fetcher())
        let stampURL = fixture.folder(in: dir).appendingPathComponent(ModelCache.stampName)
        #expect(FileManager.default.fileExists(atPath: stampURL.path))

        let vocab = fixture.folder(in: dir).appendingPathComponent("vocab.json")
        try flipByte(vocab, at: 3)
        var stamp = try JSONSerialization.jsonObject(with: Data(contentsOf: stampURL)) as! [String: Any]
        var files = stamp["files"] as! [String: Any]
        let identity = try FileIdentity(vocab)
        files["vocab.json"] = ["size": identity.size, "mtimeNs": identity.mtimeNs, "inode": identity.inode]
        stamp["files"] = files
        try JSONSerialization.data(withJSONObject: stamp).write(to: stampURL)

        let audit = try cache.audit()
        #expect(audit.invalid == ["vocab.json"])
        #expect(audit.hashedFiles == 5, "every small file is hashed, whatever the stamp says")
        await expectKind(.damaged(count: 1)) { try await cache.prepare(download: false, fetcher: RecordedSleeps().fetcher()) }
        do {
            try await cache.prepare(download: false, fetcher: RecordedSleeps().fetcher())
        } catch {
            #expect(error.localizedDescription == "The test model is damaged: 1 file is missing or altered. Retry downloads only those files.")
        }
    }

    @Test func verificationHappensOnceAndBigFilesAreRehashedWhenTheirStatChanges() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let fixture = bundleRelease()
        try fixture.write(into: dir)
        let cache = fixture.cache(in: dir)
        let small = fixture.release.files.filter { $0.size <= ModelCache.alwaysHashUpTo }.reduce(0) { $0 + $1.size }

        let first = try cache.audit()
        #expect(first.isComplete)
        #expect(first.hashedBytes == fixture.release.totalBytes && first.hashedFiles == 6, "no stamp: everything is hashed")
        let unstamped = try cache.audit()
        #expect(unstamped.hashedBytes == fixture.release.totalBytes, "an audit alone writes no stamp")

        try await cache.prepare(download: false, fetcher: RecordedSleeps().fetcher())
        let second = try cache.audit()
        #expect(second.isComplete)
        #expect(second.hashedBytes == small && second.hashedFiles == 5, "with the stamp only the small files are hashed")

        let weights = fixture.folder(in: dir).appendingPathComponent("Enc.mlmodelc/weights/weight.bin")
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 1_700_000_000)], ofItemAtPath: weights.path)
        let touched = try cache.audit()
        #expect(touched.isComplete)
        #expect(touched.hashedBytes == fixture.release.totalBytes, "a changed mtime means the big file is hashed again")

        let stampURL = fixture.folder(in: dir).appendingPathComponent(ModelCache.stampName)
        try await cache.prepare(download: false, fetcher: RecordedSleeps().fetcher())
        #expect(try cache.audit().hashedBytes == small)
        var stamp = try JSONSerialization.jsonObject(with: Data(contentsOf: stampURL)) as! [String: Any]
        stamp["revision"] = String(repeating: "cd", count: 20)
        try JSONSerialization.data(withJSONObject: stamp).write(to: stampURL)
        #expect(try cache.audit().hashedBytes == fixture.release.totalBytes, "a stamp for another revision is ignored")
        try Data("not json".utf8).write(to: stampURL)
        #expect(try cache.audit().hashedBytes == fixture.release.totalBytes, "a garbage stamp is ignored")
        try await cache.prepare(download: false, fetcher: RecordedSleeps().fetcher())
        #expect(try cache.audit().hashedBytes == small, "a clean prepare replaces it")
    }

    @Test func aRepairFetchesOnlyTheWrongFilesAndLeavesValidBytesAlone() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let fixture = bundleRelease(marker: ".fluidaudio-revision")
        try fixture.write(into: dir, overriding: ["Enc.mlmodelc/model.mil": patternedData(9_000, seed: 77)], skipping: ["vocab.json"])
        let weights = fixture.folder(in: dir).appendingPathComponent("Enc.mlmodelc/weights/weight.bin")
        let metadata = fixture.folder(in: dir).appendingPathComponent("Enc.mlmodelc/metadata.json")
        let weightsBefore = try FileIdentity(weights)
        let metadataBefore = try FileIdentity(metadata)
        StubHub.script(fixture.url(for: "Enc.mlmodelc/model.mil"), [.ok(fixture.contents["Enc.mlmodelc/model.mil"]!)])
        StubHub.script(fixture.url(for: "vocab.json"), [.ok(fixture.contents["vocab.json"]!)])
        let sleeps = RecordedSleeps()
        let cache = fixture.cache(in: dir)
        let downloads = OSAllocatedCounter()

        try await cache.prepare(download: true, fetcher: sleeps.fetcher()) { files in
            downloads.increment()
            #expect(files.map(\.path) == ["Enc.mlmodelc/model.mil", "vocab.json"])
        }

        let requests = StubHub.requests(for: fixture.release)
        #expect(requests.map { $0.url!.absoluteString } == [fixture.url(for: "Enc.mlmodelc/model.mil").absoluteString, fixture.url(for: "vocab.json").absoluteString], "exactly the two wrong files, in manifest order")
        #expect(requests.allSatisfy { $0.httpMethod == "GET" && $0.value(forHTTPHeaderField: "Authorization") == nil })
        #expect(!requests.contains { $0.url!.path.contains("/api/") }, "no listing")
        #expect(downloads.value == 1, "the download callback fires once, before the first fetch")
        #expect(sleeps.recorded.isEmpty)
        #expect(try FileIdentity(weights) == weightsBefore, "the valid big file is untouched")
        #expect(try FileIdentity(metadata) == metadataBefore, "the valid small file is untouched")
        #expect(try Data(contentsOf: fixture.folder(in: dir).appendingPathComponent("vocab.json")) == fixture.contents["vocab.json"])
        #expect(try cache.audit().isComplete)
        let marker = fixture.folder(in: dir).appendingPathComponent(".fluidaudio-revision")
        #expect(try String(contentsOf: marker, encoding: .utf8) == fixture.release.revision + "\n", "the marker is written after verification")
        #expect(!FileManager.default.fileExists(atPath: fixture.folder(in: dir).appendingPathComponent(ModelCache.temporaryDirectoryName).path), "no temp remains")
        #expect(try FileManager.default.contentsOfDirectory(atPath: fixture.folder(in: dir).path).sorted() == [".fluidaudio-revision", ModelCache.stampName, "Enc.mlmodelc", "vocab.json"].sorted())
    }

    @Test func aMarkerIsNeverProofAndAReleaseWithoutOneNeverGetsOne() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let fixture = bundleRelease(marker: ".fluidaudio-revision")
        try fixture.write(into: dir, overriding: ["vocab.json": Data("{\"vocab\":[\"a\",\"c\"]}".utf8)])
        let marker = fixture.folder(in: dir).appendingPathComponent(".fluidaudio-revision")
        try Data((fixture.release.revision + "\n").utf8).write(to: marker)
        #expect(try fixture.cache(in: dir).presence().isComplete, "stat passes")
        #expect(try fixture.cache(in: dir).audit().invalid == ["vocab.json"], "the marker does not vouch for bytes")
        await expectKind(.damaged(count: 1)) { try await fixture.cache(in: dir).prepare(download: false, fetcher: RecordedSleeps().fetcher()) }

        let other = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: other) }
        let unmarked = bundleRelease()
        try unmarked.write(into: other)
        try await unmarked.cache(in: other).prepare(download: false, fetcher: RecordedSleeps().fetcher())
        #expect(try FileManager.default.contentsOfDirectory(atPath: unmarked.folder(in: other).path).sorted() == [ModelCache.stampName, "Enc.mlmodelc", "vocab.json"].sorted(), "no marker for a release without one")
    }

    @Test func aFailedRepairLeavesThePriorBytesAndNoTemp() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let fixture = bundleRelease()
        let wrong = patternedData(9_000, seed: 77)
        try fixture.write(into: dir, overriding: ["Enc.mlmodelc/model.mil": wrong])
        let mil = fixture.folder(in: dir).appendingPathComponent("Enc.mlmodelc/model.mil")
        let before = try FileIdentity(mil)
        StubHub.script(fixture.url(for: "Enc.mlmodelc/model.mil"), [.ok(patternedData(9_000, seed: 78))])
        let cache = fixture.cache(in: dir)
        await expectKind(.downloadFailed("the downloaded file did not match the expected contents")) {
            try await cache.prepare(download: true, fetcher: RecordedSleeps().fetcher())
        }
        #expect(try FileIdentity(mil) == before)
        #expect(try Data(contentsOf: mil) == wrong)
        #expect(!FileManager.default.fileExists(atPath: fixture.folder(in: dir).appendingPathComponent(ModelCache.temporaryDirectoryName).path))
        #expect(StubHub.requests(for: fixture.release).count == 1)
        #expect(!FileManager.default.fileExists(atPath: fixture.folder(in: dir).appendingPathComponent(ModelCache.stampName).path), "no stamp after a failure")
    }

    @Test func aVerifiedCacheStartsOfflineWithNoRequests() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let fixture = bundleRelease(marker: ".fluidaudio-revision")
        try fixture.write(into: dir)
        let cache = fixture.cache(in: dir)
        try await cache.prepare(download: false, fetcher: RecordedSleeps().fetcher())
        for file in fixture.release.files {
            StubHub.script(fixture.url(for: file.path), [StubHub.Reply(status: 200, chunks: [], end: .fail(.notConnectedToInternet))])
        }
        try await cache.prepare(download: true, fetcher: RecordedSleeps().fetcher())
        #expect(StubHub.requests(for: fixture.release).isEmpty)
        #expect(try cache.presence().isComplete)
    }

    @Test func anOfflineRepairFailsWithTheRetryMessageAndChangesNothing() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let fixture = bundleRelease()
        try fixture.write(into: dir, skipping: ["vocab.json"])
        let identities = try fixture.release.files.filter { $0.path != "vocab.json" }.map { try FileIdentity(fixture.folder(in: dir).appendingPathComponent($0.path)) }
        StubHub.script(fixture.url(for: "vocab.json"), [StubHub.Reply(status: 200, chunks: [], end: .fail(.notConnectedToInternet))])
        let sleeps = RecordedSleeps()
        let cache = fixture.cache(in: dir)
        do {
            try await cache.prepare(download: true, fetcher: sleeps.fetcher())
            Issue.record("expected a failure")
        } catch let error as ModelCacheError {
            guard case .downloadFailed = error.kind else {
                Issue.record("\(error.kind)")
                return
            }
            #expect(error.localizedDescription.hasPrefix("Downloading the test model failed: "))
            #expect(error.localizedDescription.hasSuffix("Retry keeps the files already downloaded."))
        }
        #expect(sleeps.recorded == [.seconds(1), .seconds(2), .seconds(4)])
        #expect(StubHub.requests(for: fixture.release).count == 4)
        #expect(try fixture.release.files.filter { $0.path != "vocab.json" }.map { try FileIdentity(fixture.folder(in: dir).appendingPathComponent($0.path)) } == identities)
        #expect(try cache.presence().missing == ["vocab.json"])
    }

    @Test func fluidAudioDownloadLeftoversDoNotBlockARepairAndGoWithIt() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let fixture = bundleRelease()
        let target = "Enc.mlmodelc/weights/weight.bin"
        try fixture.write(into: dir, skipping: [target])
        let folder = fixture.folder(in: dir)
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("Enc.mlmodelc/weights"), withIntermediateDirectories: true)
        let leftovers = ["\(target).partial", "\(target).partial.etag"].map { folder.appendingPathComponent($0) }
        for url in leftovers { try Data("old".utf8).write(to: url) }
        let cache = fixture.cache(in: dir)
        #expect(try cache.presence().blocked.isEmpty)
        #expect(try cache.presence().missing == [target])
        let bytes = try #require(fixture.contents[target])
        StubHub.script(fixture.url(for: target), [.ok(bytes)])
        try await cache.prepare(download: true, fetcher: RecordedSleeps().fetcher())
        #expect(StubHub.requests(for: fixture.release).count == 1)
        #expect(leftovers.allSatisfy { !FileManager.default.fileExists(atPath: $0.path) })
        #expect(try cache.audit().isComplete)
    }

    @Test func aPartialFileForNoManifestPathStillBlocks() throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let fixture = bundleRelease()
        try fixture.write(into: dir)
        try Data("x".utf8).write(to: fixture.folder(in: dir).appendingPathComponent("Enc.mlmodelc/other.bin.partial"))
        #expect(try fixture.cache(in: dir).presence().blocked.count == 1)
    }

    @Test func aFileThatChangesDuringARepairFailsTheSecondCheckAndGetsNoStamp() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let fixture = bundleRelease()
        let target = "Enc.mlmodelc/weights/weight.bin"
        try fixture.write(into: dir, skipping: [target])
        let bytes = try #require(fixture.contents[target])
        StubHub.script(fixture.url(for: target), [.ok(bytes)])
        let vocab = fixture.folder(in: dir).appendingPathComponent("vocab.json")
        let original = try Data(contentsOf: vocab)
        let cache = fixture.cache(in: dir)
        do {
            try await cache.prepare(download: true, fetcher: RecordedSleeps().fetcher()) { _ in
                try? Data(repeating: 0x21, count: original.count).write(to: vocab)
            }
            Issue.record("expected the second check to fail")
        } catch let error as ModelCacheError {
            #expect(error.kind == .damaged(count: 1))
        }
        #expect(!FileManager.default.fileExists(atPath: fixture.folder(in: dir).appendingPathComponent(ModelCache.stampName).path))
    }

    @Test func aFifoAtTheStampDoesNotHangAndIsIgnored() throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let fixture = bundleRelease()
        try fixture.write(into: dir)
        #expect(mkfifo(fixture.folder(in: dir).appendingPathComponent(ModelCache.stampName).path, 0o600) == 0)
        let cache = fixture.cache(in: dir)
        let finished = DispatchSemaphore(value: 0)
        Thread.detachNewThread {
            _ = cache.readStamp()
            finished.signal()
        }
        #expect(finished.wait(timeout: .now() + 5) == .success)
    }

    @Test func aSymlinkAtTheTemporaryDirectoryIsRefusedAndItsTargetIsKept() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let fixture = SyntheticRelease(files: [("a/b.bin", patternedData(100, seed: 1)), ("c.bin", patternedData(100, seed: 2))])
        try fixture.write(into: dir, skipping: ["c.bin"])
        let victim = dir.appendingPathComponent("victim", isDirectory: true)
        try FileManager.default.createDirectory(at: victim, withIntermediateDirectories: true)
        let precious = victim.appendingPathComponent("precious.txt")
        try Data("keep".utf8).write(to: precious)
        try FileManager.default.createSymbolicLink(at: fixture.folder(in: dir).appendingPathComponent(ModelCache.temporaryDirectoryName), withDestinationURL: victim)
        StubHub.script(fixture.url(for: "c.bin"), [.ok(fixture.contents["c.bin"]!)])
        do {
            try await fixture.cache(in: dir).prepare(download: true, fetcher: RecordedSleeps().fetcher())
            Issue.record("expected blocked")
        } catch let error as ModelCacheError {
            #expect(error.kind == .blocked(path: "model/\(ModelCache.temporaryDirectoryName)"))
        }
        #expect(FileManager.default.fileExists(atPath: precious.path), "the link target is never emptied")
    }

    @Test func hostilePathsWriteNothingAndFetchNothing() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let outside = dir.appendingPathComponent("LaunchAgents")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        let models = dir.appendingPathComponent("models", isDirectory: true)
        try FileManager.default.createDirectory(at: models, withIntermediateDirectories: true)
        let hostile = "Preprocessor.mlmodelc/../../../../../LaunchAgents/x.plist"
        let release = ModelRelease(
            id: "hostile", displayName: "test model", repository: "test/\(UUID().uuidString.lowercased())", folderName: "m",
            revision: String(repeating: "ab", count: 20), files: [ModelFile(hostile, size: 5, sha256: sha256Hex(Data("hello".utf8)))], marker: nil, shadows: [])
        let cache = ModelCache(release: release, modelsDirectory: models)
        await expectKind(.invalidManifest(hostile)) { _ = try cache.presence() }
        await expectKind(.invalidManifest(hostile)) { _ = try cache.audit() }
        await expectKind(.invalidManifest(hostile)) { try await cache.prepare(download: true, fetcher: RecordedSleeps().fetcher()) }
        #expect(StubHub.requests(for: release).isEmpty)
        #expect(try FileManager.default.contentsOfDirectory(atPath: outside.path).isEmpty)
        #expect(try FileManager.default.contentsOfDirectory(atPath: models.path).isEmpty, "not even the model folder is created")
        let fetcher = RecordedSleeps().fetcher()
        await expectKind(.invalidManifest(hostile)) { try await fetcher.fetch(release.files[0], of: release, to: dir.appendingPathComponent("staged")) }
        #expect(StubHub.requests(for: release).isEmpty)
    }

    @Test func aSymlinkBelowTheRootIsBlockedAndNeverFollowedOrWrittenThrough() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let fixture = bundleRelease()
        try fixture.write(into: dir)
        let secret = dir.appendingPathComponent("secret.txt")
        let secretBytes = Data("do not touch".utf8)
        try secretBytes.write(to: secret)
        let vocab = fixture.folder(in: dir).appendingPathComponent("vocab.json")
        try FileManager.default.removeItem(at: vocab)
        try FileManager.default.createSymbolicLink(at: vocab, withDestinationURL: secret)
        let cache = fixture.cache(in: dir)
        #expect(try cache.presence().blocked == ["model/vocab.json"])
        StubHub.script(fixture.url(for: "vocab.json"), [.ok(fixture.contents["vocab.json"]!)])
        await expectKind(.blocked(path: "model/vocab.json")) { try await cache.prepare(download: true, fetcher: RecordedSleeps().fetcher()) }
        #expect(StubHub.requests(for: fixture.release).isEmpty)
        #expect(try Data(contentsOf: secret) == secretBytes)
        #expect(try FileManager.default.destinationOfSymbolicLink(atPath: vocab.path) == secret.path, "the link itself is left in place")

        let elsewhere = dir.appendingPathComponent("elsewhere", isDirectory: true)
        try FileManager.default.moveItem(at: fixture.folder(in: dir).appendingPathComponent("Enc.mlmodelc"), to: elsewhere)
        try FileManager.default.removeItem(at: vocab)
        try fixture.contents["vocab.json"]!.write(to: vocab)
        try FileManager.default.createSymbolicLink(at: fixture.folder(in: dir).appendingPathComponent("Enc.mlmodelc"), withDestinationURL: elsewhere)
        let report = try cache.audit()
        #expect(report.blocked == ["model/Enc.mlmodelc"])
        #expect(report.missing.isEmpty && report.invalid.isEmpty, "nothing below the link was looked at")
        #expect(report.hashedFiles == 1, "only the vocab, outside the link")
    }

    @Test func aModelFolderThatIsItselfASymlinkWorks() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let fixture = bundleRelease(marker: ".fluidaudio-revision")
        let shared = dir.appendingPathComponent("shared-cache", isDirectory: true)
        try fixture.write(into: shared)
        let models = dir.appendingPathComponent("models", isDirectory: true)
        try FileManager.default.createDirectory(at: models, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: fixture.folder(in: models), withDestinationURL: fixture.folder(in: shared))
        let cache = fixture.cache(in: models)
        #expect(try cache.audit().isComplete)
        try await cache.prepare(download: false, fetcher: RecordedSleeps().fetcher())
        #expect(FileManager.default.fileExists(atPath: fixture.folder(in: shared).appendingPathComponent(ModelCache.stampName).path), "the stamp lands in the linked folder")
        #expect(try String(contentsOf: fixture.folder(in: shared).appendingPathComponent(".fluidaudio-revision"), encoding: .utf8) == fixture.release.revision + "\n")
        #expect(try cache.audit().hashedFiles == 5, "the stamp is read back through the link")

        try FileManager.default.removeItem(at: fixture.folder(in: shared).appendingPathComponent("vocab.json"))
        StubHub.script(fixture.url(for: "vocab.json"), [.ok(fixture.contents["vocab.json"]!)])
        try await cache.prepare(download: true, fetcher: RecordedSleeps().fetcher())
        #expect(try Data(contentsOf: fixture.folder(in: shared).appendingPathComponent("vocab.json")) == fixture.contents["vocab.json"], "a repair writes into the linked folder")
    }

    @Test func unknownFilesInsideABundleAndShadowsBlockWhileRootExtrasAreFine() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let fixture = bundleRelease(marker: ".fluidaudio-revision", shadows: ["plda-parameters.json"])
        try fixture.write(into: dir)
        let folder = fixture.folder(in: dir)
        for extra in ["config.json", "provenance.json", "parakeet_v3_vocab.json", "xvector-transform.json"] {
            try Data("{}".utf8).write(to: folder.appendingPathComponent(extra))
        }
        try Data((fixture.release.revision + "\n").utf8).write(to: folder.appendingPathComponent(".fluidaudio-revision"))
        try Data().write(to: folder.appendingPathComponent("Enc.mlmodelc/.DS_Store"))
        let cache = fixture.cache(in: dir)
        #expect(try cache.audit().isComplete, "root extras and a Finder file inside the bundle are ignored")
        try await cache.prepare(download: false, fetcher: RecordedSleeps().fetcher())
        #expect(try FileManager.default.contentsOfDirectory(atPath: folder.path).count == 8, "nothing was removed")

        try Data("x".utf8).write(to: folder.appendingPathComponent("Enc.mlmodelc/extra.bin"))
        #expect(try cache.presence().blocked == ["model/Enc.mlmodelc/extra.bin"])
        await expectKind(.blocked(path: "model/Enc.mlmodelc/extra.bin")) { try await cache.prepare(download: true, fetcher: RecordedSleeps().fetcher()) }
        #expect(FileManager.default.fileExists(atPath: folder.appendingPathComponent("Enc.mlmodelc/extra.bin").path), "a repair never deletes")
        try FileManager.default.removeItem(at: folder.appendingPathComponent("Enc.mlmodelc/extra.bin"))
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("Enc.mlmodelc/weights/more"), withIntermediateDirectories: false)
        #expect(try cache.presence().blocked == ["model/Enc.mlmodelc/weights/more"])
        try FileManager.default.removeItem(at: folder.appendingPathComponent("Enc.mlmodelc/weights/more"))

        try Data("{}".utf8).write(to: dir.appendingPathComponent("plda-parameters.json"))
        #expect(try cache.presence().blocked == ["plda-parameters.json"])
        await expectKind(.blocked(path: "plda-parameters.json")) { try await cache.prepare(download: false, fetcher: RecordedSleeps().fetcher()) }
        do {
            try await cache.prepare(download: false, fetcher: RecordedSleeps().fetcher())
        } catch {
            #expect(error.localizedDescription == "The test model cannot be used while plda-parameters.json is in the models folder. Remove that item, then retry.")
        }
        #expect(FileManager.default.fileExists(atPath: dir.appendingPathComponent("plda-parameters.json").path))
    }

    @Test func aFileWhereADirectoryShouldBeIsBlocked() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let fixture = bundleRelease()
        try fixture.write(into: dir)
        let weights = fixture.folder(in: dir).appendingPathComponent("Enc.mlmodelc/weights")
        try FileManager.default.removeItem(at: weights)
        try Data("file".utf8).write(to: weights)
        let report = try fixture.cache(in: dir).audit()
        #expect(report.blocked == ["model/Enc.mlmodelc/weights"])
        #expect(report.missing.isEmpty)
    }
}

final class OSAllocatedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.withLock { count } }
    func increment() { lock.withLock { count += 1 } }
}
