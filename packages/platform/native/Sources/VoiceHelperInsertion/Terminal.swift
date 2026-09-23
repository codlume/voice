import Foundation

// Terminal delivery. A terminal runs whatever reaches it after a line ending, and it cannot tell
// dictated text from typing, so the text is reduced to one line of printable characters before it
// is typed: every line or paragraph break, tab, escape, and other control character becomes a
// space. Without a line ending or control sequence nothing can submit, interrupt, or leave a
// bracketed paste; the user presses Return. Typing, not the clipboard, keeps a slow terminal from
// pasting the user's own clipboard after Voice restores it.
public func terminalLine(_ text: String) -> String {
    var line = ""
    var space = false
    for scalar in text.unicodeScalars {
        // Cc covers C0, DEL, and C1 controls; whitespace covers every line and paragraph separator.
        if scalar.properties.generalCategory == .control || scalar.properties.isWhitespace {
            space = !line.isEmpty
            continue
        }
        if space { line.unicodeScalars.append(" ") }
        space = false
        line.unicodeScalars.append(scalar)
    }
    return line
}

// UTF-16 chunks for keyboard events, which carry at most 20 units; a surrogate pair never splits.
public func typingChunks(_ text: String, limit: Int = 20) -> [[UniChar]] {
    var chunks: [[UniChar]] = []
    var chunk: [UniChar] = []
    for character in text {
        let units = Array(character.utf16)
        if chunk.count + units.count > limit, !chunk.isEmpty {
            chunks.append(chunk)
            chunk = []
        }
        chunk.append(contentsOf: units)
    }
    if !chunk.isEmpty { chunks.append(chunk) }
    return chunks
}
