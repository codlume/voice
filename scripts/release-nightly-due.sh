#!/usr/bin/env bash
# Prints due=true or due=false for building a Nightly of HEAD.
# Scheduled runs build only when main moved since the last Nightly; MANUAL=true forces a build.
# A Stable release commit never gets a Nightly because that build would duplicate Stable.
set -euo pipefail

head="$(git rev-parse HEAD)"
stable="v$(node -p 'require("./package.json").version')"
if [[ "$(git rev-parse -q --verify "refs/tags/${stable}^{commit}" || true)" == "${head}" ]]; then
  echo "HEAD is Stable ${stable}; skipping Nightly" >&2
  echo "due=false"
  exit 0
fi
if [[ "${MANUAL:-false}" == true ]]; then
  echo "Manual run; building Nightly" >&2
  echo "due=true"
  exit 0
fi

latest="$(gh release list --exclude-drafts --limit 100 --json tagName,isPrerelease \
  --jq '[.[] | select(.isPrerelease and (.tagName | test("-nightly\\.")))][0].tagName // empty')"
if [[ -n "${latest}" && "$(git rev-parse "refs/tags/${latest}^{commit}")" == "${head}" ]]; then
  echo "Nightly ${latest} already covers HEAD; skipping" >&2
  echo "due=false"
  exit 0
fi
echo "Building Nightly; last was ${latest:-none}" >&2
echo "due=true"
