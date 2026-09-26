# Release Voice for macOS

Voice publishes Apple Silicon builds from the Release workflow. Each push to
`main` builds a Nightly. When you merge a release-please PR, that workflow
run publishes Stable from the tagged commit instead of a Nightly. Rerun that workflow
if Stable publication fails; it detects the GitHub release tag on the commit.
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
release. Each Nightly gets its own prerelease tagged `v<version>` on the built
commit. Release-please ignores these tags because it only matches the version
in `.release-please-manifest.json`. The app embeds the build
channel and `RELEASE_BASE_URL`. Each channel has its own
`/channels/<channel>/mac-arm64/latest-mac.yml` feed. The feed contains
absolute URLs for immutable release artifacts.

The publisher checks every artifact's size and SHA-256 after uploading it.
It checks the builder's SHA-512 and size fields before uploading. It writes
the channel feed last. A rerun cannot replace different bytes under an
existing version. An older run cannot move a feed backward. The promotion
job is serialized per channel, and a failed upload leaves the prior feed
in place. Builds run independently; only promotion is serialized. A rerun
skips building when the channel already serves a newer version, or the same
version with verified artifacts. Missing or corrupt published artifacts stop
the run; restore the exact original files from the retained workflow artifact
or publish a new version.

## Publish and recover

Merge to `main` to publish a Nightly. Merge the release-please PR to publish
Stable. Watch both jobs in the Release workflow. A successful run ends with
`published`, `already-published`, or `skipped-older`. To recover from a
failed run, rerun that workflow from GitHub Actions. If only the GitHub
release step failed, use **Re-run failed jobs**. A full rerun skips the
already-published version and does not retry the GitHub upload. If a run uploaded
immutable artifacts but failed before promoting the feed, rebuilding the
same version can produce different bytes. Keep the existing objects and
publish a new version in that case.

Check the channel feed over the public URL after the run. Confirm that its
ZIP URL resolves, that the downloaded ZIP hash matches the feed's SHA-512,
and that macOS accepts the app's signature. Test installation and update
with a separate staging bucket and public domain before enabling production
settings. Local unsigned `dist:mac` builds are development artifacts and
must not be published.
