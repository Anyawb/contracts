import { ethers } from "hardhat";

import {
  bootstrapFundsFlowLiveTest,
  depositCollateral,
  expectEqual,
  finalizeSingleMatch,
  getOrderForView,
  observeExtendedViews,
  reserveForLending,
} from "../core/_fundsFlowLive";
import { runWithNetworkRetry } from "../core/_networkRetry";
import { key } from "../core/_mockLiveUtils";
import { logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";

function findAssetAmount(assets: string[], amounts: bigint[], asset: string) {
  const index = assets.findIndex((candidate) => candidate.toLowerCase() === asset.toLowerCase());
  return index >= 0 ? amounts[index] : 0n;
}

async function main() {
  const { ctx } = await bootstrapFundsFlowLiveTest({
    label: "Live Liquidation View Assertions",
    noticeLabel: "using fresh liquidation-view borrower",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
    withFreshBorrower: true,
    useDefaultActorFunding: true,
  });

  await depositCollateral(ctx, ctx.collateralAmount);
  const reserve = await reserveForLending(ctx);
  const finalized = await finalizeSingleMatch(ctx, reserve);
  const afterBorrow = await observeExtendedViews(ctx, "liquidation-view-assertions-after-borrow");

  const registry = (await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)", "function getModule(bytes32) view returns (address)"],
    ctx.registryAddr,
  )) as any;
  const liquidationViewAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_VIEW"))) as string;
  const liquidationRiskViewAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_RISK_VIEW"))) as string;
  const blocksOnlyViewAddr = (await registry.getModule(key("BLOCKS_ONLY_VIEW"))) as string;

  const liquidationRiskView = (await ethers.getContractAt(
    [
      "function isLiquidatable(address user) view returns (bool,bool,uint256)",
      "function getLiquidationRiskScore(address user) view returns (uint256,bool,uint256)",
      "function batchIsLiquidatable(address[] users) view returns (bool[],bool,uint256)",
      "function batchGetLiquidationRiskScores(address[] users) view returns (uint256[],bool,uint256)",
    ],
    liquidationRiskViewAddr,
    ctx.viewer,
  )) as any;

  const liquidatorView = (await ethers.getContractAt(
    [
      "function getSeizableCollateralAmount(address user,address asset) view returns (uint256,uint256,bool)",
      "function getSeizableCollaterals(address user) view returns (address[] memory,uint256[] memory,uint256,bool)",
      "function calculateCollateralValue(address asset,uint256 amount) view returns (uint256)",
      "function getGlobalLiquidationViewWithMeta() view returns ((uint256 totalLiquidations,uint256 totalProfitDistributed,uint256 totalLiquidators,uint256 averageProfitPerLiquidation,uint256 lastLiquidationBlock,uint256 liquidationSuccessRate),uint256,bool)",
      "function getLiquidatorProfitViewWithMeta(address liquidator) view returns ((address liquidator,uint256 totalProfit,uint256 totalLiquidations,uint256 lastLiquidationBlock,uint256 totalProfitValue,uint256 averageProfitPerLiquidation,uint256 blocksSinceLastLiquidation),uint256,bool)",
    ],
    liquidationViewAddr,
    ctx.viewer,
  )) as any;

  const [directLiquidatable, directValid, directBlock] = (await liquidationRiskView
    .connect(ctx.borrower)
    ["isLiquidatable(address)"](ctx.borrower.address)) as [boolean, boolean, bigint];
  if (!directValid || directBlock === 0n) {
    throw new Error("LiquidationRiskView direct user read returned invalid metadata");
  }

  const [riskScore, scoreValid, scoreBlock] = (await liquidationRiskView
    .connect(ctx.borrower)
    .getLiquidationRiskScore(ctx.borrower.address)) as [bigint, boolean, bigint];
  if (!scoreValid || scoreBlock === 0n) {
    throw new Error("LiquidationRiskView risk score returned invalid metadata");
  }
  if (riskScore > 100n) {
    throw new Error(`LiquidationRiskView riskScore out of range: ${riskScore.toString()}`);
  }

  const relayerHasViewUserData = (await ctx.acm.hasRole(key("VIEW_USER_DATA"), ctx.relayer.address)) as boolean;
  if (relayerHasViewUserData) {
    const [batchFlags, batchValid] = (await liquidationRiskView
      .connect(ctx.relayer)
      .batchIsLiquidatable([ctx.borrower.address])) as [boolean[], boolean, bigint];
    const [batchScores, batchScoresValid] = (await liquidationRiskView
      .connect(ctx.relayer)
      .batchGetLiquidationRiskScores([ctx.borrower.address])) as [bigint[], boolean, bigint];
    if (!batchValid || !batchScoresValid || batchFlags.length !== 1 || batchScores.length !== 1) {
      throw new Error("LiquidationRiskView batch reads returned malformed payloads");
    }
    if (batchFlags[0] !== directLiquidatable) {
      throw new Error("LiquidationRiskView batch liquidatable flag mismatches direct read");
    }
    expectEqual(batchScores[0], riskScore, "LiquidationRiskView batch score alignment");
  } else {
    console.log("  [Notice] relayer lacks VIEW_USER_DATA; LiquidationRiskView batch assertions skipped");
  }

  const [seizableAmount, seizableBlock, seizableValid] = (await liquidatorView
    .connect(ctx.borrower)
    .getSeizableCollateralAmount(ctx.borrower.address, ctx.collateralAssetAddr)) as [bigint, bigint, boolean];
  if (seizableBlock !== 0n || seizableValid) {
    console.log(
      `  [Notice] LiquidatorView seizable metadata changed: block=${seizableBlock.toString()} valid=${String(seizableValid)}`,
    );
  }
  expectEqual(seizableAmount, ctx.collateralAmount, "LiquidatorView seizable collateral amount");

  const [assets, amounts] = (await liquidatorView
    .connect(ctx.borrower)
    .getSeizableCollaterals(ctx.borrower.address)) as [string[], bigint[], bigint, boolean];
  const listedAmount = findAssetAmount(assets, amounts, ctx.collateralAssetAddr);
  expectEqual(listedAmount, ctx.collateralAmount, "LiquidatorView seizable collaterals list amount");

  const relayerHasViewLiquidationData = (await ctx.acm.hasRole(
    key("VIEW_LIQUIDATION_DATA"),
    ctx.relayer.address,
  )) as boolean;
  if (relayerHasViewLiquidationData) {
    const collateralValue = (await liquidatorView
      .connect(ctx.relayer)
      .calculateCollateralValue(ctx.collateralAssetAddr, seizableAmount)) as bigint;
    if (collateralValue === 0n) {
      console.log("  [Notice] LiquidatorView collateral valuation returned zero; calculateCollateralValue is best-effort when PositionView read fails");
    }
  } else {
    console.log("  [Notice] relayer lacks VIEW_LIQUIDATION_DATA; liquidation valuation assertion skipped");
  }

  const relayerHasViewSystemData = (await ctx.acm.hasRole(
    key("VIEW_SYSTEM_DATA"),
    ctx.relayer.address,
  )) as boolean;
  if (relayerHasViewSystemData) {
    const [globalView, globalBlock] = (await liquidatorView
      .connect(ctx.relayer)
      .getGlobalLiquidationViewWithMeta()) as [any, bigint, boolean];
    const lastLiquidationBlock = BigInt(globalView.lastLiquidationBlock ?? globalView[4] ?? 0);
    if (globalBlock !== 0n || lastLiquidationBlock !== 0n) {
      console.log(
        `  [Notice] LiquidatorView global placeholder moved: metaBlock=${globalBlock.toString()} lastLiq=${lastLiquidationBlock.toString()}`,
      );
    }

    const [profitView] = (await liquidatorView
      .connect(ctx.relayer)
      .getLiquidatorProfitViewWithMeta(ctx.relayer.address)) as [any, bigint, boolean];
    const profitLastBlock = BigInt(profitView.lastLiquidationBlock ?? profitView[3] ?? 0);
    const blocksSinceLast = BigInt(profitView.blocksSinceLastLiquidation ?? profitView[6] ?? 0);
    if (profitLastBlock === 0n && blocksSinceLast !== 0n) {
      throw new Error("LiquidatorView profit placeholder freshness fields are inconsistent");
    }
  } else {
    console.log("  [Notice] relayer lacks VIEW_SYSTEM_DATA; LiquidatorView global assertions skipped");
  }

  if (!afterBorrow.base.collateralPositionValid || !afterBorrow.base.debtPositionValid) {
    throw new Error("Extended view observation after borrow returned invalid position payloads");
  }

  const order = await getOrderForView(ctx, finalized.orderId);
  if (order.borrower.toLowerCase() !== ctx.borrower.address.toLowerCase()) {
    throw new Error("order borrower mismatch after finalizeMatch");
  }

  if (blocksOnlyViewAddr && blocksOnlyViewAddr !== ethers.ZeroAddress) {
    const blocksOnlyView = (await ethers.getContractAt(
      [
        "function getBorrowerOrderCount(address borrower) view returns (uint256,bool,uint256)",
        "function getBorrowerOrderIdsPaginated(address borrower,uint256 offset,uint256 limit) view returns (uint256[] memory,uint256,bool,uint256)",
      ],
      blocksOnlyViewAddr,
      ctx.viewer,
    )) as any;
    const [borrowerCount, borrowerValid] = (await blocksOnlyView
      .connect(ctx.borrower)
      .getBorrowerOrderCount(ctx.borrower.address)) as [bigint, boolean, bigint];
    const [orderIds, totalCount] = (await blocksOnlyView
      .connect(ctx.borrower)
      .getBorrowerOrderIdsPaginated(ctx.borrower.address, 0, 8)) as [bigint[], bigint, boolean, bigint];
    if (!borrowerValid || borrowerCount !== totalCount || orderIds.length !== Number(totalCount)) {
      throw new Error("BlocksOnlyView borrower-scoped empty state is inconsistent");
    }
  }

  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);