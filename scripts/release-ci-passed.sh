#!/usr/bin/env bash
# Exits 0 only when CI's push run for commit $1 finished green.
set -euo pipefail

sha="$1"
state="$(gh run list --workflow ci.yml --commit "${sha}" --event push --limit 1 \
  --json status,conclusion --jq '.[0] // {} | "\(.status // "missing"):\(.conclusion // "")"')"
if [[ "${state}" == completed:success ]]; then
  echo "CI passed on ${sha}" >&2
  exit 0
fi
echo "::warning::CI on ${sha} is ${state%:}; not shipping it" >&2
exit 1
