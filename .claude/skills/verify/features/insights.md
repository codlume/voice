# Insights

The Insights page shows how much a user dictates: words dictated, speaking pace in WPM, fixes made by Voice, the current and longest streak of days with dictation, a heatmap of words per day that ends today, and where the user dictates by app and Style category. It counts every session that produced a transcript and ended `inserted` or `notInserted`. A cancelled, too short, or silent session counts nothing. Words come from the raw transcript, so a snippet counts its spoken trigger, not its expansion. Pace leaves out the quiet before and after the user speaks. Counts stay on this Mac in `<userData>/insights.json`, which holds numbers, dates, and the bundle ids of the apps dictated into, never dictated words or websites. A user can clear them from Settings.

## Sub-features

- `insights-totals`: the Pace, Words, and Fixes made by Voice cards, in that order. Pace says "Dictate to see how fast you speak." until the first counted session, then shows WPM and "N× faster than typing" when that is above typing speed. Fixes says "None yet" at zero, and otherwise lists `Words corrected` and `Dictionary fixes`, each only when above zero, with its own number only when the other is also present.
- `insights-streak`: the Streak card shows current and longest days. A day with no words yet keeps yesterday's streak.
- `insights-heatmap`: one cell per day, Sunday to Saturday per column, with as many weeks as fit, up to 53. Hovering or focusing a cell shows "<n> words on <weekday, month day>". Tab reaches one cell, today's or the one last focused. Up and Down move a day, Left and Right a week, Home goes to the first day, and End goes to today.
- `insights-usage`: the "Where you dictate" card shows the number of apps used, one bar per Style category with its share of words and number of dictations, and up to five top apps. A dictation into a website counts under the browser, in the website's category when Voice detected the website. A session with no known app counts in Words but not on the card. Until then the card says "Dictate into an app to see where your words go."
- `insights-live`: an open page updates after each counted session, without a reload.
- `insights-persist`: counts survive a restart.
- `insights-clear`: Settings > Data and Privacy > `Clear…` (named `Clear insights`) asks "Clear insights?" and, after `Clear`, deletes the file and resets an open Insights page to zero.

## How to get to it (user POV)

- Voice window sidebar: `Insights`, after Home.
- Home's `Your stats` card: `vv click 'css:aside[aria-label="Your stats"] button'`. Its accessible name is the card's text, so click it by selector.
- Keyboard: Cmd-3 in the Voice nav.
- Clearing: Voice window > `Settings` > `Data and Privacy` > Insights > `Clear…`.

## Driving it with voice-verify

Preconditions: baseline on a fresh userData, so the page starts at zero. `dictate` needs the desktop to itself.

- **Open Insights.** `vv click Insights`, then `vv wait hub 'document.querySelector("main h1")?.textContent === "Insights"'`. Then `vv shot insights-empty`. Words reads 0, Pace shows the "Dictate to see" line, and Fixes reads "None yet".
- **Count a session.** `vv dictate short.wav`. Then `vv wait hub 'window.voice.getInsights().then(i => Object.keys(i.days).length === 1)'` and `vv shot insights-counted`. Words equals the word count of `latest.raw` from the `dictate` output, Pace shows a WPM, and the current streak is 1 day. Run `vv dictate long.wav` with the page open: Words grows without a reload, and with cleanup on, Words corrected is above zero because cleanup drops "um" and "uh".
- **Stored value.** `cat "<userData>/insights.json"` has `"version": 2`, today's date under `"days"`, and none of the dictated words.
- **Where you dictate.** On a fresh userData, run `vv dictate short.wav --app=com.apple.mail` and `vv dictate short.wav --app=com.google.Chrome@mail.google.com`. Then `vv wait hub 'window.voice.getInsights().then(i => i.categories.email.sessions === 2)'` and `vv shot insights-usage`. The card reads 2 apps used, Email at 100% with 2 dictations, the other three categories at 0%, and Mail and Chrome under Top apps. `insights.json` has `"version": 2`, `com.apple.mail` and `com.google.chrome` under `"apps"`, and no `mail.google.com`.
  - `--app=…@host` makes the helper's test target report the host directly (`native/voice-helper/Sources/VoiceHelper/main.swift`, the `captureStart` case), bypassing host detection. So this flow cannot prove that cleanup off or a non-English language leaves the website out. The unit tests in `apps/desktop/src/main/dictation.test.ts` cover those cases.
- **Heatmap by keyboard.** `voice-verify` cannot press keys, so check the parts it can reach. `vv eval hub 'document.querySelectorAll("[aria-label=\"Words per day\"] [tabindex=\"0\"]").length'` prints 1, and that cell's `aria-label` names today. Focus it with `.focus()`, then dispatch a bubbling `keydown` with `key: "ArrowLeft"` on `document.activeElement`. The new `document.activeElement` names the same weekday a week earlier. The tooltip opens only on keyboard focus, so a human checks it with Tab.
- **Persistence.** `vv stop --keep-user-data`, then `vv launch --keep-user-data`, then open Insights. The totals match the earlier shot.
- **Clear.** With Insights open and counted, `vv click Settings`, `vv click "Data and Privacy"`, `vv click "Clear insights"`, then `vv click Clear`. `ls "<userData>/insights.json"` fails. `vv key Escape` closes Settings onto the same Insights page, which shows zeros without a reload. `vv dictate short.wav` afterwards counts from zero.

## Gotchas

- A hub left open overnight moves to the new day at local midnight, and again whenever the window regains focus or becomes visible.
- A file Voice cannot read, or one from another version, is left alone and nothing is counted until it is cleared. A file that is not JSON starts counting over, and the next save replaces it. A failed save is logged, and the page still shows the in-memory count.
- The heatmap is hidden until the page knows its width, so `vv wait hub 'document.querySelector("[aria-label=\"Words per day\"]")'` before a shot.
- A plain `vv dictate` with no `--app` types into the scratch window, which the helper reports as `com.github.electron`. It counts under Other and shows as a raw bundle id in Top apps. Only the unit tests reach the no-known-app path.
