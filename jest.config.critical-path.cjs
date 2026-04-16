const base = require("./jest.config.base.cjs");

module.exports = {
  ...base,
  displayName: "critical-path",
  testMatch: ["<rootDir>/tests/critical-path/**/*.spec.ts", "<rootDir>/tests/critical-path/**/*.test.ts"],
  maxWorkers: 1,
  testTimeout: 30000
};
