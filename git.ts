/**
 * Thin wrapper over git -C <root> invocations.
 * Pure logic for parsers is unit-testable.
 */

import { join, resolve, sep } from 'node:path';
import { GitCommandError, PathEscapeError } from './errors';

/**
 * Ensure a path stays within the repo root, rejecting path traversal attacks.
 *
 * @throws {PathEscapeError} if the path escapes the repo root via .. or symlinks
 */
export function ensureWithinRepo(repoRoot: string, candidate: string): string {
	const root = resolve(repoRoot);
	const target = resolve(root, candidate);

	// Target must equal root or be inside it (starts with root + separator)
	if (target !== root && !target.startsWith(root + sep)) {
		throw new PathEscapeError(repoRoot, candidate);
	}

	return target;
}

/**
 * Result of git command execution.
 */
export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Function signature for git command execution.
 * Can be swapped for pi.exec or node:child_process.execFile.
 */
export type ExecFn = (
	command: string,
	args: string[],
	options?: { cwd?: string },
) => Promise<ExecResult>;

/**
 * Default exec function using node:child_process.execFile.
 */
export async function defaultExecFn(
	command: string,
	args: string[],
	options?: { cwd?: string },
): Promise<ExecResult> {
	const { execFile } = await import('node:child_process');
	return new Promise((resolve, reject) => {
		execFile(command, args, options, (error, stdout, stderr) => {
			if (error) {
				const code = (error as { code?: string }).code;
				reject(
					new GitCommandError(
						command,
						args,
						code ? Number.parseInt(code, 10) : null,
						stderr as string,
					),
				);
				return;
			}
			resolve({
				exitCode: 0,
				stdout: stdout as string,
				stderr: stderr as string,
			});
		});
	});
}

/**
 * Parsed entry from `git worktree list --porcelain`.
 */
export interface WorktreeListEntry {
	path: string;
	head: string;
	branch: string | null;
	detached: boolean;
	locked: { reason?: string } | null;
	prunable: { reason?: string } | null;
	bare: boolean;
}

/**
 * Parse the output of `git worktree list --porcelain`.
 *
 * Output is blank-line-separated blocks. Each block has these lines (some optional):
 * worktree /abs/path
 * HEAD <sha>
 * branch refs/heads/<name>     # OR `detached` (no value)
 * locked                       # OR `locked <reason>`  (optional)
 * prunable                     # OR `prunable <reason>` (optional)
 * bare                         # (optional, only for the bare/main repo)
 *
 * @param output - Raw porcelain output
 * @returns Array of parsed worktree entries
 */
export function parseWorktreeListPorcelain(
	output: string,
): WorktreeListEntry[] {
	const entries: WorktreeListEntry[] = [];
	const blocks = output.trim().split(/\n\n+/);

	for (const block of blocks) {
		const lines = block.trim().split('\n');
		const entry: WorktreeListEntry = {
			path: '',
			head: '',
			branch: null,
			detached: false,
			locked: null,
			prunable: null,
			bare: false,
		};

		for (const line of lines) {
			if (!line) continue;

			const [key, ...valueParts] = line.split(' ');
			const value = valueParts.join(' ').trim();

			switch (key) {
				case 'worktree':
					entry.path = value;
					break;
				case 'HEAD':
					entry.head = value;
					break;
				case 'branch':
					if (value.startsWith('refs/heads/')) {
						entry.branch = value.substring(11); // Strip refs/heads/
					}
					break;
				case 'detached':
					// Key exists with no value
					entry.detached = true;
					break;
				case 'locked':
					entry.locked = value ? { reason: value } : { reason: '' };
					break;
				case 'prunable':
					entry.prunable = value ? { reason: value } : { reason: '' };
					break;
				case 'bare':
					entry.bare = true;
					break;
			}
		}

		// Validate required fields
		if (!entry.path || !entry.head) {
			continue; // Skip malformed entry
		}

		entries.push(entry);
	}

	return entries;
}

/**
 * Get worktree list entries.
 *
 * @param repoRoot - Path to the git repository root
 * @param exec - Optional exec function (defaults to node:child_process.execFile)
 * @returns Array of worktree entries
 */
export async function getWorktreeList(
	repoRoot: string,
	exec: ExecFn = defaultExecFn,
): Promise<WorktreeListEntry[]> {
	try {
		const { stdout } = await exec('git', [
			'-C',
			repoRoot,
			'worktree',
			'list',
			'--porcelain',
		]);
		return parseWorktreeListPorcelain(stdout);
	} catch (error) {
		// Convert GitCommandError to our typed error
		if (error instanceof GitCommandError) {
			throw error;
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new GitCommandError(
			'git',
			['-C', repoRoot, 'worktree', 'list', '--porcelain'],
			null,
			message,
			{ cause: error },
		);
	}
}

/**
 * Check if a branch is already checked out in another worktree.
 *
 * @param repoRoot - Path to the git repository root
 * @param branchName - Name of the branch to check
 * @param exec - Optional exec function
 * @returns Path of the worktree where branch is checked out, or null if not found
 */
export async function findBranchCheckout(
	repoRoot: string,
	branchName: string,
	exec: ExecFn = defaultExecFn,
): Promise<string | null> {
	const entries = await getWorktreeList(repoRoot, exec);
	for (const entry of entries) {
		if (entry.branch === branchName && !entry.detached) {
			return entry.path;
		}
	}
	return null;
}

/**
 * Parse the output of `git status --porcelain`.
 *
 * Returns true if there are any changes (tracked or untracked).
 *
 * @param output - Raw porcelain output
 * @returns true if repo is dirty (has changes), false otherwise
 */
export function parseGitStatusPorcelain(output: string): boolean {
	return output.trim().length > 0;
}

/**
 * Check if a worktree has uncommitted changes.
 *
 * @param repoRoot - Path to the git repository root
 * @param worktreePath - Path to the worktree directory
 * @param exec - Optional exec function
 * @returns true if worktree is dirty, false otherwise
 */
export async function isWorktreeDirty(
	repoRoot: string,
	worktreePath: string,
	exec: ExecFn = defaultExecFn,
): Promise<boolean> {
	const safePath = ensureWithinRepo(repoRoot, worktreePath);
	try {
		const { stdout } = await exec('git', [
			'-C',
			safePath,
			'status',
			'--porcelain',
		]);
		return parseGitStatusPorcelain(stdout);
	} catch (error) {
		if (error instanceof GitCommandError) {
			throw error;
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new GitCommandError(
			'git',
			['-C', safePath, 'status', '--porcelain'],
			null,
			message,
			{ cause: error },
		);
	}
}

/**
 * Get the full path to a worktree's lock file.
 *
 * @param repoRoot - Path to the git repository root
 * @param worktreeName - Name of the worktree
 * @returns Path to the lock file
 */
export function getWorktreeLockPath(
	repoRoot: string,
	worktreeName: string,
): string {
	return join(repoRoot, '.git', 'worktrees', worktreeName, 'locked');
}
