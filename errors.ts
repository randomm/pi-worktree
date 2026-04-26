/**
 * Typed error classes with discriminator fields for programmatic dispatch.
 */

export class WorktreeError extends Error {
	public readonly code: string;

	constructor(code: string, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = this.constructor.name;
		this.code = code;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

/**
 * Branch is already checked out in another worktree.
 */
export class BranchAlreadyCheckedOutError extends WorktreeError {
	public static readonly code = 'BranchAlreadyCheckedOut';
	public readonly branch: string;
	public readonly existingPath: string;

	constructor(branch: string, existingPath: string, options?: ErrorOptions) {
		super(
			BranchAlreadyCheckedOutError.code,
			`Branch '${branch}' is already checked out at '${existingPath}'`,
			options,
		);
		this.branch = branch;
		this.existingPath = existingPath;
	}
}

/**
 * Worktree has uncommitted changes and --force was not specified.
 */
export class DirtyWorktreeError extends WorktreeError {
	public static readonly code = 'DirtyWorktree';
	public readonly path: string;

	constructor(path: string, options?: ErrorOptions) {
		super(
			DirtyWorktreeError.code,
			`Worktree at '${path}' has uncommitted changes. Use --force to remove anyway.`,
			options,
		);
		this.path = path;
	}
}

/**
 * Attempted to prune while physical directory still exists.
 */
export class PruneBeforeDeleteError extends WorktreeError {
	public static readonly code = 'PruneBeforeDelete';
	public readonly name: string;
	public readonly path: string;

	constructor(name: string, path: string, options?: ErrorOptions) {
		super(
			PruneBeforeDeleteError.code,
			`Cannot prune worktree '${name}' while physical directory exists at '${path}'. Remove the directory first.`,
			options,
		);
		this.name = name;
		this.path = path;
	}
}

/**
 * Worktree is in detached HEAD state.
 */
export class DetachedHeadError extends WorktreeError {
	public static readonly code = 'DetachedHead';
	public readonly path: string;

	constructor(path: string, options?: ErrorOptions) {
		super(
			DetachedHeadError.code,
			`Worktree at '${path}' is in detached HEAD state`,
			options,
		);
		this.path = path;
	}
}

/**
 * Worktree is locked by another process.
 */
export class LockedWorktreeError extends WorktreeError {
	public static readonly code = 'LockedWorktree';
	public readonly name: string;
	public readonly lockReason: string | number;

	constructor(
		name: string,
		lockReason: string | number,
		options?: ErrorOptions,
	) {
		const reasonStr =
			typeof lockReason === 'number'
				? `process ${lockReason}`
				: `'${lockReason}'`;
		super(
			LockedWorktreeError.code,
			`Worktree '${name}' is locked by ${reasonStr}`,
			options,
		);
		this.name = name;
		this.lockReason = lockReason;
	}
}

/**
 * Persistence file is corrupt or could not be parsed.
 */
export class PersistenceCorruptError extends WorktreeError {
	public static readonly code = 'PersistenceCorrupt';
	public readonly path: string;

	constructor(path: string, options?: ErrorOptions & { cause?: Error }) {
		super(
			PersistenceCorruptError.code,
			`Persistence file at '${path}' is corrupt. Manual intervention required.`,
			options,
		);
		this.path = path;
	}
}

/**
 * Invalid state machine transition attempted.
 */
export class InvalidStateTransitionError extends WorktreeError {
	public static readonly code = 'InvalidStateTransition';
	public readonly from: string;
	public readonly to: string;

	constructor(from: string, to: string, options?: ErrorOptions) {
		super(
			InvalidStateTransitionError.code,
			`Invalid state transition from '${from}' to '${to}'`,
			options,
		);
		this.from = from;
		this.to = to;
	}
}

/**
 * Path escape detected - worktree path attempts to escape the repo root.
 */
export class PathEscapeError extends WorktreeError {
	public static readonly code = 'PathEscape';
	public readonly repoRoot: string;
	public readonly escapedPath: string;

	constructor(repoRoot: string, escapedPath: string, options?: ErrorOptions) {
		super(
			PathEscapeError.code,
			`Path escape detected: '${escapedPath}' attempts to escape repo root '${repoRoot}'`,
			options,
		);
		this.repoRoot = repoRoot;
		this.escapedPath = escapedPath;
	}
}

/**
 * Git command execution failed.
 */
export class GitCommandError extends WorktreeError {
	public static readonly code = 'GitCommandError';
	public readonly command: string;
	public readonly args: string[];
	public readonly exitCode: number | null;
	public readonly stderr: string;

	constructor(
		command: string,
		args: string[],
		exitCode: number | null,
		stderr: string,
		options?: ErrorOptions,
	) {
		super(
			GitCommandError.code,
			`Git command '${command} ${args.join(' ')}' failed (exit ${exitCode}): ${stderr}`,
			options,
		);
		this.command = command;
		this.args = args;
		this.exitCode = exitCode;
		this.stderr = stderr;
	}
}

/**
 * Type guard for WorktreeError instances.
 */
export function isWorktreeError(error: unknown): error is WorktreeError {
	return error instanceof WorktreeError;
}

/**
 * Get error code from error object (safe for any error type).
 */
export function getErrorCode(error: unknown): string | null {
	if (error instanceof WorktreeError) {
		return error.code;
	}
	return null;
}
