module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/integration/**/*.spec.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@services/(.*)$': '<rootDir>/src/services/$1',
    '^@models/(.*)$': '<rootDir>/src/models/$1',
    '^@utils/(.*)$': '<rootDir>/src/utils/$1',
    '^@fixtures/(.*)$': '<rootDir>/tests/fixtures/$1'
  },
  testTimeout: 30000,
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts']
};
