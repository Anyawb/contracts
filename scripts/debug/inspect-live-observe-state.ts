import { ethers, network } from "hardhat";

import { envStr, loadAddressMap, resolveAddress } from "../tests/_addressResolver";
import { getActorSigner, getReadCaller, key, loadMockAssetPack } from "../tests/live-test/networks/arbitrum-sepolia/core/_mockLiveUtils";

async function step<T>(label: string, run: () => Promise<T>) {
  try {
    const value = await run();
    console.log(`[ok] ${label}`, value);
  } catch (error: any) {
    console.log(`[fail] ${label}`, error?.shortMessage ?? error?.message ?? String(error));
    throw error;
  }
}

async function main() {
  const addressMap = loadAddressMap(network.name, { preferMockSuite: true });
  const registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });
  const pair = loadMockAssetPack();
  const [relayer] = await ethers.getSigners();
  const viewer = getReadCaller("viewer", "VIEWER_ADDRESS", relayer).signer;
  const borrower = (await getActorSigner("borrower", "BORROWER_PRIVATE_KEY", relayer)).signer;
  const lender = (await getActorSigner("lender", "LENDER_PRIVATE_KEY", relayer)).signer;

  const registry = (await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    registryAddr,
  )) as any;
  const valuationViewAddr = (await registry.getModuleOrRevert(key("VALUATION_ORACLE_VIEW"))) as string;
  const viewCacheAddr = (await registry.getModuleOrRevert(key("VIEW_CACHE"))) as string;
  const rewardViewAddr = (await registry.getModuleOrRevert(key("REWARD_VIEW"))) as string;
  const healthViewAddr = (await registry.getModuleOrRevert(key("HEALTH_VIEW"))) as string;
  const positionViewAddr = (await registry.getModuleOrRevert(key("POSITION_VIEW"))) as string;

  const valuationView = (await ethers.getContractAt(
    ["function getAssetPrice(address asset) view returns (uint256,uint256,bool)"],
    valuationViewAddr,
  )) as any;
  const viewCache = (await ethers.getContractAt(
    ["function getSystemStatus(address asset) view returns ((uint256,uint256,uint256,uint256),bool)"],
    viewCacheAddr,
  )) as any;
  const rewardView = (await ethers.getContractAt(
    [
      "function getUserRewardSummaryWithMeta(address user) view returns (uint256,uint256,uint8,uint256,uint256,bool)",
      "function getUserEasyEarnedWithMeta(address user) view returns (uint256,uint256,bool)",
    ],
    rewardViewAddr,
  )) as any;
  const healthView = (await ethers.getContractAt(
    ["function getUserHealthFactorWithMeta(address user) view returns (uint256,bool,uint256)"],
    healthViewAddr,
  )) as any;
  const positionView = (await ethers.getContractAt(
    ["function getUserPositionWithBlockMeta(address user,address asset) view returns (uint256,uint256,bool,uint256,uint256,uint64)"],
    positionViewAddr,
  )) as any;

  console.log(`Registry=${registryAddr}`);
  console.log(`Borrower=${borrower.address}`);
  console.log(`Lender=${lender.address}`);
  console.log(`Viewer=${viewer.address}`);
  console.log(`BorrowAsset=${pair.borrowAsset.address}`);
  console.log(`CollateralAsset=${pair.collateralAsset.address}`);

  await step("valuation.borrow", () => valuationView.getAssetPrice(pair.borrowAsset.address));
  await step("valuation.collateral", () => valuationView.getAssetPrice(pair.collateralAsset.address));
  await step("viewCache.borrow", () => viewCache.getSystemStatus(pair.borrowAsset.address));
  await step("viewCache.collateral", () => viewCache.getSystemStatus(pair.collateralAsset.address));
  await step("reward.borrower.summary", () => rewardView.connect(borrower).getUserRewardSummaryWithMeta(borrower.address));
  await step("reward.borrower.easy", () => rewardView.connect(borrower).getUserEasyEarnedWithMeta(borrower.address));
  await step("reward.lender.summary", () => rewardView.connect(lender).getUserRewardSummaryWithMeta(lender.address));
  await step("reward.lender.easy", () => rewardView.connect(lender).getUserEasyEarnedWithMeta(lender.address));
  await step("health.borrower", () => healthView.connect(borrower).getUserHealthFactorWithMeta(borrower.address));
  await step("position.borrower.collateral", () => positionView.connect(borrower).getUserPositionWithBlockMeta(borrower.address, pair.collateralAsset.address));
  await step("position.borrower.debt", () => positionView.connect(borrower).getUserPositionWithBlockMeta(borrower.address, pair.borrowAsset.address));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});