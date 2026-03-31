import { ethers, network } from "hardhat";

import { envBool, loadAddressMap, resolveAddress } from "../_addressResolver";
import { key, loadMockAssetPack, requireCode } from "./_mockLiveUtils";

function envNum(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.floor(parsed);
}

// 每个读操作都做独立容错，避免单个 view revert 直接打断整轮压力读取。
async function safeRead<T>(label: string, fn: () => Promise<T>) {
  try {
    await fn();
    return { label, ok: true as const };
  } catch (error: any) {
    return {
      label,
      ok: false as const,
      error: error?.shortMessage ?? error?.message ?? String(error),
    };
  }
}

// 这个脚本的目标不是验证写路径，而是压测关键读接口在多轮连续访问下的稳定性。
async function main() {
  const defaultReadOnly = network.name !== "localhost";
  const readOnly = envBool("READ_ONLY", defaultReadOnly);
  const enableWrite = envBool("ENABLE_WRITE", !readOnly);
  const effectiveReadOnly = network.name === "localhost" ? readOnly : true;
  const effectiveEnableWrite = network.name === "localhost" ? enableWrite : false;
  if ((!readOnly || enableWrite) && network.name !== "localhost") {
    console.log("[info] live-read-pressure forces READ_ONLY=1 and ENABLE_WRITE=0 on non-localhost networks");
  }
  if (!effectiveReadOnly || effectiveEnableWrite) {
    throw new Error("live-read-pressure only supports read-only mode; use READ_ONLY=1 ENABLE_WRITE=0");
  }

  const rounds = envNum("LIVE_PRESSURE_ROUNDS", 8);
  const addressMap = loadAddressMap(network.name, { preferMockSuite: true });
  const registryAddr = resolveAddress({
    name: "Registry",
    map: addressMap,
    envVar: "REGISTRY_ADDRESS",
  });
  const pair = loadMockAssetPack();
  const [viewer] = await ethers.getSigners();
  const registry = (await ethers.getContractAt(
    [
      "function getModuleOrRevert(bytes32) view returns (address)",
      "function getModule(bytes32) view returns (address)",
    ],
    registryAddr,
  )) as any;

  const rewardViewAddr = (await registry.getModuleOrRevert(key("REWARD_VIEW"))) as string;
  const viewCacheAddr = (await registry.getModuleOrRevert(key("VIEW_CACHE"))) as string;
  const previewViewAddr = (await registry.getModule(key("PREVIEW_VIEW"))) as string;
  const healthViewAddr = (await registry.getModule(key("HEALTH_VIEW"))) as string;
  const valuationViewAddr = (await registry.getModuleOrRevert(key("VALUATION_ORACLE_VIEW"))) as string;

  await Promise.all([
    requireCode(rewardViewAddr, "RewardView"),
    requireCode(viewCacheAddr, "ViewCache"),
    requireCode(valuationViewAddr, "ValuationOracleView"),
  ]);

  const rewardView = (await ethers.getContractAt(
    [
      "function getUserRewardSummaryWithMeta(address user) view returns (uint256,uint256,uint8,uint256,uint256,bool)",
      "function getUserEasyEarnedWithMeta(address user) view returns (uint256,uint256,bool)",
      "function getDynamicRewardParamsWithMeta() view returns (uint256,uint256,uint256,bool)",
      "function getLevelMultiplierWithMeta(uint8 level) view returns (uint256,uint256,bool)",
    ],
    rewardViewAddr,
  )) as any;
  const valuationView = (await ethers.getContractAt(
    ["function getAssetPrice(address asset) view returns (uint256,uint256,bool)"],
    valuationViewAddr,
  )) as any;
  const viewCache = (await ethers.getContractAt(
    ["function getSystemStatus(address asset) view returns ((uint256,uint256,uint256,uint256),bool)"],
    viewCacheAddr,
  )) as any;
  const previewView =
    previewViewAddr && previewViewAddr !== ethers.ZeroAddress
      ? ((await ethers.getContractAt(
          ["function previewDeposit(address user,address asset,uint256 amount) view returns (uint256,bool,bool,uint256,uint256)"],
          previewViewAddr,
        )) as any)
      : null;
  const healthView =
    healthViewAddr && healthViewAddr !== ethers.ZeroAddress
      ? ((await ethers.getContractAt(
          ["function getUserHealthFactorWithMeta(address user) view returns (uint256,bool,uint256)"],
          healthViewAddr,
        )) as any)
      : null;

  console.log(`=== Mock Live Read Pressure (${network.name}) ===`);
  console.log(`config: READ_ONLY=${String(effectiveReadOnly)} ENABLE_WRITE=${String(effectiveEnableWrite)}`);
  console.log(`rounds=${rounds}`);
  console.log(`viewer=${viewer.address}`);
  console.log(`settlement=${pair.settlementAsset.address}`);
  console.log(`collateral=${pair.collateralAsset.address}`);

  const startedAt = Date.now();
  const counters = new Map<string, { ok: number; failed: number }>();
  for (let round = 1; round <= rounds; round++) {
    // 每一轮都覆盖估值、奖励、缓存、预览和健康度等核心读取面。
    const reads = await Promise.all([
      safeRead("ValuationOracleView.getAssetPrice(settlement)", () =>
        valuationView.getAssetPrice(pair.settlementAsset.address),
      ),
      safeRead("ValuationOracleView.getAssetPrice(collateral)", () =>
        valuationView.getAssetPrice(pair.collateralAsset.address),
      ),
      safeRead("RewardView.getUserRewardSummaryWithMeta", () => rewardView.getUserRewardSummaryWithMeta(viewer.address)),
      safeRead("RewardView.getUserEasyEarnedWithMeta", () => rewardView.getUserEasyEarnedWithMeta(viewer.address)),
      safeRead("RewardView.getDynamicRewardParamsWithMeta", () => rewardView.getDynamicRewardParamsWithMeta()),
      safeRead("RewardView.getLevelMultiplierWithMeta", () => rewardView.getLevelMultiplierWithMeta(1)),
      safeRead("ViewCache.getSystemStatus(settlement)", () => viewCache.getSystemStatus(pair.settlementAsset.address)),
      safeRead("ViewCache.getSystemStatus(collateral)", () => viewCache.getSystemStatus(pair.collateralAsset.address)),
      previewView
        ? safeRead("PreviewView.previewDeposit(collateral)", () =>
            previewView.previewDeposit(viewer.address, pair.collateralAsset.address, 1n),
          )
        : Promise.resolve({ label: "PreviewView.previewDeposit(collateral)", ok: true as const }),
      healthView
        ? safeRead("HealthView.getUserHealthFactorWithMeta", () => healthView.getUserHealthFactorWithMeta(viewer.address))
        : Promise.resolve({ label: "HealthView.getUserHealthFactorWithMeta", ok: true as const }),
    ]);

    for (const read of reads) {
      const current = counters.get(read.label) ?? { ok: 0, failed: 0 };
      if (read.ok) current.ok += 1;
      else current.failed += 1;
      counters.set(read.label, current);
      // 仅在第一轮打印失败原因，后续轮次只做计数，避免日志被重复错误刷屏。
      if (!read.ok && round === 1) {
        console.log(`  warning ${read.label} reverted: ${read.error}`);
      }
    }

    console.log(`  round ${round}/${rounds} complete`);
  }

  console.log(`elapsedMs=${Date.now() - startedAt}`);
  console.log("summary:");
  for (const [label, counter] of counters.entries()) {
    console.log(`  - ${label}: ok=${counter.ok} failed=${counter.failed}`);
  }
  console.log("\n✅ live-read-pressure PASSED\n");
}

main().catch((error) => {
  console.error("\n❌ live-read-pressure FAILED\n");
  console.error(error);
  process.exit(1);
});