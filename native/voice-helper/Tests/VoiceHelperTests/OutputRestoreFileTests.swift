import Foundation
import Testing
import VoiceHelperCore
@testable import VoiceHelper

@Test func outputRestoreFilePropagatesReadFailureAndCanRetry() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let url = dir.appendingPathComponent("output-restore.json")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let file = OutputRestoreFile(url: url) { _ in }

    #expect(throws: (any Error).self) { try file.load() }
    #expect(FileManager.default.fileExists(atPath: url.path))

    try FileManager.default.removeItem(at: url)
    let originals: [String: [OutputControl]] = ["speakers": [.mute(element: 0, value: 0)]]
    try file.save(originals)
    #expect(try file.load() == originals)
}

@Test func outputRestoreFileRoundTripsRemovesWhenEmptyAndDiscardsGarbage() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    var errors: [String] = []
    let file = OutputRestoreFile(url: dir.appendingPathComponent("output-restore.json")) { errors.append($0) }

    #expect(try file.load() == [:])
    try file.save([:])
    #expect(!FileManager.default.fileExists(atPath: file.url.path))

    let originals: [String: [OutputControl]] = ["speakers": [.mute(element: 0, value: 0)], "headphones": [.volume(element: 1, value: 0.3), .volume(element: 2, value: 0.7)]]
    try file.save(originals)
    #expect(try OutputRestoreFile(url: file.url) { errors.append($0) }.load() == originals)

    try file.save([:])
    #expect(!FileManager.default.fileExists(atPath: file.url.path))
    #expect(try file.load() == [:])
    #expect(errors.isEmpty)

    try Data("not json".utf8).write(to: file.url)
    #expect(try file.load() == [:])
    #expect(errors.count == 1)
    #expect(!FileManager.default.fileExists(atPath: file.url.path), "an unreadable record is removed, not reported on every start")
}

@Test func outputRestoreFileReadsARecordWrittenByAnOlderHelper() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let url = dir.appendingPathComponent("output-restore.json")
    try Data(#"{"speakers":[{"mute":{"element":0,"value":0}}],"headphones":[{"volume":{"element":1,"value":0.25}}]}"#.utf8).write(to: url)
    #expect(try OutputRestoreFile(url: url) { _ in }.load() == [
        "speakers": [.mute(element: 0, value: 0)],
        "headphones": [.volume(element: 1, value: 0.25)],
    ])
}
