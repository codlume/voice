#!/usr/bin/env bash
# Prints GitHub output `due=true|false` for deploying HEAD with workflow file $1 when any of the
# remaining path arguments changed since that workflow's last successful deploy. MANUAL=true deploys
# without a change. Every deploy needs green CI on HEAD.
set -euo pipefail

workflow="$1"
shift
head="$(git rev-parse HEAD)"

if ! bash scripts/release-ci-passed.sh "${head}"; then
  echo "due=false"
  exit 0
fi
if [[ "${MANUAL:-false}" == true ]]; then
  echo "Manual run; deploying" >&2
  echo "due=true"
  exit 0
fi
# A run that skipped its deploy job still succeeds, so find the last run that really deployed.
last=""
for run in $(gh run list --workflow "${workflow}" --branch main --status success --limit 30 \
  --json databaseId,headSha --jq '.[] | "\(.databaseId):\(.headSha)"'); do
  deployed="$(gh run view "${run%%:*}" --json jobs \
    --jq '[.jobs[] | select(.name == "deploy" and .conclusion == "success")] | length')"
  if [[ "${deployed}" != 0 ]]; then
    last="${run#*:}"
    break
  fi
done
if [[ -z "${last}" ]] || ! git cat-file -e "${last}^{commit}" 2>/dev/null; then
  echo "No earlier deploy to compare with; deploying" >&2
  echo "due=true"
  exit 0
fi
# CI runs can finish out of order, so an older commit must not replace a newer deploy.
if [[ "${last}" != "${head}" ]] && git merge-base --is-ancestor "${head}" "${last}"; then
  echo "Newer ${last} is already deployed; skipping" >&2
  echo "due=false"
  exit 0
fi
if git diff --quiet "${last}" "${head}" -- "$@"; then
  echo "Nothing to deploy since ${last}" >&2
  echo "due=false"
  exit 0
fi
echo "Deploying changes since ${last}" >&2
echo "due=true"
