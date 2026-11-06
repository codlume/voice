import Foundation

/// One file of a model release: its path below the model folder, byte count and SHA256.
public struct ModelFile: Sendable, Equatable {
    public let path: String
    public let size: Int64
    public let sha256: String

    public init(_ path: String, size: Int64, sha256: String) {
        self.path = path
        self.size = size
        self.sha256 = sha256
    }
}

/// The files Voice loads for one model, pinned to one Hugging Face commit. Nothing else from
/// that commit is fetched, and no listing is ever requested: the files, sizes and hashes here
/// are the whole contract.
public struct ModelRelease: Sendable {
    public let id: String
    public let displayName: String
    public let repository: String
    /// The folder below the models directory. FluidAudio derives it from the repository name,
    /// and `AsrModels.load` resolves the folder by this name, so it must match FluidAudio's.
    public let folderName: String
    public let revision: String
    public let files: [ModelFile]
    /// A file FluidAudio's loader requires beside the files, holding `revision`. Parakeet has
    /// none and must never get one: a commit marker makes `AsrModels.load` throw `modelMissing`,
    /// because its repo is pinned to `main` inside FluidAudio.
    public let marker: String?
    /// Paths relative to the models directory, not the model folder, that must not exist,
    /// because FluidAudio would read them in place of the verified copy or refuse to load.
    public let shadows: [String]

    public init(
        id: String, displayName: String, repository: String, folderName: String, revision: String,
        files: [ModelFile], marker: String?, shadows: [String]
    ) {
        self.id = id
        self.displayName = displayName
        self.repository = repository
        self.folderName = folderName
        self.revision = revision
        self.files = files
        self.marker = marker
        self.shadows = shadows
    }

    public var totalBytes: Int64 { files.reduce(0) { $0 + $1.size } }

    /// The first thing wrong with the release's own strings, or nil.
    public var invalidEntry: String? {
        if !ModelPath.isSingleComponent(folderName) { return "folderName \(folderName)" }
        let owners = repository.split(separator: "/", omittingEmptySubsequences: false)
        if owners.count != 2 || !owners.allSatisfy({ ModelPath.isSingleComponent(String($0)) }) { return "repository \(repository)" }
        if revision.count != 40 || !revision.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) { return "revision \(revision)" }
        if let marker, !ModelPath.isSingleComponent(marker) { return "marker \(marker)" }
        for shadow in shadows where !ModelPath.isValid(shadow) { return "shadow \(shadow)" }
        var seen = Set<String>()
        for file in files {
            if !ModelPath.isValid(file.path) { return file.path }
            if file.size <= 0 { return "size of \(file.path)" }
            if file.sha256.count != 64 || !file.sha256.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) { return "sha256 of \(file.path)" }
            if !seen.insert(file.path).inserted { return "duplicate \(file.path)" }
        }
        return nil
    }
}

/// Relative paths that are safe to join below a root and to put in a URL: printable ASCII,
/// no backslash, no empty, `.` or `..` component.
public enum ModelPath {
    public static func isValid(_ path: String) -> Bool {
        components(of: path) != nil
    }

    public static func isSingleComponent(_ name: String) -> Bool {
        components(of: name)?.count == 1
    }

    public static func components(of path: String) -> [String]? {
        guard !path.isEmpty, path.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value <= 0x7e && $0 != "\\" }) else { return nil }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { return nil }
        return parts
    }
}

