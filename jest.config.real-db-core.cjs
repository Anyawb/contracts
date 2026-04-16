const base = require("./jest.config.base.cjs");

module.exports = {
  ...base,
  displayName: "real-db-core",
  testMatch: ["<rootDir>/tests/real-db-core/**/*.spec.ts", "<rootDir>/tests/real-db-core/**/*.test.ts"],
  maxWorkers: 1
};
