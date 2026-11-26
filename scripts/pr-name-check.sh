#!/usr/bin/env bash
# Checks a pull request's TITLE and BRANCH (both from the environment) the way the
# conventional workflow requires. Bot branches skip the branch rule, because their
# tools pick the name. release-please names its branch release-please--branches--<base>.
set -euo pipefail

types="feat|fix|chore|refactor|docs|test|perf|build|ci|style|revert"
bot_branch='^(dependabot|renovate)/'
ticket='^\[?[A-Z][A-Z0-9]*-[0-9]+'
semantic_title="^(${types})(\([^()[:space:]][^()]*\))?!?: [^[:space:]].*$"

if [[ "${TITLE}" =~ $ticket ]]; then
  echo "::error::PR title starts with a ticket key: ${TITLE}"; exit 1
fi
if ! [[ "${TITLE}" =~ $semantic_title ]]; then
  echo "::error::PR title is not semantic (type(scope)!: description, type one of ${types}): ${TITLE}"; exit 1
fi
scope=$(sed -nE 's/^[a-z]+\(([^)]*)\).*/\1/p' <<<"${TITLE}")
desc=${TITLE#*: }
if [[ "${scope}" =~ $ticket || "${desc}" =~ $ticket ]]; then
  echo "::error::PR title carries a ticket key: ${TITLE}"; exit 1
fi
echo "ok: ${TITLE}"

if [[ "${BRANCH}" =~ $bot_branch ]]; then echo "ok: bot branch ${BRANCH}"; exit 0; fi
if ! [[ "${BRANCH}" =~ ^(${types})/[a-z0-9._-]+$ ]]; then
  echo "::error::branch is not semantic (type/short-topic, e.g. feat/price-filters): ${BRANCH}"; exit 1
fi
echo "ok: ${BRANCH}"
