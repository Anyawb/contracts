/* eslint-disable no-console */
// One-click acceptance runner for the "funds-chain guard/SSOT consistency" guide.
//
// Why this exists:
// - `hardhat test` does NOT accept directory paths like `test/Vault/view` (it treats it as a module path).
// - We want a stable one-click script that can include whole folders (P2 view modules) without manually listing files.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function walk(dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
}

function listTestFiles(relDir) {
  const absDir = path.resolve(process.cwd(), relDir);
  if (!fs.existsSync(absDir)) return [];
  const all = [];
  walk(absDir, all);
  return all
    .filter((p) => p.endsWith(".test.ts"))
    .map((p) => path.relative(process.cwd(), p))
    .sort();
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: "inherit" });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

const baseTests = [
  // P0 (direct funds/ledger writers)
  "test/CollateralManager.security.test.ts",
  "test/Vault/modules/CollateralManager.liquidation-access.test.ts",
  "test/core/FeeRouter.test.ts",
  "test/fixed-tests/FeeRouterFixed.test.ts",
  "test/core/LoanNFT.test.ts",
  "test/core/PriceOracle.new.test.ts",

  // P1 (entry orchestration)
  "test/VaultRouter.test.ts",
  "test/Vault/modules/VaultBusinessLogic.test.ts",

  // P0/P2 adjacent (oracle updater frequently coupled with view/oracle wiring)
  "test/core/CoinGeckoPriceUpdater.test.ts",
];

const viewTests = [
  ...listTestFiles("test/Vault/view"),
  ...listTestFiles("test/Vault/view/modules"),
];

// De-dup while preserving order.
const seen = new Set();
const tests = [...baseTests, ...viewTests].filter((t) => {
  if (seen.has(t)) return false;
  seen.add(t);
  return true;
});

console.log(`[funds-guards] Running ${tests.length} test files...`);
run("pnpm", ["-s", "test", ...tests]);

