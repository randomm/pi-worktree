import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		passWithNoTests: true,
		include: ['tests/**/*.test.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json'],
			exclude: [
				'node_modules/',
				'tests/',
				'.worktrees/',
				'*.config.ts',
				'index.ts',
			],
			thresholds: {
				lines: 80,
				functions: 80,
				branches: 80,
				statements: 80,
				perFile: true,
				'persistence.ts': {
					lines: 85,
					functions: 85,
					branches: 85,
					statements: 85,
				},
				'worktree-ops.ts': {
					lines: 85,
					functions: 85,
					branches: 85,
					statements: 85,
				},
			},
		},
	},
});
