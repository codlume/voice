import Foundation
import Testing
@testable import VoiceHelperCore

struct ModelManifestTests {
    @Test func theShippedReleasesHaveTheAuditedShape() {
        let expected: [String: (files: Int, bytes: Int64, folder: String)] = [
            "parakeetV3": (21, 483_105_645, "parakeet-tdt-0.6b-v3"),
            "diarizer": (21, 21_599_417, "speaker-diarization"),
        ]
        #expect(ModelManifest.all.map(\.id) == ["parakeetV3", "diarizer"])
        for release in ModelManifest.all {
            let shape = expected[release.id]!
            #expect(release.invalidEntry == nil, Comment(rawValue: release.id))
            #expect(release.files.count == shape.files, Comment(rawValue: "\(release.id) files"))
            #expect(release.totalBytes == shape.bytes, Comment(rawValue: "\(release.id) bytes"))
            #expect(release.folderName == shape.folder)
            #expect(release.revision.count == 40 && release.revision.allSatisfy { $0.isHexDigit && !$0.isUppercase })
            #expect(release.repository.hasPrefix("FluidInference/"))
            let paths = release.files.map(\.path)
            #expect(paths == paths.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }, Comment(rawValue: "\(release.id) paths sorted by byte value"))
            #expect(Set(paths).count == paths.count)
            for file in release.files {
                #expect(file.sha256.count == 64 && file.sha256.allSatisfy { $0.isHexDigit && !$0.isUppercase }, Comment(rawValue: file.path))
                #expect(file.size > 0, Comment(rawValue: file.path))
                #expect(ModelPath.isValid(file.path), Comment(rawValue: file.path))
            }
            let bundles = Dictionary(grouping: paths.filter { $0.contains("/") }) { $0.split(separator: "/").first! }
            #expect(bundles.count == 4, Comment(rawValue: "\(release.id) bundles"))
            for (bundle, members) in bundles {
                #expect(bundle.hasSuffix(".mlmodelc"))
                #expect(members.map { $0.dropFirst(bundle.count + 1) }.sorted() == ["analytics/coremldata.bin", "coremldata.bin", "metadata.json", "model.mil", "weights/weight.bin"], Comment(rawValue: "\(release.id)/\(bundle)"))
            }
        }
    }

    @Test func parakeetNeverGetsAMarkerAndTheDiarizerNeedsOne() {
        #expect(ModelManifest.parakeetV3.marker == nil)
        #expect(ModelManifest.parakeetV3.shadows == ["parakeet-tdt-0.6b-v3/.fluidaudio-revision"])
        #expect(ModelManifest.diarizer.marker == ".fluidaudio-revision")
        #expect(ModelManifest.diarizer.shadows == ["plda-parameters.json"])
        #expect(ModelManifest.parakeetV3.files.contains { $0.path == "parakeet_vocab.json" && $0.size == 151_122 })
        #expect(ModelManifest.diarizer.files.contains { $0.path == "plda-parameters.json" })
    }

    @Test(arguments: [
        "", ".", "..", "../x", "a/../b", "a/..", "/abs", "a//b", "./a", "a/.", "a\\b", "a/\u{01}b", "a\u{7f}", "é.json", "a\nb",
        "Preprocessor.mlmodelc/../../../../../LaunchAgents/x.plist",
    ])
    func unsafePathsAreInvalid(path: String) {
        #expect(!ModelPath.isValid(path))
        #expect(ModelFetcher.url(repository: "a/b", revision: "c", path: path) == nil)
        let release = ModelRelease(
            id: "x", displayName: "x", repository: "a/b", folderName: "m", revision: String(repeating: "0", count: 40),
            files: [ModelFile(path, size: 1, sha256: String(repeating: "0", count: 64))], marker: nil, shadows: [])
        #expect(release.invalidEntry == path)
    }

    @Test(arguments: ["a", "a/b", "Encoder.mlmodelc/weights/weight.bin", "a b.json", "x-y_z.0~"])
    func safePathsAreValid(path: String) {
        #expect(ModelPath.isValid(path))
    }

    @Test func theRestOfTheReleaseIsCheckedToo() {
        func release(folder: String = "m", repository: String = "a/b", revision: String = String(repeating: "f", count: 40), marker: String? = nil, shadows: [String] = [], sha: String = String(repeating: "0", count: 64), size: Int64 = 1) -> ModelRelease {
            ModelRelease(id: "x", displayName: "x", repository: repository, folderName: folder, revision: revision,
                         files: [ModelFile("f", size: size, sha256: sha), ModelFile("g", size: 1, sha256: sha)], marker: marker, shadows: shadows)
        }
        #expect(release().invalidEntry == nil)
        #expect(release(folder: "../m").invalidEntry == "folderName ../m")
        #expect(release(folder: "a/m").invalidEntry == "folderName a/m")
        #expect(release(repository: "a").invalidEntry == "repository a")
        #expect(release(repository: "a/../b").invalidEntry == "repository a/../b")
        #expect(release(revision: "main").invalidEntry == "revision main")
        #expect(release(revision: String(repeating: "F", count: 40)).invalidEntry?.hasPrefix("revision") == true)
        #expect(release(marker: "x/y").invalidEntry == "marker x/y")
        #expect(release(shadows: ["../x"]).invalidEntry == "shadow ../x")
        #expect(release(sha: "abc").invalidEntry == "sha256 of f")
        #expect(release(size: 0).invalidEntry == "size of f")
        let duplicate = ModelRelease(id: "x", displayName: "x", repository: "a/b", folderName: "m", revision: String(repeating: "f", count: 40),
                                     files: [ModelFile("f", size: 1, sha256: String(repeating: "0", count: 64)), ModelFile("f", size: 1, sha256: String(repeating: "0", count: 64))], marker: nil, shadows: [])
        #expect(duplicate.invalidEntry == "duplicate f")
    }

    @Test func urlsComeFromTheManifestAlone() {
        let file = ModelManifest.parakeetV3.files.first { $0.path == "Encoder.mlmodelc/weights/weight.bin" }!
        let url = ModelFetcher.url(repository: ModelManifest.parakeetV3.repository, revision: ModelManifest.parakeetV3.revision, path: file.path)
        #expect(url?.absoluteString == "https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml/resolve/7dd20fe6b1797d35f5e3307e8b1732d9a178edfe/Encoder.mlmodelc/weights/weight.bin")
        #expect(ModelFetcher.url(repository: "a/b", revision: "c", path: "x y/z#1.json")?.absoluteString == "https://huggingface.co/a/b/resolve/c/x%20y/z%231.json")
    }
}
