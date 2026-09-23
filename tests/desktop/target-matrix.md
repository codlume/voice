# Target-app insertion matrix

Expected outcomes for scratch targets, using deterministic transcript text rather than live
Deepgram output. This is insertion evidence only. The real shortcut -> capture -> Deepgram ->
insertion acceptance is recorded separately (#40). Use new scratch documents and fields only:
send no messages or emails, and edit no private documents. An app that is missing, or that lacks
a permission, counts as missing evidence, not as a pass.

| Target                                                       | Route                                        | Expected outcome                                                                    |
| ------------------------------------------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------- |
| TextEdit (plain and rich)                                    | Accessibility write                          | Inserted at the caret, or over the selection. Paragraph breaks kept.                |
| Notes                                                        | Accessibility write                          | Inserted at the caret, or over the selection.                                       |
| Safari `<input>`/`<textarea>`                                | Accessibility write or clipboard paste       | Inserted or Pasted.                                                                 |
| Chrome `<input>`/`<textarea>`/contenteditable                | `AXManualAccessibility`, then write or paste | Inserted or Pasted.                                                                 |
| Slack, Notion, VS Code (Electron)                            | `AXManualAccessibility`, then write or paste | Inserted or Pasted. Recovery if no text role is exposed.                            |
| Google Docs (Chrome/Safari)                                  | Clipboard paste                              | Pasted, or recovery ("unsupported") if the canvas exposes no text role.             |
| Outlook compose                                              | Accessibility write or paste                 | Inserted or Pasted.                                                                 |
| Terminal, iTerm2, and other known terminals                  | Typed single line                            | Check your target. Line breaks, tabs, and controls become spaces, and nothing runs. |
| Password field, or a terminal with secure keyboard entry     | none                                         | Recovery ("protected").                                                             |
| Focus moved (same app or another app), or moved and returned | none                                         | Recovery ("changed").                                                               |
| Target window closed                                         | none                                         | Recovery ("closed").                                                                |

To check a terminal without running anything, type `false && ` at the prompt, then dictate
"echo synthetic" followed by a pause and "second line". The prompt should show one unexecuted
line: `false && echo synthetic second line`.

## Evidence

| Date       | Mac / macOS            | App versions                                                                                                                                       | Result                                                                                                      |
| ---------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 2026-09-23 | Apple M3, macOS 26.6.2 | TextEdit 1.20, Notes 4.13, Safari 26.6.2, Terminal 2.15 are installed. Chrome, Slack, Notion, Outlook, VS Code, and Google Docs are not installed. | Missing: no live run yet. Automated coverage: terminal sanitization, clipboard ownership, session outcomes. |
