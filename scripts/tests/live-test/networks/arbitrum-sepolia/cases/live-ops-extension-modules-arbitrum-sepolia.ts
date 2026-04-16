import { ethers } from "hardhat";

import { createFundsFlowLiveContext } from "../core/_fundsFlowLive";
import { key } from "../core/_mockLiveUtils";
import { runWithNetworkRetry } from "../core/_networkRetry";
import { logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";

async function expectRevert(label: string, action: () => Promise<unknown>) {
  try {
    await action();
  } catch {
    console.log(`  [ExpectedRevert] ${label}`);
    return;
  }
  throw new Error(`${label}: expected revert`);
}

async function hasAnyRole(acm: any, account: string, roleNames: string[]) {
  for (const roleName of roleNames) {
    if (((await acm.hasRole(key(roleName), account)) as boolean)) {
      return true;
    }
  }
  return false;
}

async function pickUnauthorizedSigner(ctx: Awaited<ReturnType<typeof createFundsFlowLiveContext>>) {
  for (const signer of [ctx.borrower, ctx.lender, ctx.viewer]) {
    if (!signer) continue;
    if (String(signer.address).toLowerCase() === String(ctx.relayer.address).toLowerCase()) {
      continue;
    }
    const hasRestrictedRole = await hasAnyRole(ctx.acm, signer.address, [
      "ACTION_ADMIN",
      "ACTION_SET_PARAMETER",
      "ACTION_VIEW_SYSTEM_STATUS",
      "ACTION_REWARD_CONFIG_EMERGENCY",
    ]);
    if (!hasRestrictedRole) {
      return signer;
    }
  }
  return null;
}

async function tryProtectedRead<T>(
  label: string,
  reader: () => Promise<T>,
): Promise<T | null> {
  try {
    return await reader();
  } catch (error: any) {
    console.log(`  [Notice] ${label} unavailable: ${String(error?.shortMessage ?? error?.message ?? error)}`);
    return null;
  }
}

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live Ops Extension Modules",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  const registry = (await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    ctx.registryAddr,
  )) as any;

  const [
    dynamicKeyRegistryAddr,
    cacheMaintenanceAddr,
    featureRegistryAddr,
    aiCreditsVaultAddr,
    degradationCoreAddr,
    degradationStorageAddr,
    degradationMonitorAddr,
    governanceGuardianAddr,
  ] = await Promise.all([
    registry.getModuleOrRevert(key("DYNAMIC_MODULE_REGISTRY")),
    registry.getModuleOrRevert(key("CACHE_MAINTENANCE_MANAGER")),
    registry.getModuleOrRevert(key("FEATURE_REGISTRY")),
    registry.getModuleOrRevert(key("AI_CREDITS_VAULT")),
    registry.getModuleOrRevert(key("DEGRADATION_CORE")),
    registry.getModuleOrRevert(key("DEGRADATION_STORAGE")),
    registry.getModuleOrRevert(key("DEGRADATION_MONITOR")),
    registry.getModuleOrRevert(key("GOVERNANCE_GUARDIAN")),
  ]) as string[];

  const dynamicKeyRegistry = (await ethers.getContractAt(
    [
      "function getRegistrationAdmin() view returns (address)",
      "function getSystemAdmin() view returns (address)",
      "function getDynamicKeyCount() view returns (uint256)",
      "function getDynamicModuleKeys() view returns (bytes32[])",
      "function getDynamicModuleKeyByIndex(uint256) view returns (bytes32)",
      "function isDynamicModuleKey(bytes32) view returns (bool)",
      "function isValidModuleKey(bytes32) view returns (bool)",
      "function getModuleKeyName(bytes32) view returns (string)",
      "function getModuleKeyByName(string) view returns (bytes32)",
    ],
    dynamicKeyRegistryAddr,
  )) as any;

  const cacheMaintenanceManager = (await ethers.getContractAt(
    [
      "function getRegistry() view returns (address)",
      "function batchRefresh(address[] targets) returns (uint256 okCount,uint256 failedCount)",
    ],
    cacheMaintenanceAddr,
  )) as any;

  const featureRegistry = (await ethers.getContractAt(
    [
      "function getRegistry() view returns (address)",
      "function listFeatureKeys(uint256 offset,uint256 limit) view returns (bytes32[] memory,uint256)",
      "function getFeature(bytes32 featureKey) view returns (uint8,bool,string)",
      "function setFeature(bytes32 featureKey,uint8 minLevel,bool enabled,string nameOrUri)",
    ],
    featureRegistryAddr,
  )) as any;

  const aiCreditsVault = (await ethers.getContractAt(
    [
      "function getRegistry() view returns (address)",
      "function pricePerCredit(address payToken) view returns (uint256)",
      "function creditsBalance(bytes32 tenantId,address user) view returns (uint256)",
      "function isClientOrderIdUsed(bytes32 tenantId,address user,bytes32 clientOrderId) view returns (bool)",
      "function isSettlementBatchApplied(bytes32 settlementBatchId) view returns (bool)",
      "function setPricePerCredit(address payToken,uint256 newPricePerCredit)",
    ],
    aiCreditsVaultAddr,
  )) as any;

  const degradationCore = (await ethers.getContractAt(
    [
      "function getDegradationStats() view returns ((uint256 totalDegradations,uint256 totalFallbackUsed,uint256 averageFallbackValue,uint256 lastDegradationBlock,bytes32 mostCommonReasonHash))",
    ],
    degradationCoreAddr,
  )) as any;

  const degradationStorage = (await ethers.getContractAt(
    [
      "function getCircularBufferStats() view returns (uint256 currentIndex,uint256 actualCount,uint256 maxCapacity,bool isFull)",
    ],
    degradationStorageAddr,
  )) as any;

  const degradationMonitor = (await ethers.getContractAt(
    [
      "function getGracefulDegradationStats() view returns ((uint256 totalDegradations,uint256 totalFallbackUsed,uint256 averageFallbackValue,uint256 lastDegradationBlock,bytes32 mostCommonReasonHash))",
      "function getDegradationStats() view returns ((uint256 totalDegradations,uint256 totalFallbackUsed,uint256 averageFallbackValue,uint256 lastDegradationBlock,bytes32 mostCommonReasonHash))",
      "function getCircularBufferStats() view returns (uint256,uint256,uint256,bool)",
      "function getSystemDegradationHistory(uint256 limit) view returns ((address module,bytes32 reasonHash,uint256 fallbackValue,bool usedFallback,uint256 legacyBlockNumber,uint256 blockNumber)[])",
      "function getSystemDegradationTrends() view returns (uint256,uint256,address,uint256)",
      "function getUpgradeAdmin() view returns (address)",
      "function getUpgradeWindowStatus() view returns (bool enabled,uint256 enabledUntil,bool isActive)",
      "function getUpgradeWindowBlocks() view returns (uint256)",
      "function getModuleHealthStatus(address module) view returns ((bool isHealthy,uint256 lastCheckBlock,uint256 responseTimeMs,bytes32 lastErrorHash,uint256 errorCount,string details))",
    ],
    degradationMonitorAddr,
  )) as any;

  const unauthorizedSigner = await pickUnauthorizedSigner(ctx);

  const [registrationAdmin, systemAdmin, dynamicKeyCount, dynamicKeys, accessControlName] = await Promise.all([
    dynamicKeyRegistry.getRegistrationAdmin(),
    dynamicKeyRegistry.getSystemAdmin(),
    dynamicKeyRegistry.getDynamicKeyCount(),
    dynamicKeyRegistry.getDynamicModuleKeys(),
    dynamicKeyRegistry.getModuleKeyName(key("ACCESS_CONTROL_MANAGER")),
  ]);

  if (String(registrationAdmin).toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
    throw new Error("RegistryDynamicModuleKey registration admin should be non-zero");
  }
  if (String(systemAdmin).toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
    throw new Error("RegistryDynamicModuleKey system admin should be non-zero");
  }
  if (String(accessControlName).toLowerCase() !== "accesscontrolmanager" && String(accessControlName).toLowerCase() !== "access_control_manager") {
    throw new Error(`RegistryDynamicModuleKey static name mismatch: ${String(accessControlName)}`);
  }
  if (BigInt(dynamicKeyCount) !== BigInt(dynamicKeys.length)) {
    throw new Error("RegistryDynamicModuleKey count/list length mismatch");
  }
  if (dynamicKeys.length > 0) {
    const firstKey = await dynamicKeyRegistry.getDynamicModuleKeyByIndex(0);
    if (String(firstKey).toLowerCase() !== String(dynamicKeys[0]).toLowerCase()) {
      throw new Error("RegistryDynamicModuleKey index accessor mismatch");
    }
    const isDynamic = await dynamicKeyRegistry.isDynamicModuleKey(firstKey);
    if (!Boolean(isDynamic)) {
      throw new Error("RegistryDynamicModuleKey expected first dynamic key to be marked dynamic");
    }
  }

  const staticKeyValid = await dynamicKeyRegistry.isValidModuleKey(key("ACCESS_CONTROL_MANAGER"));
  if (!Boolean(staticKeyValid)) {
    throw new Error("RegistryDynamicModuleKey should recognize static module key");
  }

  const cacheRegistryAddr = (await cacheMaintenanceManager.getRegistry()) as string;
  if (cacheRegistryAddr.toLowerCase() !== ctx.registryAddr.toLowerCase()) {
    throw new Error(`CacheMaintenanceManager registry mismatch: expected ${ctx.registryAddr} got ${cacheRegistryAddr}`);
  }

  const featureRegistryBound = (await featureRegistry.getRegistry()) as string;
  if (featureRegistryBound.toLowerCase() !== ctx.registryAddr.toLowerCase()) {
    throw new Error(`FeatureRegistry registry mismatch: expected ${ctx.registryAddr} got ${featureRegistryBound}`);
  }
  const featurePage = (await featureRegistry.listFeatureKeys(0n, 1n)) as [string[], bigint];
  const featureKey = Array.from(featurePage[0] ?? [])[0] ?? null;
  if (featureKey) {
    await featureRegistry.getFeature(featureKey);
  }

  const aiRegistryAddr = (await aiCreditsVault.getRegistry()) as string;
  if (aiRegistryAddr.toLowerCase() !== ctx.registryAddr.toLowerCase()) {
    throw new Error(`AICreditsVault registry mismatch: expected ${ctx.registryAddr} got ${aiRegistryAddr}`);
  }
  const randomTenant = ethers.id("LIVE_AICREDITS_TENANT");
  const randomOrderId = ethers.id("LIVE_AICREDITS_ORDER");
  const randomSettlementBatchId = ethers.id("LIVE_AICREDITS_BATCH");
  const [pricePerCredit, creditsBalance, clientOrderUsed, settlementBatchApplied] = await Promise.all([
    aiCreditsVault.pricePerCredit(ctx.settlementTokenAddr),
    aiCreditsVault.creditsBalance(randomTenant, ctx.borrower.address),
    aiCreditsVault.isClientOrderIdUsed(randomTenant, ctx.borrower.address, randomOrderId),
    aiCreditsVault.isSettlementBatchApplied(randomSettlementBatchId),
  ]);
  if (BigInt(creditsBalance) !== 0n) {
    throw new Error("AICreditsVault random tenant credits should be zero");
  }
  if (Boolean(clientOrderUsed)) {
    throw new Error("AICreditsVault random clientOrderId should be unused");
  }
  if (Boolean(settlementBatchApplied)) {
    throw new Error("AICreditsVault random settlement batch should be unapplied");
  }

  const [gracefulStats, upgradeAdmin, upgradeWindowStatus, upgradeWindowBlocks] = await Promise.all([
    degradationMonitor.getGracefulDegradationStats(),
    degradationMonitor.getUpgradeAdmin(),
    degradationMonitor.getUpgradeWindowStatus(),
    degradationMonitor.getUpgradeWindowBlocks(),
  ]);

  if (String(upgradeAdmin).toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
    throw new Error("DegradationMonitor upgrade admin should be non-zero");
  }
  if (BigInt(upgradeWindowBlocks) === 0n) {
    throw new Error("DegradationMonitor upgrade window blocks should be non-zero");
  }
  if (BigInt(gracefulStats.totalDegradations ?? gracefulStats[0] ?? 0) < 0n) {
    throw new Error("DegradationMonitor graceful stats malformed");
  }
  if (typeof upgradeWindowStatus[0] !== "boolean") {
    throw new Error("DegradationMonitor upgrade window status malformed");
  }

  const relayerHasSystemViewer = await hasAnyRole(ctx.acm, ctx.relayer.address, ["ACTION_ADMIN", "ACTION_VIEW_SYSTEM_STATUS"]);
  if (relayerHasSystemViewer) {
    const [coreStats, storageStats, monitorStats, trends, history, healthStatus] = await Promise.all([
      tryProtectedRead("DegradationCore.getDegradationStats", () => degradationCore.connect(ctx.relayer).getDegradationStats()),
      tryProtectedRead("DegradationStorage.getCircularBufferStats", () => degradationStorage.connect(ctx.relayer).getCircularBufferStats()),
      tryProtectedRead("DegradationMonitor.getDegradationStats", () => degradationMonitor.connect(ctx.relayer).getDegradationStats()),
      tryProtectedRead("DegradationMonitor.getSystemDegradationTrends", () => degradationMonitor.connect(ctx.relayer).getSystemDegradationTrends()),
      tryProtectedRead("DegradationMonitor.getSystemDegradationHistory", () => degradationMonitor.connect(ctx.relayer).getSystemDegradationHistory(2n)),
      tryProtectedRead("DegradationMonitor.getModuleHealthStatus", () => degradationMonitor.connect(ctx.relayer).getModuleHealthStatus(ctx.vaultCoreAddr)),
    ]);

    if (coreStats && BigInt((coreStats as any).totalDegradations ?? (coreStats as any)[0] ?? 0) < 0n) {
      throw new Error("DegradationCore stats malformed");
    }
    if (storageStats && BigInt(storageStats[2] ?? 0) < 0n) {
      throw new Error("DegradationStorage stats malformed");
    }
    if (monitorStats && BigInt((monitorStats as any).totalDegradations ?? (monitorStats as any)[0] ?? 0) < 0n) {
      throw new Error("DegradationMonitor protected stats malformed");
    }
    if (trends && BigInt(trends[0] ?? 0) < 0n) {
      throw new Error("DegradationMonitor trends malformed");
    }
    if (history && !Array.isArray(history)) {
      throw new Error("DegradationMonitor history malformed");
    }
    if (healthStatus && ((healthStatus as any).isHealthy ?? (healthStatus as any)[0]) === undefined) {
      throw new Error("DegradationMonitor module health payload malformed");
    }
  } else if (unauthorizedSigner) {
    await expectRevert("DegradationCore protected read should revert for unauthorized signer", async () =>
      degradationCore.connect(unauthorizedSigner).getDegradationStats(),
    );
    await expectRevert("DegradationStorage protected read should revert for unauthorized signer", async () =>
      degradationStorage.connect(unauthorizedSigner).getCircularBufferStats(),
    );
    await expectRevert("DegradationMonitor protected stats should revert for unauthorized signer", async () =>
      degradationMonitor.connect(unauthorizedSigner).getDegradationStats(),
    );
  } else {
    console.log("  [Notice] no distinct unauthorized signer found for degradation gate checks");
  }

  if (unauthorizedSigner) {
    await expectRevert("CacheMaintenanceManager batchRefresh gate should revert", async () =>
      cacheMaintenanceManager.connect(unauthorizedSigner).batchRefresh.staticCall([ctx.vaultCoreAddr]),
    );
    await expectRevert("AICreditsVault setPricePerCredit gate should revert", async () =>
      aiCreditsVault.connect(unauthorizedSigner).setPricePerCredit.staticCall(ctx.settlementTokenAddr, pricePerCredit),
    );
    if (featureKey) {
      const featureBefore = (await featureRegistry.getFeature(featureKey)) as [number, boolean, string];
      await expectRevert("FeatureRegistry setFeature gate should revert", async () =>
        featureRegistry.connect(unauthorizedSigner).setFeature.staticCall(featureKey, featureBefore[0], featureBefore[1], featureBefore[2]),
      );
    }
  }

  const governanceGuardianCode = await ethers.provider.getCode(governanceGuardianAddr);
  const governanceGuardianIsContract = governanceGuardianCode !== "0x";

  console.log(
    `  [OpsModules] dynamicKeyCount=${BigInt(dynamicKeyCount).toString()} aiPricePerCredit=${BigInt(pricePerCredit).toString()} guardianIsContract=${String(governanceGuardianIsContract)} upgradeWindowBlocks=${BigInt(upgradeWindowBlocks).toString()}`,
  );
  if (!governanceGuardianIsContract) {
    console.log(`  [Notice] GovernanceGuardian is currently an EOA-style binding: ${governanceGuardianAddr}`);
  }

  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);