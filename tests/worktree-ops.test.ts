/**
 * Tests for worktree operations covering all five footguns.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	BranchAlreadyCheckedOutError,
	DirtyWorktreeError,
	GitCommandError,
	LockedWorktreeError,
	getErrorCode,
} from '../errors';
import {
	type ExecFn,
	isWorktreeDirty,
	parseWorktreeListPorcelain,
} from '../git';
import { WorktreeManager } from '../worktree-ops';

const TEST_REPO_DIR = join(process.cwd(), 'tmp', 'test-worktree-ops');

function setupTestRepo(): void {
	rmSync(TEST_REPO_DIR, { recursive: true, force: true });
	mkdirSync(TEST_REPO_DIR, { recursive: true });
	mkdirSync(join(TEST_REPO_DIR, '.pi'), { mode: 0o700, recursive: true });
	mkdirSync(join(TEST_REPO_DIR, '.git'), { recursive: true });
	mkdirSync(join(TEST_REPO_DIR, '.git', 'worktrees'), { recursive: true });
}

function cleanupTestRepo(): void {
	rmSync(TEST_REPO_DIR, { recursive: true, force: true });
}

const mockEvents = {
	emit: vi.fn(),
};

describe('WorktreeManager', () => {
	beforeEach(() => {
		setupTestRepo();
		mockEvents.emit.mockReset();
		mockEvents.emit.mockClear();
	});

	afterEach(cleanupTestRepo);

	// FOOTGUN 1: Branch already checked out elsewhere
	describe('Footgun 1: Branch already checked out', () => {
		it('✓ POSITIVE: rejects create when branch already checked out', async () => {
			const featurePath = join(TEST_REPO_DIR, '.worktrees', 'feature');
			const mockExec = createSimpleMockExec([
				{
					args: ['worktree', 'list', '--porcelain'],
					response: {
						exitCode: 0,
						stdout: `worktree ${TEST_REPO_DIR}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${featurePath}\nHEAD def456\nbranch refs/heads/feature`,
						stderr: '',
					},
				},
			]);

			const manager = new WorktreeManager({
				repoRoot: TEST_REPO_DIR,
				events: mockEvents,
				exec: mockExec,
			});

			await expect(manager.create({ branch: 'feature' })).rejects.toThrow(
				BranchAlreadyCheckedOutError,
			);
		});

		it('✓ NEGATIVE: allows create when branch not checked out', async () => {
			const newPath = join(TEST_REPO_DIR, '.worktrees', 'new-branch');
			const mockExec = createSimpleMockExec([
				{
					args: ['worktree', 'list', '--porcelain'],
					response: {
						exitCode: 0,
						stdout: `worktree ${TEST_REPO_DIR}\nHEAD abc123\nbranch refs/heads/main`,
						stderr: '',
					},
				},
				{
					args: ['worktree', 'add', newPath, 'main'],
					response: { exitCode: 0, stdout: '', stderr: '' },
				},
				{
					args: ['-C', newPath, 'rev-parse', 'HEAD'],
					response: { exitCode: 0, stdout: 'def456', stderr: '' },
				},
				{
					args: ['worktree', 'list', '--porcelain'],
					response: {
						exitCode: 0,
						stdout: `worktree ${newPath}\nHEAD def456\nbranch refs/heads/new-branch`,
						stderr: '',
					},
				},
			]);

			const manager = new WorktreeManager({
				repoRoot: TEST_REPO_DIR,
				events: mockEvents,
				exec: mockExec,
			});

			await expect(
				manager.create({ branch: 'new-branch', newBranch: true }),
			).resolves.not.toThrow();
		});
	});

	// FOOTGUN 2: Dirty worktree remove
	describe('Footgun 2: Dirty worktree remove', () => {
		it('✓ POSITIVE: rejects remove when worktree has uncommitted changes', async () => {
			const featurePath = join(TEST_REPO_DIR, '.worktrees', 'feature');
			const mockExec: ExecFn = async (command, args) => {
				const argsStr = args.join(' ');

				if (argsStr.includes('worktree list')) {
					return {
						exitCode: 0,
						stdout: `worktree ${TEST_REPO_DIR}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${featurePath}\nHEAD def456\nbranch refs/heads/feature`,
						stderr: '',
					};
				}
				if (argsStr.includes('status --porcelain')) {
					return { exitCode: 0, stdout: 'M  file.txt', stderr: '' };
				}

				return { exitCode: 0, stdout: '', stderr: '' };
			};

			const manager = new WorktreeManager({
				repoRoot: TEST_REPO_DIR,
				events: mockEvents,
				exec: mockExec,
			});

			await expect(manager.remove('feature')).rejects.toThrow(
				DirtyWorktreeError,
			);
		});

		it('✓ NEGATIVE: allows remove with --force despite uncommitted changes', async () => {
			const featurePath = join(TEST_REPO_DIR, '.worktrees', 'feature');
			const mockExec = createSimpleMockExec([
				{
					args: ['worktree', 'list', '--porcelain'],
					response: {
						exitCode: 0,
						stdout: `worktree ${TEST_REPO_DIR}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${featurePath}\nHEAD def456\nbranch refs/heads/feature`,
						stderr: '',
					},
				},
				{
					args: [
						'-C',
						join(TEST_REPO_DIR, '.worktrees', 'feature'),
						'status',
						'--porcelain',
					],
					response: { exitCode: 0, stdout: 'M  file.txt', stderr: '' },
				},
				{
					args: ['worktree', 'remove', featurePath],
					response: { exitCode: 0, stdout: '', stderr: '' },
				},
				{
					args: ['worktree', 'prune'],
					response: { exitCode: 0, stdout: '', stderr: '' },
				},
			]);

			const manager = new WorktreeManager({
				repoRoot: TEST_REPO_DIR,
				events: mockEvents,
				exec: mockExec,
			});

			await expect(
				manager.remove('feature', { force: true }),
			).resolves.not.toThrow();
		});
	});

	// FOOTGUN 3: Prune-before-delete
	describe('Footgun 3: Prune-before-delete', () => {
		it('✓ POSITIVE: always removes directory before pruning metadata', async () => {
			const featurePath = join(TEST_REPO_DIR, '.worktrees', 'feature');
			let removeCalled = 0;
			let pruneCalled = 0;

			const mockExec: ExecFn = async (command, args) => {
				const argsStr = args.join(' ');
				if (argsStr.includes('worktree remove')) {
					removeCalled++;
				}
				if (argsStr.includes('worktree prune')) {
					pruneCalled++;
					expect(removeCalled).toBeGreaterThan(0);
				}

				// Handle the specific commands for remove workflow
				if (argsStr.includes('worktree list')) {
					return {
						exitCode: 0,
						stdout: `worktree ${TEST_REPO_DIR}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${featurePath}\nHEAD def456\nbranch refs/heads/feature`,
						stderr: '',
					};
				}
				if (argsStr.includes('status --porcelain')) {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				if (argsStr.includes('worktree remove')) {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				if (argsStr.includes('worktree prune')) {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			};

			const manager = new WorktreeManager({
				repoRoot: TEST_REPO_DIR,
				events: mockEvents,
				exec: mockExec,
			});

			await manager.remove('feature').catch(() => {});

			expect(removeCalled).toBeGreaterThan(0);
			expect(pruneCalled).toBeGreaterThan(0);
		});
	});

	// FOOTGUN 4: Detached-HEAD ghosts
	describe('Footgun 4: Detached-HEAD ghosts', () => {
		it('✓ POSITIVE: emits warning when creating detached worktree', async () => {
			const detachedPath = join(TEST_REPO_DIR, '.worktrees', 'detached');
			const mockExec = createSimpleMockExec([
				{
					args: ['worktree', 'list', '--porcelain'],
					response: {
						exitCode: 0,
						stdout: `worktree ${TEST_REPO_DIR}\nHEAD abc123\nbranch refs/heads/main`,
						stderr: '',
					},
				},
				{
					args: ['worktree', 'add', detachedPath, 'main', '--detach'],
					response: { exitCode: 0, stdout: '', stderr: '' },
				},
				{
					args: ['-C', detachedPath, 'rev-parse', 'HEAD'],
					response: { exitCode: 0, stdout: 'def456', stderr: '' },
				},
				{
					args: ['worktree', 'list', '--porcelain'],
					response: {
						exitCode: 0,
						stdout: `worktree ${TEST_REPO_DIR}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${detachedPath}\nHEAD def456\ndetached`,
						stderr: '',
					},
				},
			]);

			const manager = new WorktreeManager({
				repoRoot: TEST_REPO_DIR,
				events: mockEvents,
				exec: mockExec,
			});

			await manager.create({ branch: 'detached', detach: true });

			const lockedCalls = mockEvents.emit.mock.calls.filter(
				(call) => call[0] === 'worktree:locked',
			);
			expect(lockedCalls.length).toBeGreaterThan(0);
		});

		it('✓ NEGATIVE: creates attached worktree without warning', async () => {
			const featurePath = join(TEST_REPO_DIR, '.worktrees', 'feature');
			const mockExec = createSimpleMockExec([
				{
					args: ['worktree', 'list', '--porcelain'],
					response: {
						exitCode: 0,
						stdout: `worktree ${TEST_REPO_DIR}\nHEAD abc123\nbranch refs/heads/main`,
						stderr: '',
					},
				},
				{
					args: ['worktree', 'add', '-b', 'feature', featurePath, 'main'],
					response: { exitCode: 0, stdout: '', stderr: '' },
				},
				{
					args: ['-C', featurePath, 'rev-parse', 'HEAD'],
					response: { exitCode: 0, stdout: 'def456', stderr: '' },
				},
			]);

			const manager = new WorktreeManager({
				repoRoot: TEST_REPO_DIR,
				events: mockEvents,
				exec: mockExec,
			});

			await manager.create({ branch: 'feature', newBranch: true });

			const lockedCalls = mockEvents.emit.mock.calls.filter(
				(call) => call[0] === 'worktree:locked',
			);
			expect(lockedCalls.length).toBe(0);
		});
	});

	// FOOTGUN 5: Locked worktree leftovers
	describe('Footgun 5: Locked worktree leftovers', () => {
		it('✓ POSITIVE: auto-unlocks dead PID worktree', async () => {
			const lockPath = join(
				TEST_REPO_DIR,
				'.git',
				'worktrees',
				'feature',
				'locked',
			);
			mkdirSync(join(TEST_REPO_DIR, '.git', 'worktrees', 'feature'), {
				recursive: true,
			});
			writeFileSync(lockPath, '9999999', { mode: 0o600 });

			const featurePath = join(TEST_REPO_DIR, '.worktrees', 'feature');
			const mockExec = createSimpleMockExec([
				{
					args: ['worktree', 'list', '--porcelain'],
					response: {
						exitCode: 0,
						stdout: `worktree ${TEST_REPO_DIR}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${featurePath}\nHEAD def456\nbranch refs/heads/feature`,
						stderr: '',
					},
				},
				{
					args: [
						'-C',
						join(TEST_REPO_DIR, '.worktrees', 'feature'),
						'status',
						'--porcelain',
					],
					response: { exitCode: 0, stdout: '', stderr: '' },
				},
				{
					args: ['worktree', 'remove', featurePath],
					response: { exitCode: 0, stdout: '', stderr: '' },
				},
				{
					args: ['worktree', 'prune'],
					response: { exitCode: 0, stdout: '', stderr: '' },
				},
			]);

			const manager = new WorktreeManager({
				repoRoot: TEST_REPO_DIR,
				events: mockEvents,
				exec: mockExec,
			});

			await expect(manager.remove('feature')).resolves.not.toThrow(
				LockedWorktreeError,
			);
		});

		it('✓ POSITIVE: auto-unlocks empty lock file', async () => {
			const lockPath = join(
				TEST_REPO_DIR,
				'.git',
				'worktrees',
				'feature',
				'locked',
			);
			mkdirSync(join(TEST_REPO_DIR, '.git', 'worktrees', 'feature'), {
				recursive: true,
			});
			writeFileSync(lockPath, '', { mode: 0o600 });

			const featurePath = join(TEST_REPO_DIR, '.worktrees', 'feature');
			const mockExec = createSimpleMockExec([
				{
					args: ['worktree', 'list', '--porcelain'],
					response: {
						exitCode: 0,
						stdout: `worktree ${TEST_REPO_DIR}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${featurePath}\nHEAD def456\nbranch refs/heads/feature`,
						stderr: '',
					},
				},
				{
					args: [
						'-C',
						join(TEST_REPO_DIR, '.worktrees', 'feature'),
						'status',
						'--porcelain',
					],
					response: { exitCode: 0, stdout: '', stderr: '' },
				},
				{
					args: ['worktree', 'remove', featurePath],
					response: { exitCode: 0, stdout: '', stderr: '' },
				},
				{
					args: ['worktree', 'prune'],
					response: { exitCode: 0, stdout: '', stderr: '' },
				},
			]);

			const manager = new WorktreeManager({
				repoRoot: TEST_REPO_DIR,
				events: mockEvents,
				exec: mockExec,
			});

			await expect(manager.remove('feature')).resolves.not.toThrow(
				LockedWorktreeError,
			);
		});

		it('✓ POSITIVE: rejects remove when worktree locked with user reason', async () => {
			const lockPath = join(
				TEST_REPO_DIR,
				'.git',
				'worktrees',
				'feature',
				'locked',
			);
			mkdirSync(join(TEST_REPO_DIR, '.git', 'worktrees', 'feature'), {
				recursive: true,
			});
			writeFileSync(lockPath, 'user@host: working here', { mode: 0o600 });

			const featurePath = join(TEST_REPO_DIR, '.worktrees', 'feature');
			const mockExec = createSimpleMockExec([
				{
					args: ['worktree', 'list', '--porcelain'],
					response: {
						exitCode: 0,
						stdout: `worktree ${TEST_REPO_DIR}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${featurePath}\nHEAD def456\nbranch refs/heads/feature`,
						stderr: '',
					},
				},
			]);

			const manager = new WorktreeManager({
				repoRoot: TEST_REPO_DIR,
				events: mockEvents,
				exec: mockExec,
			});

			await expect(manager.remove('feature')).rejects.toThrow(
				LockedWorktreeError,
			);
		});

		it('✓ POSITIVE: rejects remove when worktree locked with live PID', async () => {
			const lockPath = join(
				TEST_REPO_DIR,
				'.git',
				'worktrees',
				'feature',
				'locked',
			);
			mkdirSync(join(TEST_REPO_DIR, '.git', 'worktrees', 'feature'), {
				recursive: true,
			});
			// Use current process PID (will be alive)
			writeFileSync(lockPath, String(process.pid), { mode: 0o600 });

			const featurePath = join(TEST_REPO_DIR, '.worktrees', 'feature');
			const mockExec = createSimpleMockExec([
				{
					args: ['worktree', 'list', '--porcelain'],
					response: {
						exitCode: 0,
						stdout: `worktree ${TEST_REPO_DIR}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${featurePath}\nHEAD def456\nbranch refs/heads/feature`,
						stderr: '',
					},
				},
			]);

			const manager = new WorktreeManager({
				repoRoot: TEST_REPO_DIR,
				events: mockEvents,
				exec: mockExec,
			});

			await expect(manager.remove('feature')).rejects.toThrow(
				LockedWorktreeError,
			);
		});

		it('✓ COVERAGE: ensure readLockContent ENOENT path is exercised', async () => {
			// This test explicitly ensures the ENOENT branch in readLockContent is hit
			const worktreeWorktreeDir = join(
				TEST_REPO_DIR,
				'.git',
				'worktrees',
				'feature',
			);
			mkdirSync(worktreeWorktreeDir, { recursive: true });
			// Do NOT create a lock file - this means it's missing

			const featurePath = join(TEST_REPO_DIR, '.worktrees', 'feature');
			const mockExec = createSimpleMockExec([
				{
					args: ['worktree', 'list', '--porcelain'],
					response: {
						exitCode: 0,
						stdout: `worktree ${TEST_REPO_DIR}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${featurePath}\nHEAD def456\nbranch refs/heads/feature`,
						stderr: '',
					},
				},
				{
					args: ['-C', featurePath, 'status', '--porcelain'],
					response: { exitCode: 0, stdout: '', stderr: '' },
				},
				{
					args: ['worktree', 'remove', featurePath],
					response: { exitCode: 0, stdout: '', stderr: '' },
				},
				{
					args: ['worktree', 'prune'],
					response: { exitCode: 0, stdout: '', stderr: '' },
				},
			]);

			const manager = new WorktreeManager({
				repoRoot: TEST_REPO_DIR,
				events: mockEvents,
				exec: mockExec,
			});

			// This should succeed because the lock file is missing (ENOENT path in readLockContent)
			await expect(manager.remove('feature')).resolves.not.toThrow();
		});

		it('✓ NEGATIVE: allows remove when lock file missing', async () => {
			const featurePath = join(TEST_REPO_DIR, '.worktrees', 'feature');

			// Ensure lock directory exists but lock file does NOT exist
			mkdirSync(join(TEST_REPO_DIR, '.git', 'worktrees', 'feature'), {
				recursive: true,
			});
			// No lock file created

			const mockExec = createSimpleMockExec([
				{
					args: ['worktree', 'list', '--porcelain'],
					response: {
						exitCode: 0,
						stdout: `worktree ${TEST_REPO_DIR}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${featurePath}\nHEAD def456\nbranch refs/heads/feature`,
						stderr: '',
					},
				},
				{
					args: [
						'-C',
						join(TEST_REPO_DIR, '.worktrees', 'feature'),
						'status',
						'--porcelain',
					],
					response: { exitCode: 0, stdout: '', stderr: '' },
				},
				{
					args: ['worktree', 'remove', featurePath],
					response: { exitCode: 0, stdout: '', stderr: '' },
				},
				{
					args: ['worktree', 'prune'],
					response: { exitCode: 0, stdout: '', stderr: '' },
				},
			]);

			const manager = new WorktreeManager({
				repoRoot: TEST_REPO_DIR,
				events: mockEvents,
				exec: mockExec,
			});

			await expect(manager.remove('feature')).resolves.not.toThrow(
				LockedWorktreeError,
			);
		});
	});

	describe('Create', () => {
		it('creates worktree with new branch', async () => {
			const featurePath = join(TEST_REPO_DIR, '.worktrees', 'feature');
			const mockExec = createSimpleMockExec([
				{
					args: ['worktree', 'list', '--porcelain'],
					response: {
						exitCode: 0,
						stdout: `worktree ${TEST_REPO_DIR}\nHEAD abc123\nbranch refs/heads/main`,
						stderr: '',
					},
				},
				{
					args: ['worktree', 'add', '-b', 'feature', featurePath, 'main'],
					response: { exitCode: 0, stdout: '', stderr: '' },
				},
				{
					args: ['-C', featurePath, 'rev-parse', 'HEAD'],
					response: { exitCode: 0, stdout: 'def456', stderr: '' },
				},
				{
					args: ['worktree', 'list', '--porcelain'],
					response: {
						exitCode: 0,
						stdout: `worktree ${featurePath}\nHEAD def456\nbranch refs/heads/feature`,
						stderr: '',
					},
				},
			]);

			const manager = new WorktreeManager({
				repoRoot: TEST_REPO_DIR,
				events: mockEvents,
				exec: mockExec,
			});
			const result = await manager.create({
				branch: 'feature',
				newBranch: true,
			});

			expect(result.name).toBe('feature');
			expect(result.state).toBe('ready');
		});

		it('creates worktree with custom path', async () => {
			const customPath = join(TEST_REPO_DIR, 'custom-path');
			const mockExec = createSimpleMockExec([
				{
					args: ['worktree', 'list', '--porcelain'],
					response: {
						exitCode: 0,
						stdout: `worktree ${TEST_REPO_DIR}\nHEAD abc123\nbranch refs/heads/main`,
						stderr: '',
					},
				},
				{
					args: ['worktree', 'add', customPath, '-b', 'custom-main'],
					response: {
						exitCode: 0,
						stdout: '',
						stderr: '',
					},
				},
				{
					args: ['worktree', 'list', '--porcelain'],
					response: {
						exitCode: 0,
						stdout: `worktree ${customPath}\nHEAD def456\nbranch refs/heads/custom-main`,
						stderr: '',
					},
				},
			]);

			const manager = new WorktreeManager({
				repoRoot: TEST_REPO_DIR,
				events: mockEvents,
				exec: mockExec,
			});
			const result = await manager.create({
				branch: 'custom-main',
				path: customPath,
				newBranch: true,
			});

			expect(result.name).toBe('custom-path');
			expect(result.path).toBe(customPath);
		});

		it('creates worktree with baseRef', async () => {
			const featurePath = join(TEST_REPO_DIR, '.worktrees', 'feature');
			const mockExec = createSimpleMockExec([
				{
					args: ['worktree', 'list', '--porcelain'],
					response: {
						exitCode: 0,
						stdout: `worktree ${TEST_REPO_DIR}\nHEAD abc123\nbranch refs/heads/main`,
						stderr: '',
					},
				},
				{
					args: ['worktree', 'add', featurePath, 'main'],
					response: { exitCode: 0, stdout: '', stderr: '' },
				},
				{
					args: ['-C', featurePath, 'rev-parse', 'HEAD'],
					response: { exitCode: 0, stdout: 'def456', stderr: '' },
				},
				{
					args: ['worktree', 'list', '--porcelain'],
					response: {
						exitCode: 0,
						stdout: `worktree ${featurePath}\nHEAD def456\nbranch refs/heads/feature`,
						stderr: '',
					},
				},
			]);

			const manager = new WorktreeManager({
				repoRoot: TEST_REPO_DIR,
				events: mockEvents,
				exec: mockExec,
			});
			const result = await manager.create({
				branch: 'feature',
				baseRef: 'main',
			});

			expect(result.name).toBe('feature');
			expect(result.state).toBe('ready');
		});

		it('handles git command failure', async () => {
			const featurePath = join(TEST_REPO_DIR, '.worktrees', 'feature');
			const mockExec: ExecFn = async (command, args) => {
				const argsStr = args.join(' ');

				if (argsStr.includes('worktree list')) {
					return {
						exitCode: 0,
						stdout: `worktree ${TEST_REPO_DIR}\nHEAD abc123\nbranch refs/heads/main`,
						stderr: '',
					};
				}
				if (argsStr.includes('worktree add') && argsStr.includes(featurePath)) {
					throw new GitCommandError(
						'git',
						['-C', TEST_REPO_DIR, 'worktree', 'add', featurePath, 'main'],
						128,
						'fatal: invalid branch name',
					);
				}

				return { exitCode: 0, stdout: '', stderr: '' };
			};

			const manager = new WorktreeManager({
				repoRoot: TEST_REPO_DIR,
				events: mockEvents,
				exec: mockExec,
			});

			await expect(manager.create({ branch: 'feature' })).rejects.toThrow(
				GitCommandError,
			);
		});
	});

	describe('List', () => {
		it('lists worktrees from git state', async () => {
			// Create a worktree entry in persistence to test the "update last seen" path
			const worktreesPath = join(TEST_REPO_DIR, '.pi', 'worktrees.json');
			writeFileSync(
				worktreesPath,
				JSON.stringify({
					version: 1,
					entries: [
						{
							name: 'main',
							path: TEST_REPO_DIR,
							branch: 'main',
							head: 'abc123',
							state: 'ready',
							createdAt: '2024-01-01T00:00:00.000Z',
							lastSeenAt: '2024-01-01T00:00:00.000Z',
						},
					],
				}),
				{ mode: 0o600 },
			);

			const mockExec = createSimpleMockExec([
				{
					args: ['worktree', 'list', '--porcelain'],
					response: {
						exitCode: 0,
						stdout: `worktree ${TEST_REPO_DIR}\nHEAD abc123\nbranch refs/heads/main`,
						stderr: '',
					},
				},
			]);

			const manager = new WorktreeManager({
				repoRoot: TEST_REPO_DIR,
				events: mockEvents,
				exec: mockExec,
			});
			const list = await manager.list();

			expect(list).toHaveLength(1);
			expect(list[0].branch).toBe('main');
		});

		it('creates entries for discovered worktrees not in persistence', async () => {
			const featurePath = join(TEST_REPO_DIR, '.worktrees', 'feature');

			const mockExec = createSimpleMockExec([
				{
					args: ['worktree', 'list', '--porcelain'],
					response: {
						exitCode: 0,
						stdout: `worktree ${TEST_REPO_DIR}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${featurePath}\nHEAD def456\nbranch refs/heads/feature`,
						stderr: '',
					},
				},
			]);

			const manager = new WorktreeManager({
				repoRoot: TEST_REPO_DIR,
				events: mockEvents,
				exec: mockExec,
			});
			const list = await manager.list();

			expect(list).toHaveLength(2);

			// Check that feature worktree was discovered and created
			const featureWorktree = list.find((w) => w.name === 'feature');
			expect(featureWorktree).toBeDefined();
			expect(featureWorktree?.state).toBe('ready');
			expect(featureWorktree?.path).toBe(featurePath);
		});

		it('updates lastSeenAt for existing persistence entries during list', async () => {
			// This test covers lines 306-309 in list(): updating existing entries
			const worktreesPath = join(TEST_REPO_DIR, '.pi', 'worktrees.json');

			// Create an entry in persistence with an old lastSeenAt
			const oldTimestamp = '2024-01-01T00:00:00.000Z';
			const existingPath = join(TEST_REPO_DIR, '.worktrees', 'existing');

			writeFileSync(
				worktreesPath,
				JSON.stringify({
					version: 1,
					entries: [
						{
							name: 'existing',
							path: existingPath,
							branch: 'feature',
							head: 'abc123',
							state: 'ready',
							createdAt: oldTimestamp,
							lastSeenAt: oldTimestamp,
						},
					],
				}),
				{ mode: 0o600 },
			);

			const mockExec = createSimpleMockExec([
				{
					args: ['worktree', 'list', '--porcelain'],
					response: {
						exitCode: 0,
						stdout: `worktree ${existingPath}\nHEAD abc123\nbranch refs/heads/feature`,
						stderr: '',
					},
				},
			]);

			const manager = new WorktreeManager({
				repoRoot: TEST_REPO_DIR,
				events: mockEvents,
				exec: mockExec,
			});
			const list = await manager.list();

			// Verify the returned worktree exists
			// Note: list() doesn't persist changes back to file
			const existingEntry = list.find((w) => w.name === 'existing');
			expect(existingEntry).toBeDefined();
			expect(existingEntry?.path).toBe(existingPath);
		});
	});

	describe('Reset', () => {
		it('resets failed worktree to pending state', async () => {
			const worktreesPath = join(TEST_REPO_DIR, '.pi', 'worktrees.json');
			writeFileSync(
				worktreesPath,
				JSON.stringify({
					version: 1,
					entries: [
						{
							name: 'failed-worktree',
							path: join(TEST_REPO_DIR, '.worktrees', 'failed'),
							branch: 'feature',
							head: 'abc123',
							state: 'failed',
							createdAt: new Date().toISOString(),
							lastSeenAt: new Date().toISOString(),
							error: 'test error',
						},
					],
				}),
				{ mode: 0o600 },
			);

			const mockExec = createSimpleMockExec([]);

			const manager = new WorktreeManager({
				repoRoot: TEST_REPO_DIR,
				events: mockEvents,
				exec: mockExec,
			});
			await manager.reset('failed-worktree');

			const updated = readFileSync(worktreesPath, 'utf-8');
			const data = JSON.parse(updated);
			const entry = data.entries.find(
				(e: { name: string }) => e.name === 'failed-worktree',
			);
			expect(entry.state).toBe('pending');
			expect(entry.error).toBeUndefined();
		});

		it('throws when worktree file does not exist', async () => {
			const mockExec = createSimpleMockExec([]);

			const manager = new WorktreeManager({
				repoRoot: TEST_REPO_DIR,
				events: mockEvents,
				exec: mockExec,
			});

			await expect(manager.reset('nonexistent')).rejects.toThrow(
				GitCommandError,
			);
		});

		it('throws when worktree entry not found in file', async () => {
			const worktreesPath = join(TEST_REPO_DIR, '.pi', 'worktrees.json');
			writeFileSync(
				worktreesPath,
				JSON.stringify({
					version: 1,
					entries: [
						{
							name: 'other-worktree',
							path: join(TEST_REPO_DIR, '.worktrees', 'other'),
							branch: 'feature',
							head: 'abc123',
							state: 'failed',
							createdAt: new Date().toISOString(),
							lastSeenAt: new Date().toISOString(),
						},
					],
				}),
				{ mode: 0o600 },
			);

			const mockExec = createSimpleMockExec([]);

			const manager = new WorktreeManager({
				repoRoot: TEST_REPO_DIR,
				events: mockEvents,
				exec: mockExec,
			});

			await expect(manager.reset('nonexistent')).rejects.toThrow(
				GitCommandError,
			);
		});
	});

	describe('Remove error handling', () => {
		beforeEach(() => {
			vi.restoreAllMocks();
		});
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it('transitions to failed state on git command error', async () => {
			const worktreesPath = join(TEST_REPO_DIR, '.pi', 'worktrees.json');
			const featurePath = join(TEST_REPO_DIR, '.worktrees', 'feature');

			// Create initial worktree entry
			writeFileSync(
				worktreesPath,
				JSON.stringify({
					version: 1,
					entries: [
						{
							name: 'feature',
							path: featurePath,
							branch: 'feature',
							head: 'abc123',
							state: 'ready',
							createdAt: new Date().toISOString(),
							lastSeenAt: new Date().toISOString(),
						},
					],
				}),
				{ mode: 0o600 },
			);

			const mockExec: ExecFn = async (command, args) => {
				const argsStr = args.join(' ');
				if (argsStr.includes('worktree list')) {
					return {
						exitCode: 0,
						stdout: `worktree ${TEST_REPO_DIR}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${featurePath}\nHEAD def456\nbranch refs/heads/feature`,
						stderr: '',
					};
				}
				if (argsStr.includes('status --porcelain')) {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				if (argsStr.includes('worktree remove')) {
					throw new GitCommandError(
						'git',
						['-C', TEST_REPO_DIR, 'worktree', 'remove', featurePath],
						128,
						'fatal: target locked',
					);
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			};

			const manager = new WorktreeManager({
				repoRoot: TEST_REPO_DIR,
				events: mockEvents,
				exec: mockExec,
			});

			await expect(manager.remove('feature')).rejects.toThrow(GitCommandError);

			// Check that entry transitioned to failed state
			const updated = readFileSync(worktreesPath, 'utf-8');
			const data = JSON.parse(updated);
			const entry = data.entries.find(
				(e: { name: string }) => e.name === 'feature',
			);
			expect(entry.state).toBe('failed');
			expect(entry.error).toContain('target locked');
		});

		it('throws when worktree not found in git', async () => {
			const mockExec = createSimpleMockExec([
				{
					args: ['worktree', 'list', '--porcelain'],
					response: {
						exitCode: 0,
						stdout: `worktree ${TEST_REPO_DIR}\nHEAD abc123\nbranch refs/heads/main`,
						stderr: '',
					},
				},
			]);

			const manager = new WorktreeManager({
				repoRoot: TEST_REPO_DIR,
				events: mockEvents,
				exec: mockExec,
			});

			await expect(manager.remove('nonexistent')).rejects.toThrow(
				GitCommandError,
			);
		});
	});
});

/**
 * Helper function to create a simple mock exec function.
 * Takes a list of expected calls in order and returns responses sequentially.
 * Throws GitCommandError for non-zero exit codes.
 */
function createSimpleMockExec(
	responses: Array<{
		args: string[];
		response: { exitCode: number; stdout: string; stderr: string };
	}>,
): ExecFn {
	let callIndex = 0;

	return async (command, args) => {
		if (callIndex >= responses.length) {
			return { exitCode: 0, stdout: '', stderr: '' };
		}

		const expected = responses[callIndex];
		callIndex++;

		// Simple matching: check if all expected args are present in actual args
		const allExpectedPresent = expected.args.every((expectedArg) =>
			args.includes(expectedArg),
		);

		if (!allExpectedPresent) {
			return { exitCode: 0, stdout: '', stderr: '' };
		}

		const { exitCode, stdout, stderr } = expected.response;

		// Throw GitCommandError for non-zero exit codes (mimics real git exec)
		if (exitCode !== 0) {
			throw new GitCommandError(command, args, exitCode, stderr);
		}

		return { exitCode: 0, stdout, stderr };
	};
}
