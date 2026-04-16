const base = require("./jest.config.base.cjs");

module.exports = {
  ...base,
  displayName: "integration",
  testMatch: ["<rootDir>/tests/integration/**/*.spec.ts", "<rootDir>/tests/integration/**/*.test.ts"],
  maxWorkers: 1,
  testTimeout: 30000
};
