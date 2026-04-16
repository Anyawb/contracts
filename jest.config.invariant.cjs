const base = require("./jest.config.base.cjs");

module.exports = {
  ...base,
  displayName: "invariant",
  testMatch: ["<rootDir>/tests/invariant/**/*.spec.ts", "<rootDir>/tests/invariant/**/*.test.ts"],
  maxWorkers: 1,
  testTimeout: 60000
};
