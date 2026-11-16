/** @type {import('jest').Config} */
const tsJest = ['ts-jest', { tsconfig: 'tsconfig.json', isolatedModules: true }];

module.exports = {
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      rootDir: '.',
      testMatch: ['<rootDir>/src/**/*.spec.ts'],
      transform: { '^.+\\.ts$': tsJest },
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      rootDir: '.',
      testMatch: ['<rootDir>/test/integration/**/*.int-spec.ts'],
      transform: { '^.+\\.ts$': tsJest },
      globalSetup: '<rootDir>/test/support/global-setup.ts',
      globalTeardown: '<rootDir>/test/support/global-teardown.ts',
      testTimeout: 60000,
    },
    {
      displayName: 'e2e',
      testEnvironment: 'node',
      rootDir: '.',
      testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
      transform: { '^.+\\.ts$': tsJest },
      testTimeout: 300000,
    },
  ],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/main.ts', '!src/database/migrations/**'],
  coverageDirectory: 'coverage',
};
