module.exports = {
  rootDir: '.',
  testRegex: 'src/.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: { module: 'CommonJS', moduleResolution: 'Node', strict: true, esModuleInterop: true, skipLibCheck: true } }] },
  testEnvironment: 'node',
};
