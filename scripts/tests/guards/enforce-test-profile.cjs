#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const profile = process.env.TEST_PROFILE;
const extraArgs = process.argv.slice(2);

const truthy = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

const profiles = {
  fast: {
    requireRealPostgres: false,
    allowPgMem: true,
    jestConfig: "jest.config.fast.cjs"
  },
  "real-db-core": {
    requireRealPostgres: true,
    allowPgMem: false,
    jestConfig: "jest.config.real-db-core.cjs"
  },
  "critical-path": {
    requireRealPostgres: true,
    allowPgMem: false,
    jestConfig: "jest.config.critical-path.cjs"
  },
  integration: {
    requireRealPostgres: true,
    allowPgMem: false,
    jestConfig: "jest.config.integration.cjs"
  },
  invariant: {
    requireRealPostgres: true,
    allowPgMem: false,
    jestConfig: "jest.config.invariant.cjs"
  }
};

const cfg = profiles[profile];
if (!cfg) {
  console.error("ERROR: unknown TEST_PROFILE:", profile);
  process.exit(1);
}

const usePgMem = truthy(process.env.USE_PG_MEM);
const hasDatabaseUrl = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim());

if (profile === "critical-path" && usePgMem) {
  console.error("ERROR: test:critical-path forbids USE_PG_MEM=1");
  process.exit(1);
}

if (!cfg.allowPgMem && usePgMem) {
  console.error(`ERROR: ${profile} forbids USE_PG_MEM=1`);
  process.exit(1);
}

if (profile === "fast" && !usePgMem && hasDatabaseUrl) {
  console.error("ERROR: test:fast detected DATABASE_URL without USE_PG_MEM=1. Refusing ambiguous DB mode.");
  process.exit(1);
}

process.env.REQUIRE_REAL_POSTGRES = cfg.requireRealPostgres ? "1" : "0";

let jestBin;
try {
  jestBin = require.resolve("jest/bin/jest");
} catch (error) {
  console.error("ERROR: jest is not installed. Add jest devDependency before running layered test commands.");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [jestBin, "--config", cfg.jestConfig, ...extraArgs],
  {
    stdio: "inherit",
    env: process.env
  }
);

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);
