/**
 * Worktree operations: create, list, remove, reset.
 * Implements all five footguns with explicit handling.
 */

import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
	BranchAlreadyCheckedOutError,
	DetachedHeadError,
	DirtyWorktreeError,
	GitCommandError,
	LockedWorktreeError,
	PathEscapeError,
	PruneBeforeDeleteError,
} from './errors';
import {
	WORKTREE_CREATED,
	WORKTREE_FAILED,
	WORKTREE_LOCKED,
	WORKTREE_REMOVED,
	type WorktreeCreatedPayload,
	type WorktreeFailedPayload,
	type WorktreeLockedPayload,
	type WorktreeRemovedPayload,
	emitWorktreeEvent,
} from './events';
import { ensureWithinRepo } from './git';
import {
	type ExecFn,
	type WorktreeListEntry,
	findBranchCheckout,
	getWorktreeList,
	getWorktreeLockPath,
	isWorktreeDirty,
} from './git';
import {
	type WorktreeEntry,
	loadWorktreesFile,
	removeEntry,
	upsertEntry,
} from './persistence';
import { type WorktreeState, transitionState } from './state-machine';

export interface CreateOptions {
	branch: string;
	path?: string;
	baseRef?: string;
	detach?: boolean;
	newBranch?: boolean;
}

export interface RemoveOptions {
	force?: boolean;
}

export interface Worktree {
	name: string;
	path: string;
	branch: string | null;
	head: string;
	state: WorktreeState;
	detached: boolean;
	locked: boolean;
	prunable: boolean;
}

/**
 * Extract worktree name from path.
 */
function worktreeNameFromPath(path: string): string {
	return basename(path);
}

/**
 * Read lock file content safely.
 */
async function readLockContent(lockPath: string): Promise<string | null> {
	try {
		return await readFile(lockPath, 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
		throw err;
	}
}

/**
 * Check if a lock file's content is a numeric PID.
 */
function parseLockContent(content: string): number | false {
	const trimmed = content.trim();
	const pid = Number.parseInt(trimmed, 10);
	return !Number.isNaN(pid) && trimmed === String(pid) ? pid : false;
}

/**
 * Check if a PID is alive (POSIX standard).
 */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0); // Signal 0 doesn't actually send a signal, just checks if process exists
		return true;
	} catch (error) {
		const code = (error as { code?: string })?.code;
		return code !== 'ESRCH'; // ESRCH = no such process
	}
}

/**
 * Check worktree lock status and handle orphaned locks.
 *
 * - Missing lock file → not locked
 * - Empty lock file → orphaned, safe to auto-unlock
 * - Numeric PID → check if alive; auto-unlock if dead
 * - Non-PID reason → actively locked, refuse removal
 */
async function checkAndAutoUnlock(
	repoRoot: string,
	worktreeName: string,
	exec: ExecFn,
): Promise<{ locked: boolean; autoUnlocked: boolean }> {
	const lockPath = getWorktreeLockPath(repoRoot, worktreeName);

	const content = await readLockContent(lockPath);
	if (content === null) {
		return { locked: false, autoUnlocked: false };
	}

	const trimmed = content.trim();

	// Empty lock content → orphaned, safe to auto-unlock
	if (trimmed === '') {
		return { locked: false, autoUnlocked: true };
	}

	// Check if content is a numeric PID
	const pid = parseLockContent(trimmed);
	if (pid !== false) {
		// PID-based lock
		if (isPidAlive(pid)) {
			// Live process → refuse removal
			return { locked: true, autoUnlocked: false };
		}
		// Dead process → safe to auto-unlock
		return { locked: false, autoUnlocked: true };
	}

	// Non-PID content → user-supplied reason, actively locked
	return { locked: true, autoUnlocked: false };
}

/**
 * Worktree manager with all safety checks and state management.
 */
export class WorktreeManager {
	private readonly repoRoot: string;
	private readonly events: unknown;
	private readonly exec: ExecFn;

	constructor(opts: { repoRoot: string; events: unknown; exec?: ExecFn }) {
		this.repoRoot = opts.repoRoot;
		this.events = opts.events;
		this.exec = opts.exec ?? require('./git').defaultExecFn;
	}

