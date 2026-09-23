import Testing
import VoiceHelperInsertion

// Synthetic transcripts that would run, interrupt, or escape a terminal if typed verbatim.
// Every one must become a single line of printable characters.
let hostile: [String] = [
    "echo synthetic\n",
    "first line\r\nsecond line",
    "paragraph one\n\nparagraph two",
    "echo a\rrm -rf scratch",
    "\u{1b}[201~echo escaped bracketed paste\n",
    "tab\tcompletion",
    "interrupt \u{03} and eof \u{04} and delete \u{7f}",
    "c1 next line\u{85}and csi \u{9b}201~",
    "unicode line\u{2028}and paragraph\u{2029}separators",
    "form\u{0c}feed and vertical\u{0b}tab",
]

@Test(arguments: hostile)
func terminalLineCannotSubmitOrControl(_ text: String) {
    let line = terminalLine(text)
    #expect(!line.isEmpty)
    for scalar in line.unicodeScalars {
        #expect(scalar.properties.generalCategory != .control, "control U+\(String(scalar.value, radix: 16))")
        #expect(scalar == " " || !scalar.properties.isWhitespace, "separator U+\(String(scalar.value, radix: 16))")
    }
    #expect(!line.hasPrefix(" ") && !line.hasSuffix(" ") && !line.contains("  "))
}

@Test func terminalLineKeepsPrintableText() {
    #expect(terminalLine("Hello, Priya. Do not deploy VX-204.") == "Hello, Priya. Do not deploy VX-204.")
    #expect(terminalLine("paragraph one\n\nparagraph two") == "paragraph one paragraph two")
    #expect(terminalLine("git commit -m \"fixed café 🎙️\"") == "git commit -m \"fixed café 🎙️\"")
    #expect(terminalLine("\n\t \n") == "")
}

@Test func typingChunksKeepEveryUnitAndNeverSplitPairs() {
    let text = String(repeating: "a🎙️b", count: 17)
    let chunks = typingChunks(text)
    #expect(chunks.allSatisfy { $0.count <= 20 })
    #expect(chunks.flatMap { $0 } == Array(text.utf16))
    for chunk in chunks {
        #expect(String(utf16CodeUnits: chunk, count: chunk.count).unicodeScalars.allSatisfy { $0 != "\u{fffd}" })
    }
    #expect(typingChunks("").isEmpty)
}
