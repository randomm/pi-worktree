/**
 * Event name constants and payload type contracts for EventBus integration.
 */

import type { WorktreeState } from './state-machine.js';

export const WORKTREE_CREATED = 'worktree:created';
export const WORKTREE_REMOVED = 'worktree:removed';
export const WORKTREE_LOCKED = 'worktree:locked';
export const WORKTREE_FAILED = 'worktree:failed';

export interface WorktreeCreatedPayload {
	name: string;
	path: string;
	branch: string;
	head: string;
}

export interface WorktreeRemovedPayload {
	name: string;
	path: string;
}

export interface WorktreeLockedPayload {
	name: string;
	path: string;
	lockReason?: string;
}

export interface WorktreeFailedPayload {
	name: string;
	path: string;
	state: WorktreeState;
	error: string;
}

export type WorktreeEventPayload =
	| WorktreeCreatedPayload
	| WorktreeRemovedPayload
	| WorktreeLockedPayload
	| WorktreeFailedPayload;

/**
 * Minimal EventBus interface for harness integration.
 * Mirrors the @mariozechner/pi-coding-agent EventBus API without import dependency.
 */
interface EventBus {
	emit(event: string, payload: unknown): void;
}

/**
 * Type-safe event emitter for worktree events.
 */
export function emitWorktreeEvent(
	bus: unknown, // EventBus from harness - typed as unknown to avoid import dependency
	event:
		| typeof WORKTREE_CREATED
		| typeof WORKTREE_REMOVED
		| typeof WORKTREE_LOCKED
		| typeof WORKTREE_FAILED,
	payload: WorktreeEventPayload,
): void {
	// EventBus.emit is synchronous; subscriber errors are caught by harness
	(bus as EventBus | undefined)?.emit(event, payload);
}
