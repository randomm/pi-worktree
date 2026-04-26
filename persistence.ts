/**
 * Persistence layer for worktree state.
 * Mirrors pi-permissions persistence.ts patterns:
 * - Atomic write pattern (tmp → rename)
 * - File mode 0o600/0o700
 * - Backup .bak before write, restore on failure
 * - Fail-closed on parse error
 * - Hand-rolled type guards for schema validation
 * - LRU compaction for unbounded growth
 */

import {
	access,
	chmod,
	mkdir,
	open,
	readFile,
	rename,
	unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { PersistenceCorruptError } from './errors';

const WORKTREES_FILENAME = '.pi/worktrees.json';
const WORKTREES_VERSION = 1;
const MAX_WORKTREES = 100;

/**
 * Valid worktree states.
 */
export type WorktreeState =
	| 'pending'
	| 'ready'
	| 'failed'
	| 'removing'
	| 'gone';

/**
 * Single worktree entry in persistence.
 */
export interface WorktreeEntry {
	name: string;
	path: string;
	branch: string;
	head: string;
	state: WorktreeState;
	createdAt: string;
	lastSeenAt: string;
	error?: string;
}

/**
 * Schema for the worktrees.json file.
 */
export interface WorktreesFile {
	version: number;
	entries: WorktreeEntry[];
}

/**
 * Type guard for WorktreeEntry.
 */
function isWorktreeEntry(entry: unknown): entry is WorktreeEntry {
	if (typeof entry !== 'object' || entry === null) {
		return false;
	}

	const e = entry as Record<string, unknown>;

	return (
		typeof e.name === 'string' &&
		typeof e.path === 'string' &&
		typeof e.branch === 'string' &&
		typeof e.head === 'string' &&
		(e.state === 'pending' ||
			e.state === 'ready' ||
			e.state === 'failed' ||
			e.state === 'removing' ||
			e.state === 'gone') &&
		typeof e.createdAt === 'string' &&
		typeof e.lastSeenAt === 'string' &&
		(e.error === undefined || typeof e.error === 'string')
	);
}

/**
 * Type guard for WorktreesFile.
 */
function isWorktreesFile(obj: unknown): obj is WorktreesFile {
	if (typeof obj !== 'object' || obj === null) {
		return false;
	}

	// Whitelist of allowed top-level keys
	const ALLOWED_KEYS = new Set(['version', 'entries']);

	const f = obj as Record<string, unknown>;

	const validVersion =
		typeof f.version === 'number' && f.version === WORKTREES_VERSION;
	const validEntries =
		Array.isArray(f.entries) && f.entries.every(isWorktreeEntry);

	// Check for extra keys or prototype pollution
	// Use Reflect.ownKeys to get all properties including non-enumerable ones
	const keys = Reflect.ownKeys(obj);
	const hasExtraKeys = keys.some((k) => !ALLOWED_KEYS.has(k as string));

	return validVersion && validEntries && !hasExtraKeys;
}

/**
 * Get the path to the worktrees.json file.
 */
function getWorktreesPath(cwd: string): string {
	return join(cwd, WORKTREES_FILENAME);
}

/**
 * Check if a path exists.
 */
async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Ensure the .pi directory exists with secure permissions.
 */
async function ensureWorktreesDirectory(cwd: string): Promise<void> {
	const piDir = join(cwd, '.pi');
	if (!(await pathExists(piDir))) {
		await mkdir(piDir, { mode: 0o700, recursive: true });
	} else {
		// Ensure secure mode
		await chmod(piDir, 0o700);
	}
}

/**
 * Load and validate the worktrees.json file.
 *
 * @throws PersistenceCorruptError if file is corrupt or cannot be parsed
 * @returns Validated WorktreesFile object, or null if file doesn't exist
 */
export async function loadWorktreesFile(
	cwd: string,
): Promise<WorktreesFile | null> {
	const worktreesPath = getWorktreesPath(cwd);

	if (!(await pathExists(worktreesPath))) {
		return null;
	}

	try {
		const raw = await readFile(worktreesPath, 'utf-8');
		const parsed = JSON.parse(raw);

		if (!isWorktreesFile(parsed)) {
			throw new PersistenceCorruptError(worktreesPath);
		}

		return parsed;
	} catch (error) {
		if (error instanceof PersistenceCorruptError) {
			throw error;
		}
		if ((error as { code?: string })?.code === 'ENOENT') {
			return null;
		}
		throw new PersistenceCorruptError(worktreesPath, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

/**
 * Save the worktrees.json file atomically.
 *
 * Follows pi-permissions pattern:
 * - Backup existing file to .bak before write
 * - Write to tmp file, fsync, rename
 * - Restore from .bak on failure
 * - Apply file mode 0o600
 *
 * @throws PersistenceCorruptError on write failure
 */
export async function saveWorktreesFile(
	cwd: string,
	data: WorktreesFile,
): Promise<void> {
	await ensureWorktreesDirectory(cwd);

	const worktreesPath = getWorktreesPath(cwd);
	const tmpPath = `${worktreesPath}.tmp`;
	const backupPath = `${worktreesPath}.bak`;

	// Load existing data for backup
	const existing = await loadWorktreesFile(cwd);

	// LRU compaction: evict oldest pending/failed entries first
	let entries = [...data.entries];
	if (entries.length > MAX_WORKTREES) {
		// Sort by lastSeenAt ascending (oldest first)
		entries.sort((a, b) => Date.parse(a.lastSeenAt) - Date.parse(b.lastSeenAt));
		// Remove oldest entries
		entries = entries.slice(MAX_WORKTREES);
	}

	const newFile: WorktreesFile = {
		version: WORKTREES_VERSION,
		entries,
	};

	// Backup existing file
	if (existing) {
		try {
			const buffer = Buffer.from(JSON.stringify(existing));
			await writeFileAtomic(backupPath, buffer, { mode: 0o600 });
		} catch (backupErr: unknown) {
			throw new Error(
				'Failed to create backup before worktrees write, aborting to prevent data loss',
				{ cause: backupErr },
			);
		}
	}

	// Atomic write: write to tmp, then rename
	let threw = false;
	let originalError: unknown | null = null;

	try {
		const buffer = Buffer.from(JSON.stringify(newFile));
		await writeFileAtomic(tmpPath, buffer, { mode: 0o600 });

		try {
			await rename(tmpPath, worktreesPath);
			await chmod(worktreesPath, 0o600);
		} catch (renameErr: unknown) {
			threw = true;
			originalError = renameErr;
			const code = (renameErr as { code?: string })?.code;
			if (code === 'EXDEV') {
				// Cross-device rename: fall back to read-write-delete
				try {
					await chmod(worktreesPath, 0o600);
				} catch (chmodErr: unknown) {
					const chmodCode = (chmodErr as { code?: string })?.code;
					if (chmodCode !== 'ENOENT') {
						throw chmodErr;
					}
				}
				const buffer = Buffer.from(JSON.stringify(newFile));
				await writeFileAtomic(worktreesPath, buffer, { mode: 0o600 });
			} else {
				throw renameErr;
			}
		}
	} catch (err: unknown) {
		threw = true;
		originalError = err;
	} finally {
		// Clean up tmp file
		try {
			if (await pathExists(tmpPath)) {
				await unlink(tmpPath);
			}
		} catch (cleanupErr: unknown) {
			console.error(`Failed to clean up tmp file ${tmpPath}:`, cleanupErr);
		}

		// If we failed and have a backup, restore it
		if (threw && (await pathExists(backupPath))) {
			try {
				await unlink(worktreesPath);
			} catch (restoreErr: unknown) {
				const code = (restoreErr as { code?: string })?.code;
				if (code !== 'ENOENT') {
					console.error(
						`Failed to delete corrupted worktrees file: ${restoreErr}`,
					);
				}
			}
			try {
				const buffer = Buffer.from(JSON.stringify(existing));
				await writeFileAtomic(worktreesPath, buffer, { mode: 0o600 });
				await chmod(worktreesPath, 0o600);
			} catch (restoreWriteErr: unknown) {
				console.error(
					'Failed to restore backup: data may be lost.',
					restoreWriteErr,
				);
			}
			await unlink(backupPath);
		}

		// Clean up backup file on success
		if (!threw && (await pathExists(backupPath))) {
			try {
				await unlink(backupPath);
			} catch {
				// Ignore
			}
		}
	}

	if (originalError) {
		throw originalError;
	}
}

/**
 * Write file atomically with fsync.
 */
async function writeFileAtomic(
	path: string,
	data: Buffer,
	options: { mode?: number } = {},
): Promise<void> {
	const { mode } = options;
	const fileHandle = await open(path, 'w', mode);
	try {
		await fileHandle.writeFile(data);
		await fileHandle.sync();
	} finally {
		await fileHandle.close();
	}
}

/**
 * Get an entry by name from the worktrees file.
 */
export async function getEntry(
	cwd: string,
	name: string,
): Promise<WorktreeEntry | null> {
	const file = await loadWorktreesFile(cwd);
	if (!file) return null;
	return file.entries.find((e) => e.name === name) ?? null;
}

/**
 * Update or add an entry in the worktrees file.
 */
export async function upsertEntry(
	cwd: string,
	entry: WorktreeEntry,
): Promise<void> {
	const file = (await loadWorktreesFile(cwd)) ?? {
		version: WORKTREES_VERSION,
		entries: [],
	};
	const existingIndex = file.entries.findIndex((e) => e.name === entry.name);

	if (existingIndex >= 0) {
		file.entries[existingIndex] = entry;
	} else {
		file.entries.push(entry);
	}

	await saveWorktreesFile(cwd, file);
}

/**
 * Remove an entry from the worktrees file.
 */
export async function removeEntry(cwd: string, name: string): Promise<void> {
	const file = await loadWorktreesFile(cwd);
	if (!file) return;

	file.entries = file.entries.filter((e) => e.name !== name);
	await saveWorktreesFile(cwd, file);
}
