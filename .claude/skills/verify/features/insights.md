# Insights

The Insights page shows how much a user dictates: words dictated, speaking pace in WPM, fixes made by Voice, the current and longest streak of days with dictation, and a heatmap of words per day that ends today. It counts every session that produced a transcript and ended `inserted` or `notInserted`. A cancelled, too short, or silent session counts nothing. Words come from the raw transcript, so a snippet counts its spoken trigger, not its expansion. Pace leaves out the quiet before and after the user speaks. Counts stay on this Mac in `<userData>/insights.json`, which holds numbers and dates, never dictated words. A user can clear them from Settings.

## Sub-features

- `insights-totals`: the Words, Pace, and Fixes made by Voice cards. Pace says "Dictate to see how fast you speak." until the first counted session. Fixes says "None yet" at zero, and otherwise lists `Words corrected` and `Dictionary fixes`.
- `insights-streak`: the Streak card shows current and longest days. A day with no words yet keeps yesterday's streak.
- `insights-heatmap`: one cell per day, Sunday to Saturday per column, with as many weeks as fit, up to 53. Hovering or focusing a cell shows "<n> words on <weekday, month day>". Tab reaches one cell, today's or the one last focused. Up and Down move a day, Left and Right a week, Home goes to the first day, and End goes to today.
- `insights-live`: an open page updates after each counted session, without a reload.
- `insights-persist`: counts survive a restart.
- `insights-clear`: Settings > Data and Privacy > `Clear…` asks "Clear insights?" and, after `Clear`, deletes the file and resets an open Insights page to zero.

## How to get to it (user POV)

- Voice window sidebar: `Insights`, after Home.
- Keyboard: Cmd-2 in the Voice nav.
- Clearing: Voice window > `Settings` > `Data and Privacy` > Insights > `Clear…`.

## Driving it with voice-verify

Preconditions: baseline on a fresh userData, so the page starts at zero. `dictate` needs the desktop to itself.

- **Open Insights.** `vv click Insights`, then `vv wait hub 'document.querySelector("main h1")?.textContent === "Insights"'`. Then `vv shot insights-empty`. Words reads 0, Pace shows the "Dictate to see" line, and Fixes reads "None yet".
- **Count a session.** `vv dictate short.wav`. Then `vv wait hub 'window.voice.getInsights().then(i => Object.keys(i.days).length === 1)'` and `vv shot insights-counted`. Words equals the word count of `latest.raw` from the `dictate` output, Pace shows a WPM, and the current streak is 1 day. Run `vv dictate long.wav` with the page open: Words grows without a reload, and with cleanup on, Words corrected is above zero because cleanup drops "um" and "uh".
- **Stored value.** `cat "<userData>/insights.json"` has `"version": 1`, today's date under `"days"`, and none of the dictated words.
- **Heatmap by keyboard.** `voice-verify` cannot press keys, so check the parts it can reach. `vv eval hub 'document.querySelectorAll("[aria-label=\"Words per day\"] [tabindex=\"0\"]").length'` prints 1, and that cell's `aria-label` names today. Focus it with `.focus()`, then dispatch a bubbling `keydown` with `key: "ArrowLeft"` on `document.activeElement`. The new `document.activeElement` names the same weekday a week earlier. The tooltip opens only on keyboard focus, so a human checks it with Tab.
- **Persistence.** `vv stop --keep-user-data`, then `vv launch --keep-user-data`, then open Insights. The totals match the earlier shot.
- **Clear.** `vv click Settings`, `vv click "Data and Privacy"`, `vv click "Clear…"`, then `vv click Clear`. `ls "<userData>/insights.json"` fails. Click `Back`, then `Insights`, and the page shows zeros. `vv dictate short.wav` afterwards counts from zero.
- **Clear resets an open page.** The Settings path leaves Insights, so with Insights open, run `vv eval hub 'window.voice.clearInsights().then(() => true)'`. The open page drops to zero without a reload.

## Gotchas

- The page reads today's date on each render. A hub left open overnight moves to the new day on the next dictation or when the window regains focus.
- A file Voice cannot read is left alone and nothing is counted until it is cleared. A failed save is logged, and the page still shows the in-memory count.
- The heatmap is hidden until the page knows its width, so wait for the grid before a shot.
