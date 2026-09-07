import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    coverage: {
      reporter: ['text', 'json-summary']
    }
  }
})
