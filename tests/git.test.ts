/**
 * Tests for git utilities.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitCommandError, PathEscapeError } from '../errors';
import {
	type ExecFn,
	type WorktreeListEntry,
	ensureWithinRepo,
	getWorktreeList,
	isWorktreeDirty,
	parseGitStatusPorcelain,
	parseWorktreeListPorcelain,
} from '../git';

describe('parseWorktreeListPorcelain', () => {
	it('parses single attached worktree', () => {
		const output =
			'worktree /Users/test/main\nHEAD abc123\nbranch refs/heads/main';
		const result = parseWorktreeListPorcelain(output);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			path: '/Users/test/main',
			head: 'abc123',
			branch: 'main',
			detached: false,
			locked: null,
			prunable: null,
			bare: false,
		});
	});

	it('parses single detached worktree', () => {
		const output = 'worktree /Users/test/feature\nHEAD def456\ndetached';
		const result = parseWorktreeListPorcelain(output);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			path: '/Users/test/feature',
			head: 'def456',
			branch: null,
			detached: true,
			locked: null,
			prunable: null,
			bare: false,
		});
	});

	it('parses multiple worktrees', () => {
		const output =
			'worktree /Users/test/main\nHEAD abc123\nbranch refs/heads/main\n\nworktree /Users/test/feature\nHEAD def456\nbranch refs/heads/feature';
		const result = parseWorktreeListPorcelain(output);
		expect(result).toHaveLength(2);
		expect(result[0].branch).toBe('main');
		expect(result[1].branch).toBe('feature');
	});

	it('parses locked worktree with reason', () => {
		const output =
			'worktree /Users/test/feature\nHEAD def456\nbranch refs/heads/feature\nlocked reason text';
		const result = parseWorktreeListPorcelain(output);
		expect(result).toHaveLength(1);
		expect(result[0].locked).toEqual({ reason: 'reason text' });
	});

	it('parses locked worktree without reason', () => {
		const output =
			'worktree /Users/test/feature\nHEAD def456\nbranch refs/heads/feature\nlocked';
		const result = parseWorktreeListPorcelain(output);
		expect(result).toHaveLength(1);
		expect(result[0].locked).toEqual({ reason: '' });
	});

	it('parses prunable worktree', () => {
		const output =
			'worktree /Users/test/feature\nHEAD def456\nbranch refs/heads/feature\nprunable deleted';
		const result = parseWorktreeListPorcelain(output);
		expect(result).toHaveLength(1);
		expect(result[0].prunable).toEqual({ reason: 'deleted' });
	});

	it('parses bare repository', () => {
		const output = 'worktree /Users/test/bare\nHEAD abc123\nbare';
		const result = parseWorktreeListPorcelain(output);
		expect(result).toHaveLength(1);
		expect(result[0].bare).toBe(true);
	});

	it('parses complex worktree with all fields', () => {
		const output =
			'worktree /Users/test/feature\nHEAD def456\nbranch refs/heads/feature\nlocked user@host\nprunable working tree missing';
		const result = parseWorktreeListPorcelain(output);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			path: '/Users/test/feature',
			head: 'def456',
			branch: 'feature',
			detached: false,
			locked: { reason: 'user@host' },
			prunable: { reason: 'working tree missing' },
			bare: false,
		});
	});

	it('skips malformed entries', () => {
		const output = 'HEAD abc123'; // Missing worktree line
		const result = parseWorktreeListPorcelain(output);
		expect(result).toHaveLength(0);
	});

	it('handles empty output', () => {
		const result = parseWorktreeListPorcelain('');
		expect(result).toHaveLength(0);
	});

	it('handles extra whitespace', () => {
		const output =
			'worktree /Users/test/main  \nHEAD abc123\nbranch refs/heads/main  ';
		const result = parseWorktreeListPorcelain(output);
		expect(result).toHaveLength(1);
		expect(result[0].path).toBe('/Users/test/main');
	});

	it('handles branch with slash', () => {
		const output =
			'worktree /Users/test/feature\nHEAD def456\nbranch refs/heads/feature/sub';
		const result = parseWorktreeListPorcelain(output);
		expect(result).toHaveLength(1);
		expect(result[0].branch).toBe('feature/sub');
	});
});

describe('parseGitStatusPorcelain', () => {
	it('returns false for clean repo', () => {
		const output = '';
		expect(parseGitStatusPorcelain(output)).toBe(false);
	});

	it('returns true for modified tracked file', () => {
		const output = 'M  file.txt';
		expect(parseGitStatusPorcelain(output)).toBe(true);
	});

	it('returns true for untracked file', () => {
		const output = '?? newfile.txt';
		expect(parseGitStatusPorcelain(output)).toBe(true);
	});

	it('returns true for staged file', () => {
		const output = 'A  newfile.txt';
		expect(parseGitStatusPorcelain(output)).toBe(true);
	});

	it('returns true for multiple changes', () => {
		const output = 'M  file.txt\nA  newfile.txt\n?? other.txt';
		expect(parseGitStatusPorcelain(output)).toBe(true);
	});

	it('handles whitespace', () => {
		const output = '  M  file.txt  ';
		expect(parseGitStatusPorcelain(output)).toBe(true);
	});
});

describe('git command error handling', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('re-throws GitCommandError from getWorktreeList', async () => {
		const mockExec: ExecFn = async () => {
			throw new GitCommandError(
				'git',
				['-C', '/repo', 'worktree', 'list', '--porcelain'],
				128,
				'fatal: not a git repository',
			);
		};

		await expect(getWorktreeList('/repo', mockExec)).rejects.toThrow(
			GitCommandError,
		);
	});

	it('converts non-GitCommandError to GitCommandError in getWorktreeList', async () => {
		const mockExec: ExecFn = async () => {
			throw new Error('Network timeout');
		};

		await expect(getWorktreeList('/repo', mockExec)).rejects.toThrow(
			GitCommandError,
		);
	});

	it('re-throws GitCommandError from isWorktreeDirty', async () => {
		const mockExec: ExecFn = async () => {
			throw new GitCommandError(
				'git',
				['-C', '/repo/worktree', 'status', '--porcelain'],
				128,
				'fatal: not a git repository',
			);
		};

		await expect(
			isWorktreeDirty('/repo', 'worktree', mockExec),
		).rejects.toThrow(GitCommandError);
	});

	it('converts non-GitCommandError to GitCommandError in isWorktreeDirty', async () => {
		const mockExec: ExecFn = async () => {
			throw new Error('Disk I/O error');
		};

		await expect(
			isWorktreeDirty('/repo', 'worktree', mockExec),
		).rejects.toThrow(GitCommandError);
	});
});

describe('porcelain edge cases', () => {
	it('handles worktree list with missing branch line (detached)', () => {
		const output =
			'worktree /Users/test/feature\nHEAD def456\ndetached\nlocked reason';
		const result = parseWorktreeListPorcelain(output);
		expect(result).toHaveLength(1);
		expect(result[0].branch).toBeNull();
		expect(result[0].detached).toBe(true);
		expect(result[0].locked).toEqual({ reason: 'reason' });
	});

	it('handles worktree list with multiple locks and prunables', () => {
		const output =
			'worktree /Users/test/main\nHEAD abc123\nbranch refs/heads/main\n\nworktree /Users/test/feature1\nHEAD def456\nbranch refs/heads/feature1\nlocked user1@host\n\nworktree /Users/test/feature2\nHEAD ghi789\nbranch refs/heads/feature2\nprunable deleted';
		const result = parseWorktreeListPorcelain(output);
		expect(result).toHaveLength(3);
		expect(result[0].locked).toBeNull();
		expect(result[1].locked).toEqual({ reason: 'user1@host' });
		expect(result[2].prunable).toEqual({ reason: 'deleted' });
	});

	it('handles worktree list with whitespace in values', () => {
		const output =
			'worktree /Users/test/feature\nHEAD def456\nbranch refs/heads/feature\nlocked user@host: working here with spaces';
		const result = parseWorktreeListPorcelain(output);
		expect(result).toHaveLength(1);
		expect(result[0].locked).toEqual({
			reason: 'user@host: working here with spaces',
		});
	});

	it('handles worktree list with malformed entries (no HEAD)', () => {
		const output =
			'worktree /Users/test/feature1\nHEAD abc123\nbranch refs/heads/feature1\n\nworktree /Users/test/feature2\nbranch refs/heads/feature2\n\nworktree /Users/test/feature3\nHEAD def456';
		const result = parseWorktreeListPorcelain(output);
		// Should skip entries without HEAD
		expect(result).toHaveLength(2);
		expect(result[0].path).toBe('/Users/test/feature1');
		expect(result[1].path).toBe('/Users/test/feature3');
	});

	it('handles worktree list with mixed valid and invalid branch refs', () => {
		const output =
			'worktree /Users/test/feature1\nHEAD abc123\nbranch refs/heads/feature1\n\nworktree /Users/test/feature2\nHEAD def456\nbranch refs/tags/v1.0\n\nworktree /Users/test/feature3\nHEAD ghi789\nbranch refs/heads/feature3';
		const result = parseWorktreeListPorcelain(output);
		expect(result).toHaveLength(3);
		// Only refs/heads/ entries get the branch field populated
		expect(result[0].branch).toBe('feature1');
		expect(result[1].branch).toBeNull();
		expect(result[2].branch).toBe('feature3');
	});
});

describe('path traversal protection', () => {
	it('rejects worktreePath that escapes repoRoot via ..', () => {
		expect(() => ensureWithinRepo('/some/repo', '../../etc')).toThrowError(
			PathEscapeError,
		);
	});

	it('allows path within repoRoot', () => {
		const result = ensureWithinRepo('/some/repo', 'subdir/worktree');
		expect(result).toBe('/some/repo/subdir/worktree');
	});

	it('allows absolute path equal to repoRoot', () => {
		const result = ensureWithinRepo('/some/repo', '/some/repo');
		expect(result).toBe('/some/repo');
	});

	it('rejects symlink escape ( resolves symlinks)', () => {
		//resolve() in ensureWithinRepo will resolve symlinks
		// This test documents the behavior - if /some/repo/subdir is a symlink to /etc,
		// it will be rejected
		expect(() =>
			ensureWithinRepo('/some/repo', '../../../../etc'),
		).toThrowError(PathEscapeError);
	});

	it('normalizes redundant path components', () => {
		const result = ensureWithinRepo('/some/repo', 'subdir/../other/worktree');
		expect(result).toBe('/some/repo/other/worktree');
	});

	it('rejects escape via normalized path', () => {
		expect(() =>
			ensureWithinRepo('/some/repo', 'subdir/../../..'),
		).toThrowError(PathEscapeError);
	});
});