public enum ModelManifest {
    public static let parakeetV3 = ModelRelease(
        id: "parakeetV3", displayName: "speech model",
        repository: "FluidInference/parakeet-tdt-0.6b-v3-coreml", folderName: "parakeet-tdt-0.6b-v3",
        revision: "7dd20fe6b1797d35f5e3307e8b1732d9a178edfe",
        files: [
            ModelFile("Decoder.mlmodelc/analytics/coremldata.bin", size: 243, sha256: "4238c4e81ecd0dc94bd7dfbb60f7e2cc824107c1ffe0387b8607b72833dba350"),
            ModelFile("Decoder.mlmodelc/coremldata.bin", size: 554, sha256: "18647af085d87bd8f3121c8a9b4d4564c1ede038dab63d295b4e745cf2d7fb99"),
            ModelFile("Decoder.mlmodelc/metadata.json", size: 3427, sha256: "a39e93cd8371b8ded92635c7804fcd0590f0d1dd9415c6d19a0484be073077d9"),
            ModelFile("Decoder.mlmodelc/model.mil", size: 13110, sha256: "ef2a0a281695398a62fde86ac269c68f73d5b578d7ed3b31f2ba91a2d1ea1f35"),
            ModelFile("Decoder.mlmodelc/weights/weight.bin", size: 23604992, sha256: "48adf0f0d47c406c8253d4f7fef967436a39da14f5a65e66d5a4b407be355d41"),
            ModelFile("Encoder.mlmodelc/analytics/coremldata.bin", size: 243, sha256: "42e638870d73f26b332918a3496ce36793fbb413a81cbd3d16ba01328637a105"),
            ModelFile("Encoder.mlmodelc/coremldata.bin", size: 485, sha256: "d48034a167a82e88fc3df64f60af963ab3983538271175b8319e7d5720a0fb86"),
            ModelFile("Encoder.mlmodelc/metadata.json", size: 2921, sha256: "da24da9cca943fb29d7fa8e376d57fca7cb3aa08ca51b956b0b0e56813f087e9"),
            ModelFile("Encoder.mlmodelc/model.mil", size: 959769, sha256: "ed7b19156ca29fa7dfd6891deb9fda4b0e8893f68597c985d135736546a43808"),
            ModelFile("Encoder.mlmodelc/weights/weight.bin", size: 445187200, sha256: "e2020f323703477a5b21d7c2d282c403e371afb5962e79877e3033e73ba6f421"),
            ModelFile("JointDecisionv3.mlmodelc/analytics/coremldata.bin", size: 243, sha256: "26def4bf73dd56d29dee21c8ef97cb8969e62f6120ed1adc91e46828e2737b6c"),
            ModelFile("JointDecisionv3.mlmodelc/coremldata.bin", size: 521, sha256: "f5fc08b741400f0088492c9e839418b1e18522f19cba28d361dd030c5f398342"),
            ModelFile("JointDecisionv3.mlmodelc/metadata.json", size: 3453, sha256: "d9307211b9a37e0f0ac260c7660b1571a3de25841035cfdf9b58fd40425f890f"),
            ModelFile("JointDecisionv3.mlmodelc/model.mil", size: 11775, sha256: "be60732943389a047175111a83f8839f3eb39d4803adafa828a0871b2f39818d"),
            ModelFile("JointDecisionv3.mlmodelc/weights/weight.bin", size: 12642764, sha256: "4e0e63d840032f7f07ddb1d64446051166281e5491bf22da8a945c41f6eedb3e"),
            ModelFile("Preprocessor.mlmodelc/analytics/coremldata.bin", size: 243, sha256: "c9beeb989c8d66f8be11df59bc6df277ec76cee404f6865b46243835ef562f6d"),
            ModelFile("Preprocessor.mlmodelc/coremldata.bin", size: 486, sha256: "dbde3f2300842c1fd51ef3ff948a0bcffe65ffd2dca10707f2509f32c1d65b1d"),
            ModelFile("Preprocessor.mlmodelc/metadata.json", size: 2841, sha256: "2a98699e22d279dd37fa1d238aeb1c6db1df0d6fad687775324157689d8f3acf"),
            ModelFile("Preprocessor.mlmodelc/model.mil", size: 28181, sha256: "4b8518a956450fec57f06c2a21bdffc26973f7f1fa6842fb38fe917f896b6b93"),
            ModelFile("Preprocessor.mlmodelc/weights/weight.bin", size: 491072, sha256: "129b76e3aeafa8afa3ea76d995b964b145fe83700d579f6ff42c4c38fa0968ea"),
            ModelFile("parakeet_vocab.json", size: 151122, sha256: "7ec60e05f1b24480736ec0eed40900f4626bce1fa9a60fd700ec7e2a59198735"),
        ],
        marker: nil, shadows: ["parakeet-tdt-0.6b-v3/.fluidaudio-revision"])

