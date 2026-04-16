import { ethers, network } from "hardhat";
import { configureDynamicEip1559Fees } from "../../../../../utils/eip1559-fees";

import { loadAddressMap, resolveAddress } from "../../../../_addressResolver";
import {
  ensureRoleForAccount,
  getReadCaller,
  key,
  loadMockAssetPack,
  requireCode,
  resolveBnbMinGasPriceWei,
} from "./_mockLiveUtils";

type PrimeOptions = {
  label: string;
};

type PrimeTarget = {
  asset: string;
  label: string;
};

// ViewCache 里的 utilization 约定为 WAD 精度的 debt / collateral。
function calcUtilizationWad(totalCollateral: bigint, totalDebt: bigint) {
  if (totalCollateral === 0n) return 0n;
  return (totalDebt * 10n ** 18n) / totalCollateral;
}

async function sleep(ms: number) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// 对单个资产腿执行 prime：
// 先读取真实聚合值，再写入 ViewCache，最后回读校验写入结果一致。
async function primeAssetStatus(
  target: PrimeTarget,
  contracts: {
    collateralManager: any;
    lendingEngine: any;
    viewCache: any;
  },
) {
  const totalCollateral = (await contracts.collateralManager.getTotalCollateralByAsset(
    target.asset,
  )) as bigint;
  const totalDebt = (await contracts.lendingEngine.getTotalDebtByAsset(
    target.asset,
  )) as bigint;
  const utilizationRate = calcUtilizationWad(totalCollateral, totalDebt);

  const maxWriteAttempts = 3;
  const pollAttemptsPerWrite = 6;
  const pollDelayMs = 1200;
  let lastTxHash = "";

  for (let writeAttempt = 1; writeAttempt <= maxWriteAttempts; writeAttempt += 1) {
    const feeOverrides =
      network.name === "bnbTestnet"
        ? {
          maxFeePerGas: resolveBnbMinGasPriceWei(),
          maxPriorityFeePerGas: resolveBnbMinGasPriceWei(),
        }
        : {};
    const tx = await contracts.viewCache.setSystemStatus(
      target.asset,
      totalCollateral,
      totalDebt,
      utilizationRate,
      feeOverrides,
    );
    const receipt = await tx.wait();
    lastTxHash = String(receipt?.hash ?? tx.hash ?? "");

    for (let pollAttempt = 1; pollAttempt <= pollAttemptsPerWrite; pollAttempt += 1) {
      const [status, valid] = (await contracts.viewCache.getSystemStatus(
        target.asset,
      )) as [any, boolean];

      const cachedCollateral = BigInt(status.totalCollateral ?? status[0] ?? 0);
      const cachedDebt = BigInt(status.totalDebt ?? status[1] ?? 0);
      const cachedUtilization = BigInt(status.utilizationRate ?? status[2] ?? 0);

      const converged =
        Boolean(valid)
        && cachedCollateral === totalCollateral
        && cachedDebt === totalDebt
        && cachedUtilization === utilizationRate;

      if (converged) {
        console.log(
          `  primed ${target.label}: tx=${lastTxHash} totalCollateral=${totalCollateral.toString()} totalDebt=${totalDebt.toString()} utilizationWad=${utilizationRate.toString()} (write=${writeAttempt}/${maxWriteAttempts} poll=${pollAttempt}/${pollAttemptsPerWrite})`,
        );
        return;
      }

      if (pollAttempt < pollAttemptsPerWrite) {
        await sleep(pollDelayMs);
      }
    }
  }

  throw new Error(
    `${target.label} ViewCache status did not converge after prime retries (tx=${lastTxHash || "n/a"})`,
  );
}

