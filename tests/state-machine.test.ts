/**
 * Tests for state machine transitions.
 */

import { describe, expect, it } from 'vitest';
import {
	type WorktreeState,
	isValidTransition,
	transitionState,
} from '../state-machine';

describe('transitionState', () => {
	const statePairs: [WorktreeState, WorktreeState, boolean][] = [
		['pending', 'ready', true],
		['pending', 'failed', true],
		['pending', 'removing', false],
		['pending', 'gone', false],
		['ready', 'removing', true],
		['ready', 'failed', true],
		['ready', 'pending', false],
		['ready', 'gone', false],
		['failed', 'pending', true],
		['failed', 'removing', true],
		['failed', 'ready', false],
		['failed', 'gone', false],
		['removing', 'gone', true],
		['removing', 'failed', true],
		['removing', 'pending', false],
		['removing', 'ready', false],
		['gone', 'pending', false],
		['gone', 'ready', false],
		['gone', 'failed', false],
		['gone', 'removing', false],
	];

	it.each(statePairs)(
		'transition %s → %s should be: %s',
		(from, to, shouldBeValid) => {
			if (shouldBeValid) {
				expect(() => transitionState(from, to)).not.toThrow();
			} else {
				expect(() => transitionState(from, to)).toThrow(
					'Invalid state transition',
				);
			}
		},
	);
});

describe('isValidTransition', () => {
	const statePairs: [WorktreeState, WorktreeState, boolean][] = [
		['pending', 'ready', true],
		['pending', 'failed', true],
		['pending', 'removing', false],
		['ready', 'removing', true],
		['ready', 'failed', true],
		['failed', 'pending', true],
		['failed', 'removing', true],
		['removing', 'gone', true],
		['removing', 'failed', true],
		['gone', 'pending', false],
	];

	it.each(statePairs)(
		'isValidTransition(%s, %s) returns %s',
		(from, to, expected) => {
			expect(isValidTransition(from, to)).toBe(expected);
		},
	);
});
