import Testing
@testable import VoiceHelperCore

private let textEdit: Int32 = 501
private let spotlight: Int32 = 777
private let raycast: Int32 = 888

private let keyFocus = KeyFocus(target: textEdit)
private let everyHolder: [KeyFocusHolder] = [.app(textEdit), .app(spotlight), .unnamed, .noAnswer]

@Suite struct KeyFocusTests {
    @Test func aPanelThatHeldKeyFocusSinceTheSessionBeganGetsAKeystrokeAndNoWrite() {
        #expect(keyFocus.route(atStart: .app(spotlight), now: .app(spotlight)) == .panel(spotlight))
    }

    @Test(arguments: [KeyFocusHolder.app(textEdit), .app(raycast), .unnamed, .noAnswer])
    func aPanelThatTookKeyFocusAfterTheSessionBeganRefuses(atStart: KeyFocusHolder) {
        #expect(keyFocus.route(atStart: atStart, now: .app(spotlight)) == .refused(.moved))
    }

    @Test(arguments: everyHolder)
    func theTargetHoldingKeyFocusIsWrittenTo(atStart: KeyFocusHolder) {
        #expect(keyFocus.route(atStart: atStart, now: .app(textEdit)) == .write)
    }

    @Test(arguments: [KeyFocusHolder.unnamed, .noAnswer])
    func anAppThatNeverNamedItselfGetsAKeystrokeAndNoWrite(atStart: KeyFocusHolder) {
        #expect(keyFocus.route(atStart: atStart, now: .unnamed) == .keystroke)
    }

    @Test(arguments: [KeyFocusHolder.app(textEdit), .app(spotlight)])
    func keyFocusPassingFromANamedAppToAnUnnamedOneRefuses(atStart: KeyFocusHolder) {
        #expect(keyFocus.route(atStart: atStart, now: .unnamed) == .refused(.moved))
    }

    @Test(arguments: everyHolder)
    func aReadThatFailsAtInsertGetsAKeystrokeAndNoWrite(atStart: KeyFocusHolder) {
        #expect(keyFocus.route(atStart: atStart, now: .noAnswer) == .keystroke)
    }

    @Test(arguments: [
        (KeyFocusHolder.app(spotlight), KeyFocusHolder.app(spotlight)), (.unnamed, .unnamed), (.app(textEdit), .noAnswer),
    ])
    func aSelectionReadFromTheTargetIsNotPastedIntoAnotherWindow(atStart: KeyFocusHolder, now: KeyFocusHolder) {
        let read = SelectionOrigin.accessibility(text: "draft", range: AXTextRange(location: 0, length: 5))
        #expect(keyFocus.route(atStart: atStart, now: now, selection: read) == .refused(.selectionNotKeyFocus))
        #expect(keyFocus.route(atStart: atStart, now: .app(textEdit), selection: read) == .write)
    }

    @Test func aSelectionCopiedByKeystrokeCameFromThePanelAndGoesBackToIt() {
        let copied = SelectionOrigin.copy(pressStamp: PressStamp(counts: [1, 0, 0, 0]))
        #expect(keyFocus.route(atStart: .app(spotlight), now: .app(spotlight), selection: copied) == .panel(spotlight))
    }

    @Test func aLogLineNamesTheKindOfHolderAndNoProcess() {
        #expect([.app(textEdit), .app(spotlight), .unnamed, .noAnswer].map(keyFocus.describe)
            == ["target", "other", "unnamed", "noAnswer"])
    }
}
