#!/usr/bin/env node
/**
 * Local safety check: ensure lockfiles are consistent with pnpm-only policy.
 */
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..", "..");

const forbidden = ["package-lock.json", "yarn.lock"];
const required = ["pnpm-lock.yaml"];

const problems = [];

for (const f of forbidden) {
  const p = path.join(repoRoot, f);
  if (fs.existsSync(p)) problems.push(`Forbidden lockfile present: ${f}`);
}

for (const f of required) {
  const p = path.join(repoRoot, f);
  if (!fs.existsSync(p)) problems.push(`Required lockfile missing: ${f}`);
}

if (problems.length > 0) {
  // eslint-disable-next-line no-console
  console.error(["Lockfile check failed:", ...problems.map((x) => `- ${x}`)].join("\n"));
  process.exit(1);
}

// eslint-disable-next-line no-console
console.log("Lockfile check OK.");

