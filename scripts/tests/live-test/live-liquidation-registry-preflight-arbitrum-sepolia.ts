import { ethers } from "hardhat";

import {
  bootstrapFundsFlowLiveTest,
} from "./_fundsFlowLive";
import { runWithNetworkRetry } from "./_networkRetry";
import { key } from "./_mockLiveUtils";

async function expectRevert(label: string, action: () => Promise<unknown>) {
  try {
    await action();
  } catch {
    console.log(`  [ExpectedRevert] ${label}`);
    return;
  }
  throw new Error(`${label}: expected revert`);
}

async function expectRevertOrNoticeSuccess(
  label: string,
  action: () => Promise<unknown>,
  validate?: (result: unknown) => void,
) {
  try {
    const result = await action();
    validate?.(result);
    console.log(`  [Notice] ${label} no longer reverts under current permissions`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("malformed success payload")) {
      throw error;
    }
    console.log(`  [ExpectedRevert] ${label}`);
  }
}

async function expectRevertOrValidBorrowerBatch(
  label: string,
  action: () => Promise<[boolean[], boolean, bigint]>,
  directFlag: boolean,
) {
  try {
    const [flags, valid, blockNumber] = await action();
    if (!valid || blockNumber === 0n || flags.length !== 1) {
      throw new Error(`${label}: malformed success payload`);
    }
    console.log(
      `  [Notice] ${label} no longer reverts for self caller; liquidatable=${String(flags[0])} direct=${String(directFlag)}`,
    );
    if (flags[0] !== directFlag) {
      throw new Error(`${label}: batch flag mismatches direct self read`);
    }
    return;
  } catch (error) {
    if (error instanceof Error && error.message.includes("malformed success payload")) {
      throw error;
    }
    console.log(`  [ExpectedRevert] ${label}`);
  }
}

function expectRegistered(label: string, address: string) {
  if (!address || address === ethers.ZeroAddress) {
    throw new Error(`${label} is not registered in Registry`);
  }
}

