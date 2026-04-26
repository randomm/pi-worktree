# Pi Worktree Plugin — Agent Guidelines

## Plugin Scope

This repo is the **pi-worktree** plugin — git worktree management for parallel agent sessions in the Pi agent harness. It provides safe `Worktree.create/list/remove/reset` with collision prevention, a state machine (pending→ready/failed), persistence, and EventBus integration. The plugin's purpose is to make parallel agent work safe by guarding against the documented data-loss patterns of agentic git-worktree workflows (e.g. Claude Code data-loss bug #39394). The plugin is part of the broader migration from OpenCode to Pi (badlogic/pi-mono); the master migration plan lives in [pi-an/PI_MIGRATION.md](https://github.com/badlogic/pi-an/blob/main/PI_MIGRATION.md).

## Context7: Documentation First

Before writing ANY code, check context7 for current documentation:
- Library APIs and syntax
- Framework patterns and best practices
- Configuration options

Training data may be outdated. Context7 provides authoritative, up-to-date docs.

## Minimalist Engineering Philosophy

**Every line of code is a liability.** Before creating anything:

- **LESS IS MORE**: Question necessity before creation
- **Challenge Everything**: Ask "Is this truly needed?" before implementing
- **Minimal Viable Solution**: Build the simplest thing that fully solves the problem
- **No Speculative Features**: Don't build for "future needs" — solve today's problem
- **Prefer Existing**: Reuse existing code/tools before creating new ones
- **One Purpose Per Component**: Each function/module should do one thing well

### Pre-Creation Challenge (MANDATORY)

Before creating ANY code, ask:
1. Is this explicitly required by the GitHub issue?
2. Can existing code/tools solve this instead?
3. What's the SIMPLEST way to meet the requirement?
4. Will removing this break core functionality?
5. Am I building for hypothetical future needs?

**If you cannot justify the necessity, DO NOT CREATE IT.**

## Pre-Push Quality Gates

**CI is for VERIFICATION, not DISCOVERY.**

Before ANY `git push`, all checks must pass locally:

1. **Linting**: `bunx biome check .` — zero violations
2. **Formatting**: `bunx biome format --write .` — all files formatted
3. **Type checking**: `bunx tsc --noEmit` — zero errors
4. **Tests**: `bun test` — all passing
5. **Coverage**: 80%+ for new code (85%+ for high-risk modules)

Never push to "see if CI catches anything." Fix locally first.

## Testing Standards

- **TDD preferred**: Write tests before implementation
- **Minimum coverage**: 80% for new code, 85%+ for high-risk modules (worktree-ops, persistence, locks)
- **Framework**: Vitest (not Jest)
- **Test files**: Co-located with source (`*.test.ts`) or in `tests/` directory
- **No skipped tests**: No `.skip`, no `xit`, no `test.todo` in committed code
- **Integration tests**: Required for cross-plugin interactions (worktree ↔ permissions ↔ slash commands)

## Worktree Safety

This plugin operates on git worktrees, which means agent-driven workflows on this codebase cannot use the standard "main agent + parallel worktree agents" pattern naively — we'd be testing the very mechanism we're modifying.

### Rules for agent-driven development on pi-worktree

1. **Do NOT use parallel worktrees of pi-worktree itself for development.** Use sequential dispatch on the main worktree. This is unique to this repo.
2. **All worktree operations in tests must use a temp directory** (`tmp/test-repos/`), never the actual dev worktree.
3. **The five footguns the plugin guards against ARE THE SAME five footguns contributors must avoid:**
   - **Branch already checked out elsewhere** — detect before any worktree create
   - **Dirty `remove` data loss** — `git status --porcelain` non-empty + no `--force` → refuse
   - **Prune-before-delete** — never auto-prune metadata while physical dir exists
   - **Detached-HEAD ghosts** — warn loudly on `--detach` or auto-detached states
   - **Locked worktree leftovers** — detect orphaned locks; auto-unlock dead PIDs only
4. **Fail-closed semantics**: persistence corruption → DENY operations, never silently allow.

If a test leaves a stale or locked worktree behind, fix it before commit.

## Code Style & Conventions

### BiomeJS

