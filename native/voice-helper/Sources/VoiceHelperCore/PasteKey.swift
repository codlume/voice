import Carbon.HIToolbox
import Foundation

/// Virtual keycodes name key positions, not letters. Cmd+V has to go to whichever position
/// types "v" in the current layout; on Dvorak that is the ANSI "." key.
public enum PasteKey {
    public static let ansiV: CGKeyCode = 9

    /// The keycode that types `character` unmodified in `layout` (`uchr` data), or nil when
    /// no key does.
    public static func keycode(typing character: Character, in layout: Data) -> CGKeyCode? {
        layout.withUnsafeBytes { bytes -> CGKeyCode? in
            guard let base = bytes.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else {
                return nil
            }
            for code in CGKeyCode(0)..<128 {
                var deadKeys: UInt32 = 0
                var chars = [UniChar](repeating: 0, count: 4)
                var length = 0
                let status = UCKeyTranslate(
                    base, code, UInt16(kUCKeyActionDown), 0, UInt32(LMGetKbdType()),
                    OptionBits(kUCKeyTranslateNoDeadKeysMask), &deadKeys, chars.count, &length, &chars)
                guard status == noErr, length == 1, let scalar = Unicode.Scalar(chars[0]),
                    Character(scalar) == character
                else { continue }
                return code
            }
            return nil
        }
    }
}
