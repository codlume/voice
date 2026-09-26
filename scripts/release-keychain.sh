#!/usr/bin/env bash
set -euo pipefail

keychain="${RUNNER_TEMP:?}/voice-release.keychain-db"
certificate="${RUNNER_TEMP}/voice-release.p12"
if [[ "${1:-}" == cleanup ]]; then
  security delete-keychain "${keychain}" 2>/dev/null || true
  rm -f "${certificate}"
  exit 0
fi

: "${CERTIFICATE:?Missing APPLE_CERTIFICATE}"
: "${CERTIFICATE_PASSWORD:?Missing APPLE_CERTIFICATE_PASSWORD}"
: "${APPLE_ID:?Missing APPLE_ID}"
: "${APPLE_APP_SPECIFIC_PASSWORD:?Missing APPLE_APP_SPECIFIC_PASSWORD}"
: "${APPLE_TEAM_ID:?Missing APPLE_TEAM_ID}"
password="$(openssl rand -hex 32)"
printf '%s' "${CERTIFICATE}" | base64 -D > "${certificate}"
security create-keychain -p "${password}" "${keychain}"
security unlock-keychain -p "${password}" "${keychain}"
security list-keychains -d user -s "${keychain}"
security set-keychain-settings -lut 21600 "${keychain}"
security import "${certificate}" -k "${keychain}" -P "${CERTIFICATE_PASSWORD}" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "${password}" "${keychain}"
identity="$(security find-identity -v -p codesigning "${keychain}" |
  sed -nE 's/.*"(Developer ID Application: [^"]+)".*/\1/p' | head -n 1)"
if [[ -z "${identity}" || "${identity}" != *"(${APPLE_TEAM_ID})" ]]; then
  echo "No Developer ID Application identity for configured team" >&2
  exit 1
fi
echo "CSC_KEYCHAIN=${keychain}" >> "${GITHUB_ENV:?}"
echo "CSC_NAME=${identity}" >> "${GITHUB_ENV}"
echo "APPLE_SIGN_IDENTITY=${identity}" >> "${GITHUB_ENV}"
