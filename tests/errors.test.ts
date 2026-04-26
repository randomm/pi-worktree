/**
 * Tests for error types and type guards.
 */

import { describe, expect, it } from 'vitest';
import {
	BranchAlreadyCheckedOutError,
	DetachedHeadError,
	DirtyWorktreeError,
	GitCommandError,
	InvalidStateTransitionError,
	LockedWorktreeError,
	PathEscapeError,
	PersistenceCorruptError,
	PruneBeforeDeleteError,
	WorktreeError,
	getErrorCode,
	isWorktreeError,
} from '../errors';

describe('WorktreeError', () => {
	it('has code discriminator', () => {
		const error = new WorktreeError('TestCode', 'Test message');
		expect(error.code).toBe('TestCode');
		expect(error.message).toBe('Test message');
		expect(error.name).toBe('WorktreeError');
	});

	it('maintains prototype chain', () => {
		const error = new WorktreeError('TestCode', 'Test message');
		expect(error instanceof Error).toBe(true);
		expect(error instanceof WorktreeError).toBe(true);
	});
});

describe('BranchAlreadyCheckedOutError', () => {
	it('has correct code and properties', () => {
		const error = new BranchAlreadyCheckedOutError(
			'feature',
			'/path/to/worktree',
		);
		expect(error.code).toBe(BranchAlreadyCheckedOutError.code);
		expect(error.branch).toBe('feature');
		expect(error.existingPath).toBe('/path/to/worktree');
		expect(error.message).toContain('feature');
		expect(error.message).toContain('/path/to/worktree');
	});

	it('static code is "BranchAlreadyCheckedOut"', () => {
		expect(BranchAlreadyCheckedOutError.code).toBe('BranchAlreadyCheckedOut');
	});
});

describe('DirtyWorktreeError', () => {
	it('has correct code and properties', () => {
		const error = new DirtyWorktreeError('/path/to/worktree');
		expect(error.code).toBe(DirtyWorktreeError.code);
		expect(error.path).toBe('/path/to/worktree');
		expect(error.message).toContain('/path/to/worktree');
	});

	it('static code is "DirtyWorktree"', () => {
		expect(DirtyWorktreeError.code).toBe('DirtyWorktree');
	});
});

describe('PruneBeforeDeleteError', () => {
	it('has correct code and properties', () => {
		const error = new PruneBeforeDeleteError('feature', '/path/to/worktree');
		expect(error.code).toBe(PruneBeforeDeleteError.code);
		expect(error.name).toBe('feature');
		expect(error.path).toBe('/path/to/worktree');
		expect(error.message).toContain('feature');
		expect(error.message).toContain('/path/to/worktree');
	});

	it('static code is "PruneBeforeDelete"', () => {
		expect(PruneBeforeDeleteError.code).toBe('PruneBeforeDelete');
	});
});

describe('DetachedHeadError', () => {
	it('has correct code and properties', () => {
		const error = new DetachedHeadError('/path/to/worktree');
		expect(error.code).toBe(DetachedHeadError.code);
		expect(error.path).toBe('/path/to/worktree');
		expect(error.message).toContain('/path/to/worktree');
		expect(error.message).toContain('detached HEAD');
	});

	it('static code is "DetachedHead"', () => {
		expect(DetachedHeadError.code).toBe('DetachedHead');
	});
});

describe('LockedWorktreeError', () => {
	it('has correct code with numeric PID', () => {
		const error = new LockedWorktreeError('feature', 12345);
		expect(error.code).toBe(LockedWorktreeError.code);
		expect(error.name).toBe('feature');
		expect(error.lockReason).toBe(12345);
		expect(error.message).toContain('process 12345');
	});

	it('has correct code with string reason', () => {
		const error = new LockedWorktreeError('feature', 'user@host');
		expect(error.code).toBe(LockedWorktreeError.code);
		expect(error.name).toBe('feature');
		expect(error.lockReason).toBe('user@host');
		expect(error.message).toContain('user@host');
	});

	it('static code is "LockedWorktree"', () => {
		expect(LockedWorktreeError.code).toBe('LockedWorktree');
	});
});

describe('PersistenceCorruptError', () => {
	it('has correct code and properties', () => {
		const error = new PersistenceCorruptError('/path/to/file.json');
		expect(error.code).toBe(PersistenceCorruptError.code);
		expect(error.path).toBe('/path/to/file.json');
		expect(error.message).toContain('/path/to/file.json');
	});

	it('works without cause', () => {
		const error = new PersistenceCorruptError('/path/to/file.json');
		expect(error.code).toBe(PersistenceCorruptError.code);
		expect(error.cause).toBeUndefined();
	});

	it('preserves cause when provided', () => {
		const originalError = new Error('Original error');
		const error = new PersistenceCorruptError('/path/to/file.json', {
			cause: originalError,
		});
		expect(error.cause).toBe(originalError);
		expect(error.cause?.message).toBe('Original error');
	});

	it('static code is "PersistenceCorrupt"', () => {
		expect(PersistenceCorruptError.code).toBe('PersistenceCorrupt');
	});
});

