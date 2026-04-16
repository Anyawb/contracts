module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  clearMocks: true,
  restoreMocks: true,
  verbose: true,
  roots: ["<rootDir>/tests"],
  moduleFileExtensions: ["ts", "tsx", "js", "cjs", "mjs", "json"],
  transform: {
    "^.+\\.(ts|tsx)$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.json",
        diagnostics: false
      }
    ]
  }
};
