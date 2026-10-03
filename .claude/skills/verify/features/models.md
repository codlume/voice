# Models

Voice runs two on-device models: Parakeet for speech recognition and S1-mini for text cleanup. A user sees their state and can install or uninstall each one from Settings > Models. The Home setup checklist also offers the download when a model is missing.

## Sub-features

- `models-status`: each row shows its state: ready, loading, downloading with progress, not installed, or failed with a message.
- `models-uninstall`: `Uninstall <name>` asks for confirmation. Cancel keeps the model. Uninstall removes it, and the row reads "Not installed".
- `models-install`: `Install <name>` installs and loads the model again.
- `models-cleanup-off`: with cleanup off, the S1-mini row reads "Loads when text cleanup is on".
- `models-home-checklist`: a missing model shows on Home's `Set up Voice` checklist as "Not downloaded".

## How to get to it (user POV)

- Voice window > `Settings` (sidebar footer) > `Models`.
- Voice window > `Home` > `Set up Voice` checklist rows `Speech model` and `Cleanup model`.

## Driving it with voice-verify

Preconditions: baseline, both models `ready`.

- **Open.** `vv click Settings`, then `vv click Models`, then `vv wait hub 'document.querySelector("main").innerText.includes("Speech recognition")'`. Then `vv shot models-installed`.
- **Cancel an uninstall.** `vv click "Uninstall S1-mini"`, then `vv click Cancel`. The `cleanup` model state is still `ready`, and `ls -l "$TMPDIR/voice-verify/models"` still lists the symlink.
- **Uninstall.** `vv click "Uninstall S1-mini"`, then `vv click Uninstall`. Wait for `s.models.cleanup.state === "missing"`. The symlink is gone from `$TMPDIR/voice-verify/models`, and the shared cache in `~/Library/Caches/Voice Development/test-models` still has the file.
- **Reinstall without downloading.** First restore the link: `ln -s "$HOME/Library/Caches/Voice Development/test-models/s1-mini-q4_k_m.gguf" "$TMPDIR/voice-verify/models/"`. Then `vv click "Install S1-mini"`. The state reaches `ready`, never `downloading` with a progress above 0.
- **Home checklist.** While a model is missing, `vv click Back`, `vv click Home`, then `vv text`. The output shows "Not downloaded".
- **Full scripted pass.** `stop` the instance and run `node scripts/models-smoke.mjs`.

## Gotchas

- Uninstall deletes the scratch userData's symlink, never the shared test-model cache. If the cache file disappears, that is a bug. Report it.
- Clicking `Install` with no link in place starts a real download, of about 950 MB for Parakeet. Restore the link first.
- The confirmation is an in-window dialog. Its `Cancel` and `Uninstall` buttons are reachable with `click`, and the row button is named `Uninstall <model>`, so the names do not collide.
