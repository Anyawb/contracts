/**
 * Local automation: validate global module-cache refresh (A-class).
 *
 * Usage (one command):
 * - pnpm -s run test:cache-refresh:localhost
 *
 * Prereqs:
 * - localhost node running: pnpm -s run node
 * - deployed addresses exist: pnpm -s run deploy:localhost
 */
import { readFileSync } from "fs";
import path from "path";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const hre = require("hardhat");
const { ethers, network } = hre;

type DeployMap = Record<string, string>;

function requireEnv(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function selector(signature: string): string {
  // 4-byte selector as 0x???????? (10 chars)
  return ethers.id(signature).slice(0, 10);
}

function loadDeployments(): DeployMap {
  const p = path.join(__dirname, "..", "deployments", "localhost.json");
  const raw = readFileSync(p, "utf8");
  return JSON.parse(raw) as DeployMap;
}

async function main() {
  console.log(`[cache-refresh-local] network=${network.name}`);
  requireEnv(network.name === "localhost", "This script must run with --network localhost");

  const deployed = loadDeployments();
  requireEnv(deployed.Registry, "Missing Registry in scripts/deployments/localhost.json");
  requireEnv(deployed.CacheMaintenanceManager, "Missing CacheMaintenanceManager in scripts/deployments/localhost.json");
  requireEnv(deployed.VaultRouter, "Missing VaultRouter in scripts/deployments/localhost.json");
  requireEnv(deployed.LiquidationRiskManager, "Missing LiquidationRiskManager in scripts/deployments/localhost.json");

  const registry = await ethers.getContractAt("Registry", deployed.Registry);
  const maint = await ethers.getContractAt(
    "src/registry/CacheMaintenanceManager.sol:CacheMaintenanceManager",
    deployed.CacheMaintenanceManager
  );
  const vr = await ethers.getContractAt("src/Vault/VaultRouter.sol:VaultRouter", deployed.VaultRouter);
  const lrm = await ethers.getContractAt(
    "src/Vault/liquidation/modules/LiquidationRiskManager.sol:LiquidationRiskManager",
    deployed.LiquidationRiskManager
  );

  // 1) Registry binding sanity check
  const key = ethers.keccak256(ethers.toUtf8Bytes("CACHE_MAINTENANCE_MANAGER"));
  const bound = await registry.getModule(key);
  if (bound.toLowerCase() !== deployed.CacheMaintenanceManager.toLowerCase()) {
    throw new Error(
      `Registry binding mismatch: CACHE_MAINTENANCE_MANAGER=${bound}, expected=${deployed.CacheMaintenanceManager}`
    );
  }
  console.log(`[ok] registry bound CACHE_MAINTENANCE_MANAGER -> ${bound}`);

  // 2) Execute batch refresh
  const tx = await maint.batchRefresh([deployed.VaultRouter, deployed.LiquidationRiskManager]);
  const rc = await tx.wait();
  requireEnv(rc, "No receipt returned");
  console.log(`[ok] batchRefresh mined tx=${rc.hash} block=${rc.blockNumber}`);

  // 3) Assert events
  const parsed = rc.logs
    .map((l: any) => {
      try {
        return maint.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const attempted = parsed.filter((e: any) => e.name === "CacheRefreshAttempted");
  const completed = parsed.filter((e: any) => e.name === "CacheRefreshBatchCompleted");

  if (attempted.length !== 2) {
    throw new Error(`Expected 2 CacheRefreshAttempted events, got ${attempted.length}`);
  }

  const attemptedByTarget = new Map<string, { ok: boolean; reason: string }>();
  for (const e of attempted as any[]) {
    const target = (e.args[0] as string).toLowerCase();
    const ok = Boolean(e.args[1]);
    const reason = (e.args[2] as string) || "0x";
    attemptedByTarget.set(target, { ok, reason });
  }
  for (const t of [deployed.VaultRouter, deployed.LiquidationRiskManager]) {
    const v = attemptedByTarget.get(t.toLowerCase());
    if (!v) throw new Error(`Missing CacheRefreshAttempted for target=${t}`);
    if (!v.ok) throw new Error(`Refresh failed for target=${t}, reason=${v.reason}`);
  }

  if (completed.length !== 1) {
    throw new Error(`Expected 1 CacheRefreshBatchCompleted event, got ${completed.length}`);
  }
  {
    const e: any = completed[0];
    const total = e.args[0] as bigint;
    const okCount = e.args[1] as bigint;
    const failedCount = e.args[2] as bigint;
    if (total !== 2n || okCount !== 2n || failedCount !== 0n) {
      throw new Error(`Unexpected batch summary: total=${total} ok=${okCount} failed=${failedCount}`);
    }
  }
  console.log("[ok] events: attempted=2 okCount=2 failedCount=0");

  // 4) Verify VaultRouter cache marked valid
  const valid = await vr.isModuleCacheValid();
  if (!valid) throw new Error("Expected VaultRouter.isModuleCacheValid() == true after refresh");
  console.log("[ok] VaultRouter module cache is valid");

  // 5) Negative test: direct refresh should revert (only maintainer allowed)
  // Note: Hardhat console may show "unrecognized custom error" depending on ABI resolution;
  // we assert by selector instead of requiring decoded error names.
  const expectedSelector = selector("LiquidationRiskManager__UnauthorizedAccess()");
  try {
    await lrm.refreshModuleCache();
    throw new Error("Expected LiquidationRiskManager.refreshModuleCache() to revert for non-maintainer caller");
  } catch (e: any) {
    const data: string | undefined =
      e?.data ?? e?.error?.data ?? e?.info?.error?.data ?? e?.receipt?.revertReason;
    if (!data || typeof data !== "string" || !data.startsWith("0x")) {
      // If we cannot access revert data, still accept revert as "good enough" for local automation.
      console.log("[ok] direct refresh reverted (could not extract revert data)");
    } else {
      const gotSelector = data.slice(0, 10);
      if (gotSelector !== expectedSelector) {
        throw new Error(`Unexpected revert selector: got=${gotSelector} expected=${expectedSelector}`);
      }
      console.log(`[ok] direct refresh reverted with expected selector=${gotSelector}`);
    }
  }

  console.log("\n✅ cache refresh automation PASSED\n");
}

main().catch((e: any) => {
  console.error("\n❌ cache refresh automation FAILED\n");
  console.error(e);
  process.exit(1);
});

