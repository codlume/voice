# Style

Style lets a user turn text cleanup on or off and choose how cleaned-up dictation reads in four categories: Personal messages, Work messages, Email, and Other. Each category has its own style: Formal (caps and punctuation), Casual (caps, no period at the end), or Very casual (no caps, no period at the end). Voice picks the category from the app the user dictates into, and from the website when that app is a browser. Email also lays the text out as an email. With cleanup off, the style cards are disabled on every tab, and dictation is inserted exactly as recognized.

## Sub-features

- `style-cleanup-toggle`: the `Clean up text` switch turns cleanup on and off. Turning it off unloads the cleanup model, which then reports `installed`. Turning it on loads the model again.
- `style-tabs`: four tabs, `Personal messages`, `Work messages`, `Email`, and `Other`. Each tab shows a banner and three cards with an example for that category.
- `style-banners`: each banner reads "This style applies in personal messengers" (workplace messengers, all major email apps, all other apps), then the real icons of the installed built-in apps of that category, up to four, then "+N". Other shows no icons. The list comes from the helper each time the page opens; each icon is rendered the first time a tile shows it, and the tile shows the app's first letter until it arrives.
- `style-assign`: each banner ends with chips for the user's own assignments in that category and a "+" button. "+" opens a popover with a search over installed apps (browsers and Voice left out) and an "Add website" field that takes a host or a pasted URL. An app or site that belongs to another category shows "In Email" and moves when picked. A chip's remove button sends the app or site back to its built-in category or to Other. A built-in app that the user moves leaves its built-in banner.
- `style-pick`: choosing a card on a tab sets that category's style for the next dictation. The other categories keep theirs.
- `style-by-target`: a dictation into Messages uses the Personal style, Slack the Work style, Mail or Gmail in a browser the Email style with the email layout, and anything else the Other style.
- `style-disabled`: with cleanup off, the cards are disabled on every tab and the page explains that the transcript is inserted as recognized.

## How to get to it (user POV)

- Voice window sidebar: `Style`.
- Keyboard: Cmd-3 in the Voice nav jumps to the third sidebar item. In the tab list, the arrow keys move between tabs.

## Driving it with voice-verify

Preconditions: baseline. Cleanup is on. Personal is Casual and the other three categories are Formal.

- **Open Style.** `vv click Style`, then `vv wait hub 'document.querySelector("main h1")?.textContent === "Style"'`. Then `vv shot style-before`. The `Personal messages` tab is selected.
- **Switch tabs.** `vv click "Work messages"`, then `vv wait hub 'document.querySelector("[role=tab][aria-selected=true]")?.textContent === "Work messages"'`. The banner reads "This style applies in workplace messengers" and shows the icons of the installed workplace messengers, such as Slack and Microsoft Teams.
- **Pick a style.** On the Work tab, `vv click "Casual"`, then `vv wait hub 'window.voice.getSnapshot().then(s => s.settings.cleanup.styles.work === "casual")'`. Only the active tab's cards are mounted, so a card title is unique. Then `vv click "Personal messages"` and `vv click "Very casual"`, and wait for `s.settings.cleanup.styles.personal === "veryCasual"`. Email and Other stay `formal`.
- **Assign an app.** `vv click "Add an app or website to Personal messages"`, then `vv wait hub 'document.querySelectorAll("[role=option]").length > 0'`. Focus starts in the search box. `vv type 'css:[role=combobox]' Text`, then `vv click TextEdit`. The popover closes and the banner shows a `TextEdit` chip. `s.settings.cleanup.assignments` holds `{ kind: "app", bundleId: "com.apple.textedit", name: "TextEdit", category: "personal" }`.
- **Move a built-in app.** On Personal, open "+" and search `slack`. The row reads `Slack` with the hint `In Work messages`. `vv click 'css:[role=option]'` moves it: Personal shows a `Slack` chip, and Work's banner no longer shows Slack's icon.
- **Add a website.** On Email, open "+" and `vv type 'css:[placeholder="slack.com or a link"]' 'https://Mail.Example.com/inbox?x=1'`. The field reads "Adds mail.example.com". `vv click Add` adds a `mail.example.com` chip. `not a site` disables Add and reads "Enter a website like slack.com".
- **Remove.** `vv click "Remove TextEdit from Personal messages"` drops the assignment, and focus moves to the "+" button.
- **Stored value.** `cat "<userData>/settings.json"` shows `"cleanup"` with `"styles": { "personal": "veryCasual", "work": "casual", "email": "formal", "other": "formal" }` and `"assignments": []`.
- **Style by target.** With the styles above, run `vv dictate short.wav` once with each `--app`. Every run ends with `outcome.kind` `inserted`.
  - `--app=com.apple.MobileSMS` gets Personal: `inserted` is all lowercase and has no final period.
  - `--app=com.tinyspeck.slackmacgap` gets Work: `inserted` starts with a capital and has no final period.
  - `--app=com.apple.mail` and `--app=com.google.Chrome@mail.google.com` get Email: `inserted` ends with a period, and the greeting is on its own line.
  - `--app=com.google.Chrome@duckduckgo.com` and no `--app` get Other: `inserted` ends with a period, on one line.
- **Turn cleanup off.** `vv click "Clean up text"`, then `vv wait hub 'window.voice.getSnapshot().then(s => !s.settings.cleanup.enabled && s.models.cleanup.state === "installed")' 15000`, then `vv wait hub 'document.querySelector("fieldset").disabled'`. Then `vv shot style-cleanup-off`. The page reads "Turn on cleanup to apply a style. Your transcript is currently inserted as recognized." Switch tabs and the fieldset is still disabled.
- **Turn cleanup on.** `vv click "Clean up text"`, then wait for `s.models.cleanup.state === "ready"` with a 60000 ms timeout.
- **Effect on dictation.** When `dictate` is available, run `vv dictate short.wav` once with cleanup off. Check that `latest.raw === latest.text`, that `inserted` equals the raw text, and that the timing line has no `cleanupMs`.

## Gotchas

- The banner icons come from the real `/Applications`, `/System/Applications` and `~/Applications` of the Mac running the instance, so which icons show depends on what that Mac has installed. Each icon's accessible name is the app name: `[...document.querySelectorAll("[role=tabpanel] img, [role=tabpanel] [role=img]")].map(e => e.alt || e.getAttribute("aria-label"))`.

- Picker rows are `role=option` and their accessible name includes the hint, so `vv click Slack` fails while Slack shows "In Work messages". Filter to one row and click `css:[role=option]`.
- Agents send keys with `vv eval hub 'document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))'`. ArrowUp, ArrowDown and Enter work in the search box, and Escape closes the popover and returns focus to "+".
- Picker rows and chips render their icons the first time they show and read as letters until then. The rows the popover shows first arrive within about 200 ms on a cold cache.

- The switch's accessible name comes from its `<label>`, `Clean up text`. Tabs are named by their labels, and cards by their titles within the active tab.
- The email layout applies only when the dictation has 10 or more words and fits in one cleanup chunk. Shorter dictations into Mail get the Email style on one line. `short.wav` has 17 words.
- The email layout comes from the cleanup model, so the exact line breaks can vary. Check that the greeting is on its own line, not the full text.
- The target never appears in the logs, the session report, or the history. `app` in the `dictate` output is what you passed, not something Voice recorded.
- Cleanup supports English only. With another dictation language, the switch is disabled. Check `settings.dictationLanguage` before treating a disabled switch as a bug.
- Reloading the model after you turn cleanup back on takes seconds. Wait on the model state, not a timer.
