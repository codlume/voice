# Models

Voice runs two on-device models: Parakeet for speech recognition and S1-mini for text cleanup. A user sees their state and can install or uninstall each one from Settings > Models. The Home setup checklist also offers the download when a model is missing.

## Sub-features

- `models-status`: each row's status line reads "Installed" (state `ready`), "Loading", "Downloading N%", "Not installed", or the failure message with `Retry` and `Uninstall`. Only S1-mini offers `Cancel S1-mini` while downloading.
- `models-uninstall`: `Uninstall <name>` asks for confirmation ("Uninstall the cleanup model?" or "Uninstall the speech model?"). Cancel keeps the model. Uninstall removes it, and the row reads "Not installed".
- `models-install`: `Install <name>` installs and loads the model again.
- `models-cleanup-off`: with cleanup off, the S1-mini row reads "Installed. Loads when text cleanup is on."
- `models-home-checklist`: a missing model shows on Home's `Set up Voice` checklist as "Not downloaded" with `Download Speech model` or `Download Cleanup model`, then `Cancel Cleanup model` while downloading and `Retry <kind>` after a failure. The Cleanup model row is hidden with cleanup off or a non-English language. The scratch instance never grants the microphone, so the checklist always shows there.

## How to get to it (user POV)

- Voice window > `Settings` (sidebar footer) > `Models`.
- Voice window > `Home` > `Set up Voice` checklist rows `Speech model` and `Cleanup model`.

## Driving it with voice-verify

Preconditions: baseline, both models `ready`.

- **Open.** `vv click Settings`, then `vv click Models`, then `vv wait hub 'document.querySelector("main").innerText.includes("Speech recognition")'`. Then `vv shot models-installed`.
- **Cancel an uninstall.** `vv click "Uninstall S1-mini"`, then `vv click Cancel`. The `cleanup` model state is still `ready`, and `ls -l "<userData>/models"` still lists the symlink.
- **Uninstall.** `vv click "Uninstall S1-mini"`, then `vv click Uninstall`. Wait for `s.models.cleanup.state === "missing"`. The symlink is gone from `<userData>/models`, and the shared cache in `~/Library/Caches/Voice Development/test-models` still has the file.
- **Reinstall without downloading.** First restore the link: `ln -s "$HOME/Library/Caches/Voice Development/test-models/s1-mini-q4_k_m.gguf" "<userData>/models/"`. Then `vv click "Install S1-mini"`, or `vv click "Download Cleanup model"` on Home. The state reaches `ready`, never `downloading` with a progress above 0.
- **Home checklist.** While a model is missing, `vv click Back`, `vv click Home`, then `vv text`. The output shows "Not downloaded".
- **Stalled download and Cancel.** Start `node .claude/skills/verify/scripts/stalled-model-server.mjs 9461` in the background and record its PID. `launch` with `VOICE_CLEANUP_MODEL_URL=http://127.0.0.1:9461` (launch always re-links both models, so removing the link before launch does nothing), then uninstall S1-mini from Settings > Models as above. `Install S1-mini` sits at "Downloading 1%". `Cancel S1-mini` in Settings ends `missing` with no `.part` file. Repeat from Home with `Download Cleanup model` and `Cancel Cleanup model` for the same result. Leave a third attempt alone; it ends `failed` with "Download stalled. Check your connection and try again." after 30 s. Restore the link and `vv click "Retry Cleanup model"` to reach `ready`. Stop the verify instance and the recorded server PID afterward.
- **Full scripted pass.** `stop` the instance and run `node scripts/models-smoke.mjs`.

## Gotchas

- Uninstall deletes the scratch userData's symlink, never the shared test-model cache. If the cache file disappears, that is a bug. Report it.
- Clicking `Install` with no link in place starts a real download of about 480 MB. Restore the link first. Parakeet has no URL override and no Cancel, so cover its uninstall and reinstall with `node scripts/models-smoke.mjs`.
- The confirmation is an in-window dialog. Its `Cancel` and `Uninstall` buttons are reachable with `click`, and the row button is named `Uninstall <model>`, so the names do not collide.