This project uses [BiomeJS](https://biomejs.dev/) for linting and formatting via a `biome.json` config:

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "formatter": { "enabled": true, "indentStyle": "tab", "indentWidth": 2 },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "javascript": { "formatter": { "quoteStyle": "single", "semicolons": "always" } }
}
```

### TypeScript

- **Strict mode**: `strict: true` in `tsconfig.json`
- **No `@ts-ignore` or `@ts-expect-error`**: Fix the type error instead
- **Explicit types**: Function parameters and return types must be declared
- **No `any`**: Use `unknown` with proper narrowing, or define proper types
- **ESM**: Use `import`/`export`, not `require`

### Zero Bypasses

Forbidden in source code:
- ❌ `@ts-ignore` — fix the type error
- ❌ `@ts-expect-error` — fix the type error
- ❌ `eslint-disable` without justification
- ❌ `biome-ignore` — fix the lint violation

## Git Workflow

### Branch Naming

```
feature/issue-{N}-{slug}    # New features (e.g., feature/issue-3-permissions-plugin)
chore/issue-{N}-{slug}      # Infrastructure tasks (e.g., chore/issue-4-shared-infrastructure)
fix/issue-{N}-{slug}        # Bug fixes
```

### Commit Messages

[Conventional Commits](https://www.conventionalcommits.org/) — include issue number:

```
feat(#3): add picomatch pattern matching for deny rules
chore(#4): implement EventBus for inter-plugin communication
fix(#7): correct PI_SUBAGENT_STACK propagation in nested agents
```

### PR Process

- Link PR to issue: `Fixes #N` in PR description
- Include issue number in all commits: `feat(#N): description`
- All quality gates must pass locally before push
- PRs auto-close linked issues on merge (See "Squash-merge issue linking" below for issue auto-close rules.)

### Squash-merge issue linking

This repo is configured with `squash_merge_commit_title=PR_TITLE`, `squash_merge_commit_message=PR_BODY`, and `allow_merge_commit=false` (squash-only merges; squash commit body = PR description). The guidance below assumes those settings.

GitHub auto-closes a linked issue only when the **merge commit body** contains `Fixes #N` (or `Closes #N`/`Resolves #N`, plus `Fix`/`Close`/`Resolve`/`Fixed`/`Closed`/`Resolved` variants). With this repo's settings, the squash commit body equals the PR description, so put `Fixes #N` in the **PR body** (not the title, not commit messages).

**`(#N)` is NOT a close keyword.** A Conventional-Commits scope like `chore(#7): foo` does not close issue #7. Only `Fixes #7` (or equivalent) does.

**Preferred invocation:**

```bash
oo gh pr create \
  --base main \
  --title "chore: fix squash-merge auto-close" \
  --body "Fixes #7

Updates repo settings and AGENTS.md squash-merge guidance.
"
oo gh pr merge 7 --squash --delete-branch
```

- Pass `--base main` explicitly (a previous PR was opened against the wrong base).
- Do NOT pass `--subject` / `--body` to `gh pr merge` — let GitHub use the PR body.

**After every squash merge, verify the linked issue auto-closed:**

```bash
oo gh issue view N --json state
```

If still OPEN, close manually with `oo gh issue close N --reason completed` AND treat the convention as broken — re-check the repo settings (`squash_merge_commit_message` should be `PR_BODY`, not `COMMIT_MESSAGES`).

## Documentation Policy

### The 200-PR Test

Before creating documentation, ask: "Will this be true in 200 PRs?"

- **YES** → Document the principle (WHY)
- **NO** → Skip or use code comments (WHAT/HOW)

Forbidden: issue drafts, implementation summaries, fix notes, scratch files.

### Forbidden File Patterns

- ALL_CAPS.md files (e.g., DESIGN.md, TEST_PLAN.md, SUMMARY.md)
- Agent-generated work artifacts anywhere in the repo
- Duplicate documentation across files

### Migration Documentation

The master migration plan lives in `PI_MIGRATION.md` in the [pi-an repo](https://github.com/badlogic/pi-an/blob/main/PI_MIGRATION.md). All issues reference it. Do not duplicate its content elsewhere.

## Commands Reference

| Command | What it does |
|---------|-------------|
| `bunx biome check .` | Lint all files — exits non-zero on violations |
| `bunx biome format --write .` | Format all files in-place |
| `bunx tsc --noEmit` | Type-check TypeScript without emitting |
| `bun test` | Run all Vitest tests |
| `bun test --coverage` | Run tests with coverage report |
| `bunx biome check . && bun test` | Full pre-push quality gate |

## Migration Scope

This repo implements **issues #2 and #3** (worktree plugin and slash commands) from the [pi-an EPIC #1](https://github.com/badlogic/pi-an/issues/1). The plugin provides safe git worktree management for parallel agent sessions.

### Key Features

- **Safe `create`/`list`/`remove`/`reset`** — three-step removal pipeline with dirty-check, physical-delete, prune
- **State machine** — pending→ready/failed, persisted across sessions
- **EventBus integration** — emits `worktree:created`, `worktree:removed`, `worktree:locked`, `worktree:failed`
- **Five-footgun guardrails** — branch-already-checked-out, dirty-remove, prune-before-delete, detached-HEAD, locked-leftover
- **Atomic persistence** — `.pi/worktrees.json` with backup/restore, fail-closed semantics

See [PI_MIGRATION.md](https://github.com/badlogic/pi-an/blob/main/PI_MIGRATION.md) for full scope, phases, and acceptance criteria.