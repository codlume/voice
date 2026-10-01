# Release Voice for macOS

Voice publishes Apple Silicon builds from the Release workflow. Every six
hours, a scheduled run builds a Nightly of `main` if `main` changed since
the last Nightly. Run the workflow manually to build a Nightly now. A Stable
release commit never gets a Nightly. When you merge a release-please PR, the
push run publishes Stable from the tagged commit. Rerun that workflow if
Stable publication fails; it detects the GitHub release tag on the commit.
The workflow does not depend on a tag event from `GITHUB_TOKEN`.
Release-please versions the repository root and updates the desktop package
version in the same release PR. Changes to the native helper and cleanup
package therefore count toward Stable releases.

## Configure GitHub and Cloudflare

The configured production bucket is `voice-releases` in account
`703db63a7a65b568d7e34b95ec34fa83`, served at
`https://downloads.voice.codlume.com`. The three repository variables below
are already configured. Signing and upload secrets still need to be added.

1. For a new environment, create an R2 bucket. Attach a public HTTPS custom domain. Route that domain
   to the bucket root, so `https://downloads.example.com/channels/stable/mac-arm64/latest-mac.yml`
   resolves to the object with that key. Configure the public domain to bypass
   caching for `/channels/*`. Versioned `/releases/*` objects can be cached.
2. Create an R2 API token with Object Read and Write access to that bucket.
   Add `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` as repository secrets.
3. Add repository variables `R2_ACCOUNT_ID`, `R2_BUCKET`, and
   `RELEASE_BASE_URL`. Set `RELEASE_BASE_URL` to the public HTTPS root,
   without a trailing slash or `/channels` suffix.
4. Export a Developer ID Application certificate with its private key as a
   password-protected P12. Base64-encode the P12 and add it as the
   `APPLE_CERTIFICATE` secret. Add its password as
   `APPLE_CERTIFICATE_PASSWORD`.
5. Add `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`
   as repository secrets. The Apple ID must be able to notarize for that team.
   The workflow creates a temporary keychain, signs the helper and native
   libraries, signs the app, and asks Apple to notarize it. A missing identity
   or failed notarization stops publication.
6. Allow GitHub Actions to create pull requests in repository settings.
   Add `RELEASE_PLEASE_TOKEN` with contents and pull request write access
   if generated release PRs must trigger CI. The default `GITHUB_TOKEN`
   can create those PRs, but its events do not trigger other workflows.
   The workflow uses the custom token only for release-please.

The workflow builds a DMG for manual installation and a ZIP for updates.
Both live at `/releases/<version>/mac-arm64/`. After promotion, the workflow
also attaches the DMG to a GitHub release. Stable uses the release-please
release. Its notes are GitHub's generated release notes, which list each
pull request since the previous stable tag with its author. Each Nightly
gets its own prerelease tagged `v<version>` on the built commit, such as
`v0.1.1-nightly.20260926.42` for the UTC date and workflow run number. Its
notes list the pull requests merged since the previous Nightly. Nightly
prereleases are kept, not pruned; the six-hour schedule bounds how many
accumulate. Release-please ignores these tags because it only matches the
version in `.release-please-manifest.json`. The app embeds the build channel
and `RELEASE_BASE_URL`. Each channel has its own
`/channels/<channel>/mac-arm64/latest-mac.yml` feed. The feed contains
absolute URLs for immutable release artifacts.

The publisher checks every artifact's size and SHA-256 after uploading it.
It checks the builder's SHA-512 and size fields before uploading. It writes
the channel feed last. A rerun cannot replace different bytes under an
existing version. An older run cannot move a feed backward. The promotion
job is serialized per channel, and a failed upload leaves the prior feed in
place. Nightly and Stable builds run independently; only promotion is
serialized. A Nightly that finishes after a newer one gets `skipped-older`
and no GitHub prerelease. A rerun skips building when the channel already
serves a newer version, or the same version with verified artifacts. Missing
or corrupt published artifacts stop the run; restore the exact original
files from the retained workflow artifact or publish a new version.

## Configure Sentry

Crash reports are opt-in. An app sends nothing unless it was built with a
DSN and its user chose to share. The configured project is `voice` in
organization `codlume`, and the repository variables and secret below are
already set.

1. Create a Sentry project for Electron. Add its DSN as the `SENTRY_DSN`
   repository variable. The build bakes it into the app as
   `VOICE_SENTRY_DSN`. Without it, the app cannot send diagnostics at all.
2. Add an organization auth token as the `SENTRY_AUTH_TOKEN` secret, and
   the organization and project slugs as the `SENTRY_ORG` and
   `SENTRY_PROJECT` repository variables. Before packaging, the build
   injects debug IDs into the bundles and uploads their source maps for
   release `voice@<version>`. Without the token, the build skips the upload
   and says so. With the token, a missing slug stops the build. Renaming
   the project changes its slug, so update `SENTRY_PROJECT` with it.
3. In the project's Security & Privacy settings, turn on Prevent Storing of
   IP Addresses, and add an advanced data scrubbing rule that removes
   anything from `$user.geo.**`. Sentry derives a city from the connection
   address before it drops the address, so the switch alone still stores a
   location.

Native crash events arrive without their minidump, so Voice uploads no
native symbols. A dump holds whole thread stacks, including the process
environment, and nothing can scrub it before it leaves the Mac.

## Publish and recover

Merge to `main`, then wait for the next scheduled run or run the workflow
manually to publish a Nightly. Merge the release-please PR to publish
Stable. Watch the Release workflow. A successful run ends with `published`,
`already-published`, or `skipped-older`. To recover from a failed run, rerun
that workflow from GitHub Actions. If only the GitHub release step failed,
use **Re-run failed jobs**. A full rerun skips the already-published version
and does not retry the GitHub upload. If a run uploaded immutable artifacts
but failed before promoting the feed, rebuilding the same version can
produce different bytes. Keep the existing objects and publish a new version
in that case.

Check the channel feed over the public URL after the run. Confirm that its
ZIP URL resolves, that the downloaded ZIP hash matches the feed's SHA-512,
and that macOS accepts the app's signature. Test installation and update
with a separate staging bucket and public domain before enabling production
settings. Local unsigned `dist:mac` builds are development artifacts and
must not be published.