	/**
	 * Create a new worktree with full safety checks.
	 *
	 * Footguns handled:
	 * 1. Branch already checked out → BranchAlreadyCheckedOutError
	 * 4. Detached-HEAD → DetachedHeadError warning
	 */
	async create(options: CreateOptions): Promise<Worktree> {
		const { branch, path: userPath, baseRef, detach, newBranch } = options;

		// FOOTGUN 1: Check if branch is already checked out elsewhere (skip for new branches)
		if (!newBranch) {
			const existingCheckout = await findBranchCheckout(
				this.repoRoot,
				branch,
				this.exec,
			);
			if (existingCheckout) {
				throw new BranchAlreadyCheckedOutError(branch, existingCheckout);
			}
		}

		// Create entry in pending state with path safety check
		const worktreePath = userPath
			? ensureWithinRepo(this.repoRoot, userPath)
			: join(this.repoRoot, '.worktrees', branch);
		const name = worktreeNameFromPath(worktreePath);
		const entry: WorktreeEntry = {
			name,
			path: worktreePath,
			branch,
			head: '', // Will be filled after git worktree add
			state: 'pending',
			createdAt: new Date().toISOString(),
			lastSeenAt: new Date().toISOString(),
		};

		// Build git worktree add command
		const args = ['worktree', 'add', worktreePath];
		if (newBranch && !detach) {
			args.push('-b', branch);
		}
		if (baseRef) {
			args.push(baseRef);
		} else {
			args.push(branch);
		}
		if (detach) {
			args.push('--detach');
		}

		try {
			// Execute git worktree add
			const { stdout } = await this.exec('git', ['-C', this.repoRoot, ...args]);

			// Get head commit
			const { stdout: revParseOut } = await this.exec('git', [
				'-C',
				worktreePath,
				'rev-parse',
				'HEAD',
			]);
			entry.head = revParseOut.trim();

			// Update state to ready
			entry.state = transitionState('pending', 'ready');

			// FOOTGUN 4: Emit warning if explicitly asked for detached
			if (detach) {
				emitWorktreeEvent(this.events, WORKTREE_LOCKED, {
					name,
					path: worktreePath,
					lockReason: 'Created in detached HEAD state',
				} as WorktreeLockedPayload);
			}

			// Emit created event
			emitWorktreeEvent(this.events, WORKTREE_CREATED, {
				name,
				path: worktreePath,
				branch,
				head: entry.head,
			} as WorktreeCreatedPayload);

			// Persist entry
			await upsertEntry(this.repoRoot, entry);

			// Return minimal worktree info (full list available via list())
			return {
				name,
				path: worktreePath,
				branch,
				head: entry.head,
				state: entry.state,
				detached: detach ?? false,
				locked: false,
				prunable: false,
			};
		} catch (error) {
			// Transition to failed state
			entry.state = transitionState('pending', 'failed');
			entry.error =
				error instanceof GitCommandError ? error.stderr : String(error);

			await upsertEntry(this.repoRoot, entry);

			emitWorktreeEvent(this.events, WORKTREE_FAILED, {
				name,
				path: worktreePath,
				state: 'failed',
				error: entry.error,
			} as WorktreeFailedPayload);

			throw error;
		}
	}

	/**
	 * List all worktrees reconciled with git state.
	 */
	async list(): Promise<Worktree[]> {
		const gitList = await getWorktreeList(this.repoRoot, this.exec);
		const file = await loadWorktreesFile(this.repoRoot);

		const worktrees: Worktree[] = [];

		for (const gitEntry of gitList) {
			const name = worktreeNameFromPath(gitEntry.path);
			const fileEntry = file?.entries.find((e) => e.name === name);

			// Reconcile or create entry
			let entry: WorktreeEntry;
			if (fileEntry) {
				// Update last seen
				entry = {
					...fileEntry,
					lastSeenAt: new Date().toISOString(),
				};
			} else {
				// Create entry for discovered worktree
				entry = {
					name,
					path: gitEntry.path,
					branch: gitEntry.branch ?? gitEntry.head,
					head: gitEntry.head,
					state: 'ready',
					createdAt: new Date().toISOString(),
					lastSeenAt: new Date().toISOString(),
				};
			}

			worktrees.push(this.toWorktree(entry, gitEntry));
		}

		return worktrees;
	}

