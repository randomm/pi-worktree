/**
 * State machine for worktree lifecycle management.
 */

import { InvalidStateTransitionError } from './errors';

export type WorktreeState =
	| 'pending'
	| 'ready'
	| 'failed'
	| 'removing'
	| 'gone';

/**
 * Valid state transitions in the worktree lifecycle.
 *
 * INIT → pending (on create call accepted)
 * pending → ready (all safety checks pass, git worktree add succeeds, persisted)
 * pending → failed (any safety check or git error; persists with error reason)
 * ready → removing (on remove call)
 * removing → gone (status clean, dir removed, prune succeeded)
 * removing → failed (any step fails; reset() can recover)
 * failed → pending (via reset())
 * gone is terminal (entry pruned from persistence)
 */
export const VALID_TRANSITIONS: Record<WorktreeState, WorktreeState[]> = {
	pending: ['ready', 'failed'],
	ready: ['removing', 'failed'],
	failed: ['pending', 'removing'],
	removing: ['gone', 'failed'],
	gone: [],
};

/**
 * Transition the worktree state.
 *
 * @param currentState - Current state of the worktree
 * @param targetState - Desired new state
 * @returns The new state after transition
 * @throws InvalidStateTransitionError if transition is not valid
 */
export function transitionState(
	currentState: WorktreeState,
	targetState: WorktreeState,
): WorktreeState {
	const allowed = VALID_TRANSITIONS[currentState];
	if (!allowed.includes(targetState)) {
		throw new InvalidStateTransitionError(currentState, targetState);
	}
	return targetState;
}

/**
 * Check if a transition is valid without throwing.
 *
 * @param currentState - Current state
 * @param targetState - Target state
 * @returns true if transition is valid, false otherwise
 */
export function isValidTransition(
	currentState: WorktreeState,
	targetState: WorktreeState,
): boolean {
	return VALID_TRANSITIONS[currentState].includes(targetState);
}
