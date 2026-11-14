import CoreML
import FluidAudio
import Foundation
import Testing
import VoiceHelperCore
@testable import VoiceHelper

struct ParakeetLoadTests {
    /// Where the smoke scripts keep the downloaded model (scripts/helper.mjs `modelsDir`).
    private static let folder = URL(
        fileURLWithPath: ProcessInfo.processInfo.environment["VOICE_TEST_MODELS_DIR"]
            ?? NSHomeDirectory() + "/Library/Caches/Voice Development/test-models"
    ).appendingPathComponent(ModelManifest.parakeetV3.folderName)
    private static let installed = ModelManifest.parakeetV3.files.allSatisfy {
        FileManager.default.fileExists(atPath: folder.appendingPathComponent($0.path).path)
    }

    // A transcript can only stay the same if these are the models FluidAudio's own loader builds.
    @Test(.enabled(if: installed, "needs the speech model, which the smoke scripts download"))
    func loadingTheEncoderBesideTheRestGivesWhatFluidAudioLoads() async throws {
        ModelHub.offlineMode = true
        let ours = try await Transcriber.loadModels(from: Self.folder)
        let theirs = try await AsrModels.load(from: Self.folder, version: .v3)

        #expect(ours.vocabulary == theirs.vocabulary)
        #expect(ours.version == theirs.version)
        #expect(ours.configuration.computeUnits == theirs.configuration.computeUnits)
        let components: [(String, MLModel?, MLModel?)] = [
            ("preprocessor", ours.preprocessor, theirs.preprocessor), ("encoder", ours.encoder, theirs.encoder),
            ("decoder", ours.decoder, theirs.decoder), ("joint", ours.joint, theirs.joint),
        ]
        for (name, mine, reference) in components {
            let mine = try #require(mine, Comment(rawValue: name))
            let reference = try #require(reference, Comment(rawValue: name))
            #expect(mine.configuration.computeUnits == reference.configuration.computeUnits, Comment(rawValue: name))
            #expect(
                mine.configuration.allowLowPrecisionAccumulationOnGPU == reference.configuration.allowLowPrecisionAccumulationOnGPU,
                Comment(rawValue: name))
            #expect(
                Set(mine.modelDescription.inputDescriptionsByName.keys) == Set(reference.modelDescription.inputDescriptionsByName.keys),
                Comment(rawValue: name))
            #expect(
                Set(mine.modelDescription.outputDescriptionsByName.keys) == Set(reference.modelDescription.outputDescriptionsByName.keys),
                Comment(rawValue: name))
        }
    }
}
