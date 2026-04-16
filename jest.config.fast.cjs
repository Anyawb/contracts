const base = require("./jest.config.base.cjs");

module.exports = {
  ...base,
  displayName: "fast-pgmem",
  testMatch: ["<rootDir>/tests/fast/**/*.spec.ts", "<rootDir>/tests/fast/**/*.test.ts"],
  maxWorkers: "50%"
};
