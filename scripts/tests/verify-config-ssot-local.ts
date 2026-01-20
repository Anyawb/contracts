/**
 * Local acceptance: verify Option-B threshold SSOT wiring.
 *
 * What it checks:
 * 1) Registry binds KEY_LIQUIDATION_CONFIG_MANAGER -> LiquidationConfigModule
 * 2) RiskManager reads thresholds from ConfigModule (SSOT) and stays consistent after updates.
 *
 * Usage:
 * - pnpm -s hardhat run scripts/tests/verify-config-ssot-local.ts --network localhost
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

function loadDeployments(): DeployMap {
  const p = path.join(__dirname, "..", "deployments", "localhost.json");
  const raw = readFileSync(p, "utf8");
  return JSON.parse(raw) as DeployMap;
}

function keyOf(upperSnake: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(upperSnake));
}

function pickNewThreshold(cur: bigint): bigint {
  // Must satisfy LiquidationTypes.isValidLiquidationThreshold: [10000, 15000]
  const min = 10_000n;
  const max = 15_000n;
  let next = cur + 100n;
  if (next < min) next = min;
  if (next > max) next = 11_000n;
  if (next === cur) next = cur + 1n;
  if (next < min || next > max) {
    throw new Error(`Cannot pick a valid new threshold from cur=${cur}`);
  }
  return next;
}

async function main() {
  console.log(`[verify-config-ssot-local] network=${network.name}`);
  requireEnv(network.name === "localhost", "This script must run with --network localhost");

  const deployed = loadDeployments();
  requireEnv(deployed.Registry, "Missing Registry in scripts/deployments/localhost.json");
  requireEnv(deployed.LiquidationRiskManager, "Missing LiquidationRiskManager in scripts/deployments/localhost.json");
  requireEnv(deployed.LiquidationConfigModule, "Missing LiquidationConfigModule in scripts/deployments/localhost.json");

  const registry = await ethers.getContractAt("Registry", deployed.Registry);
  const lrm = await ethers.getContractAt(
    "src/Vault/liquidation/modules/LiquidationRiskManager.sol:LiquidationRiskManager",
    deployed.LiquidationRiskManager
  );
  const cfg = await ethers.getContractAt(
    "src/Vault/liquidation/modules/LiquidationConfigModule.sol:LiquidationConfigModule",
    deployed.LiquidationConfigModule
  );

  // 1) Registry binding sanity check
  const cfgKey = keyOf("LIQUIDATION_CONFIG_MANAGER");
  const boundCfg = await registry.getModule(cfgKey);
  if (boundCfg.toLowerCase() !== deployed.LiquidationConfigModule.toLowerCase()) {
    throw new Error(
      `Registry binding mismatch: LIQUIDATION_CONFIG_MANAGER=${boundCfg}, expected=${deployed.LiquidationConfigModule}`
    );
  }
  console.log(`[ok] registry bound LIQUIDATION_CONFIG_MANAGER -> ${boundCfg}`);

  // 2) Read-path SSOT check (LRM getters should reflect ConfigModule)
  const [tCfg0, mCfg0] = await Promise.all([cfg.getLiquidationThreshold(), cfg.getMinHealthFactor()]);
  const [tRm0, mRm0] = await Promise.all([lrm.getLiquidationThreshold(), lrm.getMinHealthFactor()]);

  if (tRm0 !== tCfg0) {
    throw new Error(`SSOT read mismatch: LRM.threshold=${tRm0} Config.threshold=${tCfg0}`);
  }
  if (mRm0 !== mCfg0) {
    throw new Error(`SSOT read mismatch: LRM.minHF=${mRm0} Config.minHF=${mCfg0}`);
  }
  console.log(`[ok] read SSOT: threshold=${tRm0} minHF=${mRm0}`);

  // 3) Write-path acceptance: updating via LRM should update ConfigModule (not just mirror vars).
  //    NOTE: caller must have ActionKeys.ACTION_SET_PARAMETER role in ACM.
  const newThreshold = pickNewThreshold(tRm0);
  const newMinHf = newThreshold + 500n; // keep >= threshold

  console.log(`[tx] lrm.updateLiquidationThreshold(${newThreshold})`);
  const tx1 = await lrm.updateLiquidationThreshold(newThreshold);
  await tx1.wait();

  const [tCfg1, tRm1] = await Promise.all([cfg.getLiquidationThreshold(), lrm.getLiquidationThreshold()]);
  if (tCfg1 !== newThreshold || tRm1 !== newThreshold) {
    throw new Error(`Update threshold failed: cfg=${tCfg1} lrm=${tRm1} expected=${newThreshold}`);
  }
  console.log(`[ok] update threshold propagated: ${newThreshold}`);

  console.log(`[tx] lrm.updateMinHealthFactor(${newMinHf})`);
  const tx2 = await lrm.updateMinHealthFactor(newMinHf);
  await tx2.wait();

  const [mCfg2, mRm2] = await Promise.all([cfg.getMinHealthFactor(), lrm.getMinHealthFactor()]);
  if (mCfg2 !== newMinHf || mRm2 !== newMinHf) {
    throw new Error(`Update minHF failed: cfg=${mCfg2} lrm=${mRm2} expected=${newMinHf}`);
  }
  console.log(`[ok] update minHF propagated: ${newMinHf}`);

  console.log("\n✅ verify-config-ssot-local PASSED\n");
}

main().catch((e: any) => {
  console.error("\n❌ verify-config-ssot-local FAILED\n");
  console.error(e);
  process.exit(1);
});

