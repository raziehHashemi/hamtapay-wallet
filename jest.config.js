/** @type {import('jest').Config} */
const tsJest = ['ts-jest', { tsconfig: 'tsconfig.json' }];

module.exports = {
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      rootDir: '.',
      modulePathIgnorePatterns: ['<rootDir>/.local/', '<rootDir>/dist/'],
      testMatch: ['<rootDir>/src/**/*.spec.ts'],
      transform: { '^.+\\.ts$': tsJest },
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      rootDir: '.',
      modulePathIgnorePatterns: ['<rootDir>/.local/', '<rootDir>/dist/'],
      testMatch: ['<rootDir>/test/integration/**/*.int-spec.ts'],
      transform: { '^.+\\.ts$': tsJest },
      globalSetup: '<rootDir>/test/support/global-setup.ts',
      globalTeardown: '<rootDir>/test/support/global-teardown.ts',
      setupFilesAfterEnv: ['<rootDir>/test/support/jest-integration.setup.ts'],
    },
    {
      displayName: 'e2e',
      testEnvironment: 'node',
      rootDir: '.',
      modulePathIgnorePatterns: ['<rootDir>/.local/', '<rootDir>/dist/'],
      testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
      transform: { '^.+\\.ts$': tsJest },
      setupFilesAfterEnv: ['<rootDir>/test/support/jest-e2e.setup.ts'],
    },
  ],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/main.ts', '!src/database/migrations/**'],
  coverageDirectory: 'coverage',
};