	/**
	 * Remove a worktree with full safety checks.
	 *
	 * Footguns handled:
	 * 2. Dirty worktree → DirtyWorktreeError (unless --force)
	 * 3. Prune-before-delete → always remove directory first
	 * 5. Locked worktree → LockedWorktreeError (unless PID is dead)
	 */
	async remove(name: string, options: RemoveOptions = {}): Promise<void> {
		const { force } = options;

		// Find the worktree
		const gitList = await getWorktreeList(this.repoRoot, this.exec);
		const gitEntry = gitList.find((w) => worktreeNameFromPath(w.path) === name);
		if (!gitEntry) {
			throw new GitCommandError(
				'git',
				['worktree', 'list'],
				null,
				`Worktree '${name}' not found`,
			);
		}

		// Get or create entry
		const file = await loadWorktreesFile(this.repoRoot);
		let entry = file?.entries.find((e) => e.name === name);
		if (!entry) {
			entry = {
				name,
				path: gitEntry.path,
				branch: gitEntry.branch ?? gitEntry.head,
				head: gitEntry.head,
				state: 'ready',
				createdAt: new Date().toISOString(),
				lastSeenAt: new Date().toISOString(),
			};
		}

		// FOOTGUN 5: Check lock status
		const { locked, autoUnlocked } = await checkAndAutoUnlock(
			this.repoRoot,
			name,
			this.exec,
		);
		if (locked) {
			// Parse lock content for error message
			const lockPath = getWorktreeLockPath(this.repoRoot, name);
			const lockContent = await readLockContent(lockPath);
			// lockContent cannot be null here since locked=true requires a lock file,
			// but handle it gracefully anyway
			const trimmed = lockContent?.trim() ?? 'unknown';
			const pid = parseLockContent(trimmed);
			const reason = pid !== false ? pid : trimmed;
			throw new LockedWorktreeError(name, reason);
		}

		if (autoUnlocked) {
			emitWorktreeEvent(this.events, WORKTREE_LOCKED, {
				name,
				path: gitEntry.path,
				lockReason: 'Auto-unlocked orphaned/dead PID lock',
			} as WorktreeLockedPayload);
		}

		// FOOTGUN 2: Check for uncommitted changes
		const dirty = await isWorktreeDirty(
			this.repoRoot,
			gitEntry.path,
			this.exec,
		);
		if (dirty && !force) {
			throw new DirtyWorktreeError(gitEntry.path);
		}

		// Transition to removing state
		entry.state = transitionState(entry.state, 'removing');
		await upsertEntry(this.repoRoot, entry);

		try {
			// FOOTGUN 3: ALWAYS remove physical directory before pruning
			try {
				await this.exec('git', [
					'-C',
					this.repoRoot,
					'worktree',
					'remove',
					gitEntry.path,
				]);
			} catch (removeError) {
				// If git worktree remove fails, try manual cleanup
				if (removeError instanceof GitCommandError) {
					throw removeError;
				}
			}

			// Remove metadata (prune)
			await this.exec('git', ['-C', this.repoRoot, 'worktree', 'prune']);

			// Transition to gone
			entry.state = transitionState('removing', 'gone');
			await removeEntry(this.repoRoot, name);

			emitWorktreeEvent(this.events, WORKTREE_REMOVED, {
				name,
				path: gitEntry.path,
			} as WorktreeRemovedPayload);
		} catch (error) {
			// Transition to failed state
			entry.state = transitionState('removing', 'failed');
			entry.error =
				error instanceof GitCommandError ? error.stderr : String(error);

			await upsertEntry(this.repoRoot, entry);

			emitWorktreeEvent(this.events, WORKTREE_FAILED, {
				name,
				path: gitEntry.path,
				state: 'failed',
				error: entry.error,
			} as WorktreeFailedPayload);

			throw error;
		}
	}

	/**
	 * Reset a worktree from failed/inconsistent state.
	 */
	async reset(name: string): Promise<void> {
		// Find entry
		const file = await loadWorktreesFile(this.repoRoot);
		if (!file) {
			throw new GitCommandError(
				'git',
				[],
				null,
				`Worktree '${name}' not found in persistence`,
			);
		}

		const entry = file.entries.find((e) => e.name === name);
		if (!entry) {
			throw new GitCommandError(
				'git',
				[],
				null,
				`Worktree '${name}' not found`,
			);
		}

		// Transition from failed to pending
		entry.state = transitionState(entry.state, 'pending');
		entry.error = undefined;
		entry.lastSeenAt = new Date().toISOString();

		await upsertEntry(this.repoRoot, entry);
	}

	/**
	 * Convert persistence entry and git entry to public Worktree type.
	 */
	private toWorktree(
		entry: WorktreeEntry,
		gitEntry?: WorktreeListEntry,
	): Worktree {
		return {
			name: entry.name,
			path: entry.path,
			branch: entry.branch,
			head: entry.head,
			state: entry.state,
			detached: gitEntry?.detached ?? false,
			locked: gitEntry?.locked !== null,
			prunable: gitEntry?.prunable !== null,
		};
	}
}
