# Contributing to pi-worktree

## Setup

```bash
bun install
```

## Pre-push Quality Gates

Before any `git push`, run these commands locally and confirm all pass:

```bash
bunx biome check .      # Linting — zero violations
bunx tsc --noEmit       # Type check — zero errors
bun run test            # Tests — all passing
```

Never push to "see if CI catches anything." Fix locally first.

## Commit Format

Use [Conventional Commits](https://www.conventionalcommits.org/) with issue scope:

```bash
feat(#2): add Worktree.create with collision detection
chore(#5): mirror pi-permissions CI workflow
fix(#3): correct PI_SUBAGENT_STACK propagation
```

## PR Rules

- Always pass `--base main` to `gh pr create` (this repo uses squash-only merges)
- Include `Fixes #N` on its own line at the top of the PR **body** (not the title) — this is required for squash-merge auto-close (repo setting: `squash_merge_commit_message=PR_BODY`)
- Example:
  ```bash
  gh pr create \
    --base main \
    --title "feat: add Worktree.create API" \
    --body "Fixes #2

  Implements the core Worktree.create method with branch collision detection."
  ```

PRs auto-close linked issues on squash merge. Note that conventional commit scopes like `feat(#7):` do NOT auto-close — only `Fixes #7` (or `Closes #7`/`Resolves #7`) does.

## See Also

See [AGENTS.md](AGENTS.md) for the full agent-driven workflow and quality standards.