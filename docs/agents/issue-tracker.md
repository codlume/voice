# Issue tracker

Issues and specs live in GitHub Issues for `codlume/voice`.
Use the `gh` CLI from this repository.

## Operations

- Create: `gh issue create --title "..." --body-file <path>`.
- Read: `gh issue view <number> --comments`.
- List: `gh issue list --state open`, with label filters as needed.
- Comment: `gh issue comment <number> --body-file <path>`.
- Apply labels: `gh issue edit <number> --add-label "..."`.
- Remove labels: `gh issue edit <number> --remove-label "..."`.
- Close: `gh issue close <number>`.

For multiline bodies, write the exact text to a temporary file and
pass it through `--body-file`.

When a skill says to publish to the issue tracker, create a GitHub
issue. When it says to fetch a ticket, read the issue and its comments.

Before creating or labeling an issue, read `docs/agents/triage-labels.md`.

## Pull requests as a triage surface

**PRs as a request surface: no.**
