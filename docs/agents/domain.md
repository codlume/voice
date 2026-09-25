# Domain docs

This repository uses a single-context layout:

- `CONTEXT.md` at the repository root holds the domain glossary.
- `docs/adr/` holds architecture decision records.

Before exploring the codebase, read `CONTEXT.md` and any ADRs
relevant to the work.

If these files are absent, proceed silently. Create them through
`domain-modeling` when terminology or decisions are resolved.

Use the vocabulary in `CONTEXT.md` when naming domain concepts.
Until it exists, use the glossary in `AGENTS.md`. If a needed term
is missing, reconsider the wording or note the gap for domain modeling.

If a proposal conflicts with an existing ADR, identify the ADR
and explain why the decision should be revisited.