// 公开入口：把当前选中的 borrow / collateral 两条资产腿的系统缓存都写热。
export async function primeMockLiveViewCache(options: PrimeOptions) {
  await configureDynamicEip1559Fees({
    ethers,
    networkName: network.name,
    label: options.label,
  });
  const addressMap = loadAddressMap(network.name, { preferMockSuite: true });
  const registryAddr = resolveAddress({
    name: "Registry",
    map: addressMap,
    envVar: "REGISTRY_ADDRESS",
  });
  const pair = loadMockAssetPack();
  const [writer] = await ethers.getSigners();
  const viewerActor = getReadCaller("viewer", "VIEWER_ADDRESS", writer);

  const registry = (await ethers.getContractAt(
    [
      "function getModuleOrRevert(bytes32) view returns (address)",
    ],
    registryAddr,
  )) as any;

  const acmAddr = (await registry.getModuleOrRevert(
    key("ACCESS_CONTROL_MANAGER"),
  )) as string;
  const collateralManagerAddr = (await registry.getModuleOrRevert(
    key("COLLATERAL_MANAGER"),
  )) as string;
  const lendingEngineAddr = (await registry.getModuleOrRevert(
    key("LENDING_ENGINE"),
  )) as string;
  const viewCacheAddr = (await registry.getModuleOrRevert(
    key("VIEW_CACHE"),
  )) as string;

  await Promise.all([
    requireCode(registryAddr, "Registry"),
    requireCode(acmAddr, "AccessControlManager"),
    requireCode(collateralManagerAddr, "CollateralManager"),
    requireCode(lendingEngineAddr, "VaultLendingEngine"),
    requireCode(viewCacheAddr, "ViewCache"),
  ]);

  const acm = (await ethers.getContractAt(
    [
      "function owner() view returns (address)",
      "function hasRole(bytes32 role,address account) view returns (bool)",
      "function grantRole(bytes32 role,address account)",
    ],
    acmAddr,
  )) as any;
  const autoGrantRuntimeRoles = true;
  const acmOwner = (await acm.owner()) as string;
  // ViewCache 写入受 VIEW_SYSTEM_DATA 权限控制，没权限就提前失败，避免半程才报错。
  const writerHasRole = await ensureRoleForAccount({
    acm,
    roleName: "VIEW_SYSTEM_DATA",
    account: writer.address,
    granter: writer,
    ownerAddress: acmOwner,
    autoGrant: autoGrantRuntimeRoles,
    label: `writer ${writer.address}`,
  });
  if (!writerHasRole) {
    throw new Error(
      `writer ${writer.address} lacks VIEW_SYSTEM_DATA, cannot prime ViewCache`,
    );
  }

  const collateralManager = (await ethers.getContractAt(
    ["function getTotalCollateralByAsset(address asset) view returns (uint256)"],
    collateralManagerAddr,
  )) as any;
  const lendingEngine = (await ethers.getContractAt(
    ["function getTotalDebtByAsset(address asset) view returns (uint256)"],
    lendingEngineAddr,
  )) as any;
  const viewCache = (await ethers.getContractAt(
    [
      "function setSystemStatus(address asset,uint256 totalCollateral,uint256 totalDebt,uint256 utilizationRate)",
      "function getSystemStatus(address asset) view returns (tuple(uint256 totalCollateral,uint256 totalDebt,uint256 utilizationRate,uint256 updateBlock,bool isValid),bool)",
    ],
    viewCacheAddr,
    writer,
  )) as any;

  console.log(`=== ${options.label} (${network.name}) ===`);
  console.log(`Registry=${registryAddr}`);
  console.log(`Writer=${writer.address}`);
  console.log(`Viewer=${viewerActor.signer.address}`);
  console.log(`ViewCache=${viewCacheAddr}`);

  await primeAssetStatus(
    {
      asset: pair.borrowAsset.address,
      label: `borrowAsset:${pair.borrowAsset.symbol}`,
    },
    { collateralManager, lendingEngine, viewCache },
  );
  await primeAssetStatus(
    {
      asset: pair.collateralAsset.address,
      label: `collateral:${pair.collateralAsset.symbol}`,
    },
    { collateralManager, lendingEngine, viewCache },
  );

  console.log("\n✅ ViewCache prime completed\n");
}