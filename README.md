# pi-worktree

[![CI](https://github.com/randomm/pi-worktree/actions/workflows/ci.yml/badge.svg)](https://github.com/randomm/pi-worktree/actions/workflows/ci.yml)

Git worktree management plugin for the Pi agent harness. Provides safe `create`/`list`/`remove` of worktrees for parallel agent sessions, with guardrails against the data-loss patterns common in agentic workflows.

## Status

0.1.0 — in development

## Installation

```bash
pi install npm:@randomm/pi-worktree
```

Note: Manual install via copy to `~/.pi/agent/extensions/` until published to npm.

## Configuration

Configuration is defined in `~/.pi/settings.json`. Example (finalized in issue #2):

```json
{
  "worktrees": {
    "root": ".worktrees"
  }
}
```

## Usage

This plugin provides slash commands for worktree management (coming in issue #3):

- `/worktree create` — Create a new worktree for a parallel agent session
- `/worktree list` — List all existing worktrees with their status
- `/worktree remove` — Safely remove a worktree with three-step pipeline (dirty-check, physical-delete, prune)

Slash commands are currently in development. The core worktree API will be implemented as a plain ESM module in issue #2.

## Safety Guarantees

This plugin guards against five well-documented worktree footguns that cause data loss in agentic workflows:

- **Branch already checked out elsewhere** — Worktree creation is refused if the branch is already checked out in another worktree, with a clear error message indicating the conflict
- **Dirty `remove` data loss** — `git status --porcelain` is checked before removal; if non-empty and no `--force` flag, the operation is refused with a warning
- **Prune-before-delete** — Metadata pruning is never auto-triggered while physical directories exist; physical deletion always precedes pruning
- **Detached-HEAD ghosts** — Explicit warnings are issued when creating a worktree with `--detach` or entering auto-detached states
- **Locked worktree leftovers** — Orphaned.lock files are detected on startup; locks for dead PIDs are auto-unlocked, while live PIDs trigger warnings

All operations use fail-closed semantics — persistence corruption or state inconsistencies result in denial of new operations, never silent allowance.

## License

Apache 2.0 — see [LICENSE](LICENSE)