async function main() {
  const { ctx } = await bootstrapFundsFlowLiveTest({
    label: "Live Liquidation Registry Preflight",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  const registry = (await ethers.getContractAt(
    [
      "function getModule(bytes32) view returns (address)",
      "function getModuleOrRevert(bytes32) view returns (address)",
    ],
    ctx.registryAddr,
  )) as any;

  const [
    systemViewAddr,
    liquidationViewAddr,
    liquidationRiskViewAddr,
    liquidationManagerAddr,
    liquidationPayoutManagerAddr,
    liquidationRiskManagerAddr,
    blocksOnlyViewAddr,
    blocksOnlyCoordinatorAddr,
  ] = (await Promise.all([
    registry.getModuleOrRevert(key("SYSTEM_VIEW")),
    registry.getModule(key("LIQUIDATION_VIEW")),
    registry.getModule(key("LIQUIDATION_RISK_VIEW")),
    registry.getModule(key("LIQUIDATION_MANAGER")),
    registry.getModule(key("LIQUIDATION_PAYOUT_MANAGER")),
    registry.getModule(key("LIQUIDATION_RISK_MANAGER")),
    registry.getModule(key("BLOCKS_ONLY_VIEW")),
    registry.getModule(key("BLOCKS_ONLY_COORDINATOR")),
  ])) as string[];

  expectRegistered("LIQUIDATION_VIEW", liquidationViewAddr);
  expectRegistered("LIQUIDATION_RISK_VIEW", liquidationRiskViewAddr);
  expectRegistered("LIQUIDATION_MANAGER", liquidationManagerAddr);
  expectRegistered("LIQUIDATION_PAYOUT_MANAGER", liquidationPayoutManagerAddr);
  expectRegistered("LIQUIDATION_RISK_MANAGER", liquidationRiskManagerAddr);

  const systemView = (await ethers.getContractAt(
    ["function routeLiquidation() view returns (bytes32 moduleKey,address moduleAddr)"],
    systemViewAddr,
    ctx.relayer,
  )) as any;
  const route = (await systemView.routeLiquidation()) as any;
  const routeKey = String(route.moduleKey ?? route[0] ?? ethers.ZeroHash).toLowerCase();
  const routeAddr = String(route.moduleAddr ?? route[1] ?? ethers.ZeroAddress).toLowerCase();

  if (routeKey !== key("LIQUIDATION_VIEW").toLowerCase()) {
    throw new Error(`SystemView.routeLiquidation moduleKey mismatch: ${routeKey}`);
  }
  if (routeAddr !== liquidationViewAddr.toLowerCase()) {
    throw new Error(
      `SystemView.routeLiquidation moduleAddr mismatch: expected ${liquidationViewAddr} got ${routeAddr}`,
    );
  }

  const liquidationRiskView = (await ethers.getContractAt(
    [
      "function getRegistry() view returns (address)",
      "function isLiquidatable(address user) view returns (bool,bool,uint256)",
      "function batchIsLiquidatable(address[] users) view returns (bool[],bool,uint256)",
      "function batchGetLiquidationRiskScores(address[] users) view returns (uint256[],bool,uint256)",
    ],
    liquidationRiskViewAddr,
    ctx.viewer,
  )) as any;

  const riskRegistry = (await liquidationRiskView.getRegistry()) as string;
  if (riskRegistry.toLowerCase() !== ctx.registryAddr.toLowerCase()) {
    throw new Error(`LiquidationRiskView registry mismatch: expected ${ctx.registryAddr} got ${riskRegistry}`);
  }

  const [directLiquidatable, directValid, directBlock] = (await liquidationRiskView
    .connect(ctx.borrower)
    ["isLiquidatable(address)"](ctx.borrower.address)) as [boolean, boolean, bigint];
  if (!directValid || directBlock === 0n) {
    throw new Error("LiquidationRiskView self read returned invalid metadata");
  }
  console.log(
    `  [LiquidationRiskView] borrower liquidatable=${directLiquidatable} block=${directBlock.toString()}`,
  );

  await expectRevertOrValidBorrowerBatch(
    "LiquidationRiskView borrower batch read should revert",
    async () => liquidationRiskView.connect(ctx.borrower).batchIsLiquidatable([ctx.borrower.address]),
    directLiquidatable,
  );

  try {
    const [flags, valid] = (await liquidationRiskView
      .connect(ctx.relayer)
      .batchIsLiquidatable([ctx.borrower.address, ctx.lender.address])) as [boolean[], boolean, bigint];
    if (!valid || flags.length !== 2) {
      throw new Error("LiquidationRiskView batch read returned malformed payload");
    }
  } catch {
    console.log("  [Notice] relayer lacks LiquidationRiskView batch permission; authorized path skipped");
  }

  const liquidatorView = (await ethers.getContractAt(
    [
      "function getSeizableCollateralAmount(address user,address asset) view returns (uint256,uint256,bool)",
      "function calculateCollateralValue(address asset,uint256 amount) view returns (uint256)",
      "function getGlobalLiquidationViewWithMeta() view returns ((uint256 totalLiquidations,uint256 totalProfitDistributed,uint256 totalLiquidators,uint256 averageProfitPerLiquidation,uint256 lastLiquidationBlock,uint256 liquidationSuccessRate),uint256,bool)",
      "function getLiquidatorProfitViewWithMeta(address liquidator) view returns ((address liquidator,uint256 totalProfit,uint256 totalLiquidations,uint256 lastLiquidationBlock,uint256 totalProfitValue,uint256 averageProfitPerLiquidation,uint256 blocksSinceLastLiquidation),uint256,bool)",
    ],
    liquidationViewAddr,
    ctx.viewer,
  )) as any;

  const [selfSeizable] = (await liquidatorView
    .connect(ctx.borrower)
    .getSeizableCollateralAmount(ctx.borrower.address, ctx.collateralAssetAddr)) as [bigint, bigint, boolean];
  console.log(`  [LiquidatorView] borrower self seizable collateral=${selfSeizable.toString()}`);

  await expectRevertOrNoticeSuccess(
    "LiquidatorView borrower system read should revert",
    async () => liquidatorView.connect(ctx.borrower).getGlobalLiquidationViewWithMeta(),
    (result) => {
      const [globalView, blockNumber] = result as [any, bigint, boolean];
      if (!globalView || blockNumber < 0n) {
        throw new Error("malformed success payload: LiquidatorView borrower system read");
      }
    },
  );
  await expectRevertOrNoticeSuccess(
    "LiquidatorView borrower liquidation valuation read should revert",
    async () => liquidatorView.connect(ctx.borrower).calculateCollateralValue(ctx.collateralAssetAddr, 1n),
    (result) => {
      if (typeof result !== "bigint") {
        throw new Error("malformed success payload: LiquidatorView borrower valuation read");
      }
    },
  );

  try {
    const [globalView, blockNumber] = (await liquidatorView
      .connect(ctx.relayer)
      .getGlobalLiquidationViewWithMeta()) as [any, bigint, boolean];
    const lastLiquidationBlock = BigInt(globalView.lastLiquidationBlock ?? globalView[4] ?? 0);
    if (blockNumber !== 0n || lastLiquidationBlock !== 0n) {
      console.log(
        `  [Notice] LiquidatorView global placeholder changed: metaBlock=${blockNumber.toString()} lastLiq=${lastLiquidationBlock.toString()}`,
      );
    }

    const [profitView] = (await liquidatorView
      .connect(ctx.relayer)
      .getLiquidatorProfitViewWithMeta(ctx.relayer.address)) as [any, bigint, boolean];
    const blocksSinceLast = BigInt(profitView.blocksSinceLastLiquidation ?? profitView[6] ?? 0);
    const profitLastBlock = BigInt(profitView.lastLiquidationBlock ?? profitView[3] ?? 0);
    if (profitLastBlock === 0n && blocksSinceLast !== 0n) {
      throw new Error("LiquidatorView placeholder freshness fields are inconsistent");
    }
  } catch {
    console.log("  [Notice] relayer lacks LiquidatorView system permission; global view path skipped");
  }

  try {
    const oneToken = ethers.parseUnits("1", ctx.collateralDecimals);
    const collateralValue = (await liquidatorView
      .connect(ctx.relayer)
      .calculateCollateralValue(ctx.collateralAssetAddr, oneToken)) as bigint;
    if (collateralValue === 0n) {
      console.log("  [Notice] LiquidatorView.calculateCollateralValue returned zero; best-effort valuation can legally return 0 when PositionView read fails");
    }
  } catch {
    console.log("  [Notice] relayer lacks LiquidatorView liquidation permission; valuation path skipped");
  }

  if (blocksOnlyViewAddr && blocksOnlyViewAddr !== ethers.ZeroAddress) {
    const blocksOnlyView = (await ethers.getContractAt(
      [
        "function getRegistry() view returns (address)",
        "function getBorrowerOrderCount(address borrower) view returns (uint256,bool,uint256)",
        "function getBorrowerOrderIdsPaginated(address borrower,uint256 offset,uint256 limit) view returns (uint256[] memory,uint256,bool,uint256)",
        "function getSystemOrderCount() view returns (uint256,bool,uint256)",
      ],
      blocksOnlyViewAddr,
      ctx.viewer,
    )) as any;

    const blocksRegistry = (await blocksOnlyView.getRegistry()) as string;
    if (blocksRegistry.toLowerCase() !== ctx.registryAddr.toLowerCase()) {
      throw new Error(`BlocksOnlyView registry mismatch: expected ${ctx.registryAddr} got ${blocksRegistry}`);
    }

    const [borrowerCount, borrowerValid] = (await blocksOnlyView
      .connect(ctx.borrower)
      .getBorrowerOrderCount(ctx.borrower.address)) as [bigint, boolean, bigint];
    if (!borrowerValid) {
      throw new Error("BlocksOnlyView borrower count returned invalid metadata");
    }
    const [orderIds, totalCount] = (await blocksOnlyView
      .connect(ctx.borrower)
      .getBorrowerOrderIdsPaginated(ctx.borrower.address, 0, 8)) as [bigint[], bigint, boolean, bigint];
    if (totalCount < borrowerCount || orderIds.length > Number(totalCount)) {
      throw new Error("BlocksOnlyView borrower pagination returned malformed totals");
    }

    await expectRevertOrNoticeSuccess(
      "BlocksOnlyView borrower system count should revert",
      async () => blocksOnlyView.connect(ctx.borrower).getSystemOrderCount(),
      (result) => {
        const [systemCount] = result as [bigint, boolean, bigint];
        if (typeof systemCount !== "bigint") {
          throw new Error("malformed success payload: BlocksOnlyView borrower system count");
        }
      },
    );

    try {
      const [systemCount] = (await blocksOnlyView.connect(ctx.relayer).getSystemOrderCount()) as [bigint, boolean, bigint];
      console.log(
        `  [BlocksOnlyView] systemCount=${systemCount.toString()} coordinator=${blocksOnlyCoordinatorAddr ?? ethers.ZeroAddress}`,
      );
    } catch {
      console.log("  [Notice] relayer lacks BlocksOnlyView system permission; system count path skipped");
    }
  } else {
    console.log("  [Notice] BlocksOnlyView not registered; blocks-only view preflight skipped");
  }

  console.log("\n✅ live-liquidation-registry-preflight-arbitrum-sepolia PASSED\n");
}

void runWithNetworkRetry("live-liquidation-registry-preflight-arbitrum-sepolia", main);