describe('InvalidStateTransitionError', () => {
	it('has correct code and properties', () => {
		const error = new InvalidStateTransitionError('pending', 'gone');
		expect(error.code).toBe(InvalidStateTransitionError.code);
		expect(error.from).toBe('pending');
		expect(error.to).toBe('gone');
		expect(error.message).toContain('pending');
		expect(error.message).toContain('gone');
	});

	it('static code is "InvalidStateTransition"', () => {
		expect(InvalidStateTransitionError.code).toBe('InvalidStateTransition');
	});
});

describe('PathEscapeError', () => {
	it('has correct code and properties', () => {
		const error = new PathEscapeError('/repo', '../escape');
		expect(error.code).toBe(PathEscapeError.code);
		expect(error.repoRoot).toBe('/repo');
		expect(error.escapedPath).toBe('../escape');
		expect(error.message).toContain('escape detected');
	});

	it('static code is "PathEscape"', () => {
		expect(PathEscapeError.code).toBe('PathEscape');
	});
});

describe('GitCommandError', () => {
	it('has correct code and properties', () => {
		const error = new GitCommandError(
			'git',
			['worktree', 'add', 'feature'],
			128,
			'fatal: error',
		);
		expect(error.code).toBe(GitCommandError.code);
		expect(error.command).toBe('git');
		expect(error.args).toEqual(['worktree', 'add', 'feature']);
		expect(error.exitCode).toBe(128);
		expect(error.stderr).toBe('fatal: error');
		expect(error.message).toContain('git');
		expect(error.message).toContain('128');
	});

	it('static code is "GitCommandError"', () => {
		expect(GitCommandError.code).toBe('GitCommandError');
	});

	it('preserves cause when provided', () => {
		const originalError = new Error('Original error');
		const error = new GitCommandError('git', ['status'], 1, 'stderr content', {
			cause: originalError,
		});
		expect(error.cause).toBe(originalError);
		expect(error.cause?.message).toBe('Original error');
	});
});

describe('isWorktreeError', () => {
	it('returns true for WorktreeError instances', () => {
		const error = new BranchAlreadyCheckedOutError('feature', '/path');
		expect(isWorktreeError(error)).toBe(true);
	});

	it('returns true for all error subclasses', () => {
		const errors = [
			new BranchAlreadyCheckedOutError('feature', '/path'),
			new DirtyWorktreeError('/path'),
			new PruneBeforeDeleteError('feature', '/path'),
			new DetachedHeadError('/path'),
			new LockedWorktreeError('feature', 12345),
			new PersistenceCorruptError('/path'),
			new InvalidStateTransitionError('pending', 'ready'),
			new GitCommandError('git', [], 128, ''),
			new PathEscapeError('/repo', '../escape'),
		];

		for (const error of errors) {
			expect(isWorktreeError(error)).toBe(true);
		}
	});

	it('returns false for non-WorktreeError errors', () => {
		expect(isWorktreeError(new Error('generic error'))).toBe(false);
		expect(isWorktreeError('string')).toBe(false);
		expect(isWorktreeError(null)).toBe(false);
		expect(isWorktreeError(undefined)).toBe(false);
		expect(isWorktreeError(123)).toBe(false);
		expect(isWorktreeError({})).toBe(false);
	});

	it('returns false for generic Error', () => {
		const error = new Error('message');
		expect(isWorktreeError(error)).toBe(false);
	});
});

describe('getErrorCode', () => {
	it('returns code for WorktreeError instances', () => {
		const error = new BranchAlreadyCheckedOutError('feature', '/path');
		expect(getErrorCode(error)).toBe('BranchAlreadyCheckedOut');
	});

	it('returns null for non-WorktreeError', () => {
		expect(getErrorCode(new Error('generic'))).toBe(null);
		expect(getErrorCode(null)).toBe(null);
		expect(getErrorCode(undefined)).toBe(null);
		expect(getErrorCode('string')).toBe(null);
	});

	it('handles all error types', () => {
		const errorCodes = [
			new BranchAlreadyCheckedOutError('f', '/p'),
			new DirtyWorktreeError('/p'),
			new PruneBeforeDeleteError('f', '/p'),
			new DetachedHeadError('/p'),
			new LockedWorktreeError('f', 'reason'),
			new PersistenceCorruptError('/p'),
			new InvalidStateTransitionError('a', 'b'),
			new GitCommandError('git', [], 128, ''),
			new PathEscapeError('/repo', '../escape'),
		];

		for (const error of errorCodes) {
			const code = getErrorCode(error);
			expect(code).not.toBeNull();
			expect(code).toBe((error as WorktreeError).code);
		}
	});
});
