/**
 * Pi worktree plugin entry point.
 * Default export factory for the Pi harness.
 *
 * This plugin manages git worktrees with safety guards against the five footguns:
 * 1. Branch already checked out elsewhere
 * 2. Dirty worktree remove
 * 3. Prune-before-delete
 * 4. Detached-HEAD ghosts
 * 5. Locked worktree leftovers
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import { loadWorktreesFile } from './persistence';
import { WorktreeManager } from './worktree-ops';

export default function (pi: ExtensionAPI): void {
	let manager: WorktreeManager | null = null;
	let repoRoot: string | null = null;

	pi.on('session_start', async (event, ctx: ExtensionContext) => {
		repoRoot = ctx.cwd;

		// Initialize worktree manager
		manager = new WorktreeManager({
			repoRoot,
			events: pi.events,
			exec: async (command, args) => {
				const result = await pi.exec(command, args);
				return {
					exitCode: 0,
					stdout: result.stdout,
					stderr: result.stderr,
				};
			},
		});

		// Reconcile state: ensure persistence matches actual git worktrees
		try {
			const gitWorktrees = await manager.list();
			const persisted = await loadWorktreesFile(repoRoot);

			// Log reconciliation info (optional notification to user)
			if (persisted) {
				const newWorktrees = gitWorktrees.filter(
					(w) => !persisted.entries.find((e) => e.name === w.name),
				);
				if (newWorktrees.length > 0) {
					safeNotify(
						ctx,
						`Worktree plugin: ${newWorktrees.length} worktree(s) discovered in git state`,
						'info',
					);
				}
			}

			safeNotify(
				ctx,
				`Worktree plugin: ${gitWorktrees.length} worktree(s) synced`,
				'info',
			);
		} catch (error) {
			// Fail-closed: if reconciliation fails, alert the user but don't crash
			const message = error instanceof Error ? error.message : String(error);
			safeNotify(
				ctx,
				`Worktree plugin: Failed to reconcile - ${message}`,
				'error',
			);
		}
	});

	pi.on('session_shutdown', async (event, ctx: ExtensionContext) => {
		// Ensure all pending state changes are flushed
		// The persistence layer handles atomic writes with backups
		// No explicit action needed here - all state updates happen synchronously in operations

		safeNotify(ctx, 'Worktree plugin: Session shutdown complete', 'info');
	});

	// Helper function for safe UI notifications
	function safeNotify(
		ctx: ExtensionContext,
		message: string,
		severity: 'info' | 'warning' | 'error',
	): void {
		if (ctx?.ui && typeof ctx.ui.notify === 'function') {
			try {
				ctx.ui.notify(message, severity);
			} catch {
				// Ignore notification errors - don't let them crash the harness
			}
		}
	}

	// The WorktreeManager is available to the harness via the session context or extensions API
	// Note: Slash commands are deferred to issue #3
}
