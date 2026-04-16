#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const fs = require("node:fs");

const invocationPattern = [
  "pnpm\\s+(run\\s+)?test:unit(\\s|$)",
  "npm\\s+run\\s+test:unit(\\s|$)",
  "yarn\\s+test:unit(\\s|$)",
  "turbo\\s+run\\s+test:unit(\\s|$)"
].join("|");

const searchTargets = [".github", "scripts"].filter((p) => fs.existsSync(p));
if (searchTargets.length === 0) {
  console.log("OK: no search targets found for legacy test:unit usage check.");
  process.exit(0);
}

const args = [
  "-n",
  "-e",
  invocationPattern,
  ...searchTargets,
  "--glob",
  "!**/logs/**",
  "--glob",
  "!**/node_modules/**"
];

const result = spawnSync("rg", args, { stdio: "inherit" });

if (result.error && result.error.code === "ENOENT") {
  console.error("ERROR: rg is required for checks:forbid-legacy-test-unit");
  process.exit(1);
}

if (result.status === 0) {
  console.error("ERROR: found legacy test:unit usage. Use layered test scripts.");
  process.exit(1);
}

if (result.status === 1) {
  console.log("OK: no legacy test:unit usage found.");
  process.exit(0);
}

process.exit(result.status || 1);