    public static let diarizer = ModelRelease(
        id: "diarizer", displayName: "speaker detection model",
        repository: "FluidInference/speaker-diarization-coreml", folderName: "speaker-diarization",
        revision: "df2625ac79a7ac6b65ad868fee6d80f320da4232",
        files: [
            ModelFile("Embedding.mlmodelc/analytics/coremldata.bin", size: 243, sha256: "8d6706436639b53830b4dbe8aaf9c9a843f7f582d63e16f3cb8bb7c6ccd58682"),
            ModelFile("Embedding.mlmodelc/coremldata.bin", size: 704, sha256: "4a705bac27d151d9642f37609296042a15602a42253039e0921dc9e75da7e004"),
            ModelFile("Embedding.mlmodelc/metadata.json", size: 2818, sha256: "1854371eb6b438fb8aeac96afb45c999af7902581c06afdfcd7ff3cb1ce66be5"),
            ModelFile("Embedding.mlmodelc/model.mil", size: 78432, sha256: "22fa958aef72a561c21f874a07cbdcd30fdf40ee961c0bc2fb67c119273b46d3"),
            ModelFile("Embedding.mlmodelc/weights/weight.bin", size: 13412288, sha256: "99356b2985b8d43880a657024d941d450b38820451ccff903f76ed4e52d1868b"),
            ModelFile("FBank.mlmodelc/analytics/coremldata.bin", size: 243, sha256: "0e8bd3a8b82ac123580989f490e4d9245127c535857630b543311268accc3f0a"),
            ModelFile("FBank.mlmodelc/coremldata.bin", size: 853, sha256: "57ac436bb0671cbb5527a339134d695f752eb77f7a18966b93c6835335595759"),
            ModelFile("FBank.mlmodelc/metadata.json", size: 3409, sha256: "2623785f5d186893b82d01e84aa33a7704ef763c3309e02055f22dc9d871ce9a"),
            ModelFile("FBank.mlmodelc/model.mil", size: 15667, sha256: "27aaeb21569e81bdbe2eef87789f50a37cfea800039bd134448a9417de2f30ed"),
            ModelFile("FBank.mlmodelc/weights/weight.bin", size: 1776896, sha256: "9e83fdd3ea78064b078069e4d9141603c61c47a27fd19e7e3142ff7476f8db36"),
            ModelFile("PldaRho.mlmodelc/analytics/coremldata.bin", size: 243, sha256: "8940ea6044dbcbefa22da8cc41e0b485e1fb5ed89aecaf37c6e0c483a97ddcd7"),
            ModelFile("PldaRho.mlmodelc/coremldata.bin", size: 763, sha256: "4d9741477f721c79b09fcdfe455110c4b7d4272e2de3496bf1729d966d3ee418"),
            ModelFile("PldaRho.mlmodelc/metadata.json", size: 2749, sha256: "b314cf25a93e46b4076883a6f5a2f8848b73c3851bd9d36074d067f35a1c7945"),
            ModelFile("PldaRho.mlmodelc/model.mil", size: 7613, sha256: "83aee2e5310d19b5f202aea97d07a0e12102556d1b32ef3ed08b36f7f9725041"),
            ModelFile("PldaRho.mlmodelc/weights/weight.bin", size: 200192, sha256: "80f7d229202636d372428c90596f11a91545f07da77259f07153aaf225914a36"),
            ModelFile("Segmentation.mlmodelc/analytics/coremldata.bin", size: 243, sha256: "64265f8e7ad41a5f68d630c15288c2499cca5892ad49e20096819cdeac004cdb"),
            ModelFile("Segmentation.mlmodelc/coremldata.bin", size: 812, sha256: "ea51481b8bd3e496ad3cf16f066ddaa37f20e8772eaac76b3393c28de20e06bc"),
            ModelFile("Segmentation.mlmodelc/metadata.json", size: 3410, sha256: "88dbf0b07208fe142e1729c2b4c974ad3599fcb2ae5d5f18fce782b225384124"),
            ModelFile("Segmentation.mlmodelc/model.mil", size: 43063, sha256: "d37e4ce30b406a6b34f765f769b9baed3178cc0c2b2e299c641daa43a052dd3f"),
            ModelFile("Segmentation.mlmodelc/weights/weight.bin", size: 5959360, sha256: "c3189a64946c75bc24fcb98afe89ad78c52bdbadfdf65e857fb1b81e2cc9fbb2"),
            ModelFile("plda-parameters.json", size: 89416, sha256: "38ee28d4269c076cef254ee760bbd811f0738a92e0f01f9699ad372828c5de8f"),
        ],
        marker: ".fluidaudio-revision", shadows: ["plda-parameters.json"])

    public static let all = [parakeetV3, diarizer]
}
