#!/usr/bin/env node
/**
 * OZ v5 acceptance check (local):
 * - Ensures installed OpenZeppelin versions are v5.x
 * - Ensures Hardhat solc is configured to >=0.8.22 (this repo baseline: 0.8.27)
 */
const fs = require("fs");
const path = require("path");

function die(msg) {
  // eslint-disable-next-line no-console
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function major(version) {
  const m = String(version || "").match(/^(\d+)\./);
  return m ? Number(m[1]) : NaN;
}

const repoRoot = path.resolve(__dirname, "..", "..");

// 1) node_modules versions (ground truth for local dev)
const ozUp = readJson(
  path.join(repoRoot, "node_modules", "@openzeppelin", "contracts-upgradeable", "package.json")
).version;
const oz = readJson(path.join(repoRoot, "node_modules", "@openzeppelin", "contracts", "package.json")).version;

if (major(ozUp) !== 5) die(`@openzeppelin/contracts-upgradeable must be v5.x, got ${ozUp}`);
if (major(oz) !== 5) die(`@openzeppelin/contracts must be v5.x, got ${oz}`);

// 2) hardhat solc version (TS config, parse by regex)
const hhPath = path.join(repoRoot, "hardhat.config.ts");
const hh = fs.readFileSync(hhPath, "utf8");
const m = hh.match(/version:\s*['"](\d+\.\d+\.\d+)['"]/);
if (!m) die("Could not find Hardhat solidity.version in hardhat.config.ts");

const solc = m[1];
const [a, b, c] = solc.split(".").map((x) => Number(x));
if ([a, b, c].some((x) => Number.isNaN(x))) die(`Invalid solc version parsed from hardhat.config.ts: ${solc}`);

// Must be >= 0.8.22 for OZ v5 upgradeable
const ok = a > 0 || (a === 0 && (b > 8 || (b === 8 && c >= 22)));
if (!ok) die(`Hardhat solidity.version must be >= 0.8.22 for OZ v5; got ${solc}`);

// eslint-disable-next-line no-console
console.log(`OZ v5 OK: contracts@${oz}, contracts-upgradeable@${ozUp}; solc=${solc}`);

