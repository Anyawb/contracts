import { ethers } from "hardhat";

import { envStr } from "../_addressResolver";
import {
  createFundsFlowLiveContext,
  ensureFundsFlowEnvironmentReady,
  ensureFundsFlowPrices,
  getTokenBalances,
  observeExtendedViews,
} from "./_fundsFlowLive";
import { runWithNetworkRetry } from "./_networkRetry";
import {
  addressOverlaps,
  assertFeeDistributionReceiptAttribution,
  calcRevenueSplit,
  expectBigintEq,
  getFeeGateContracts,
  logFeeRouterViewPushFailures,
  normalizeBalanceMap,
  normalizeAddress,
  readFeeRouterAggregateUserStats,
  requireFeeRouterGate,
  requireFeeRouterPresence,
  requireFeeRouterSyncAdvance,
  sumBalancesForGroup,
  uniqueRoleAddress,
} from "./_feeLiveUtils";
import { key } from "./_mockLiveUtils";
import { logLiveScriptFailure, logLiveScriptSuccess, resolveLiveScriptId } from "./_scriptStatus";

function uniqAddresses(addresses: string[]) {
  return [...new Set(addresses.filter((address) => address && address !== ethers.ZeroAddress))];
}

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live Fee Prepaid Gate",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  await ensureFundsFlowEnvironmentReady(ctx);
  await ensureFundsFlowPrices(ctx);

  const hasActionDeposit = (await ctx.acm.hasRole(key("DEPOSIT"), ctx.relayer.address)) as boolean;
  if (!hasActionDeposit) {
    throw new Error(`relayer ${ctx.relayer.address} lacks DEPOSIT role required by FeeRouter.distributePrepaid`);
  }

  const { feeRouter, feeRouterView } = await getFeeGateContracts(ctx);
  if (!feeRouterView) {
    throw new Error("FeeRouterView is not registered");
  }
  const feeRouterViewAddr = String(feeRouterView.target);

  const amount = ethers.parseUnits(envStr("FEE_PREPAID_AMOUNT_UNITS") ?? "50", ctx.borrowDecimals);
  const feeTypeName = envStr("FEE_PREPAID_TYPE_NAME") ?? "LIQUIDATION_PLATFORM_SHARE";
  const feeType = ethers.keccak256(ethers.toUtf8Bytes(feeTypeName));
  const platformTreasury = (await feeRouter.getPlatformTreasury()) as string;
  const ecosystemVault = (await feeRouter.getEcosystemVault()) as string;
  const platformBps = (await feeRouter.getPlatformFeeBps()) as bigint;
  const ecoBps = (await feeRouter.getEcosystemFeeBps()) as bigint;
  const totalFeeBps = platformBps + ecoBps;

  const relayerBalance = (await ctx.borrowToken.balanceOf(ctx.relayer.address)) as bigint;
  if (relayerBalance < amount) {
    throw new Error(
      `relayer borrow-token balance is insufficient for prepaid-fee gate: need=${amount.toString()} have=${relayerBalance.toString()}`,
    );
  }

  const tracked = uniqAddresses([ctx.relayer.address, platformTreasury, ecosystemVault, ctx.feeRouterAddr]);
  const beforeBalances = normalizeBalanceMap(await getTokenBalances(ctx, ctx.borrowToken, tracked));
  const beforeViews = await observeExtendedViews(ctx, "before-fee-prepaid-gate");
  requireFeeRouterPresence(beforeViews, "before-fee-prepaid-gate");
  const beforeRelayerStats = await readFeeRouterAggregateUserStats(feeRouterView, ctx.relayer.address, ctx.relayer);
  const [beforeUserFeeAmount, , beforeUserFeeValid] = (await feeRouterView
    .connect(ctx.relayer)
    .getUserFeeStatisticsWithMeta(ctx.relayer.address, feeType)) as [bigint, bigint, boolean];
  const [beforeUserDynamicFee, , beforeUserDynamicFeeValid] = (await feeRouterView
    .connect(ctx.relayer)
    .getUserDynamicFeeWithMeta(ctx.relayer.address, feeType)) as [bigint, bigint, boolean];
  const beforeUserFeeBaseline = beforeUserFeeValid ? beforeUserFeeAmount : 0n;
  const beforeUserDynamicFeeBaseline = beforeUserDynamicFeeValid ? beforeUserDynamicFee : 0n;
  if (!beforeUserFeeValid || !beforeUserDynamicFeeValid) {
    console.log("  [Notice] before-fee-prepaid-gate: FeeRouterView user fee cache is cold; using zero baseline until the post-distribution read");
  }

  await (await ctx.borrowToken.connect(ctx.relayer).transfer(ctx.feeRouterAddr, amount)).wait();
  const prepaidReceipt = await (
    await feeRouter.connect(ctx.relayer).distributePrepaid(ctx.borrowAssetAddr, amount, feeType, ctx.relayer.address)
  ).wait();
  logFeeRouterViewPushFailures("after-fee-prepaid-distribute", prepaidReceipt, feeRouter.interface);

  const afterBalances = normalizeBalanceMap(await getTokenBalances(ctx, ctx.borrowToken, tracked));
  const afterViews = await observeExtendedViews(ctx, "after-fee-prepaid-gate");
  const feeRouterReady = requireFeeRouterGate(afterViews, "after-fee-prepaid-gate");
  const expectedPushBlock = feeRouterReady ? afterViews.feeRouterSync?.lastSyncBlock : undefined;
  if (feeRouterReady) {
    requireFeeRouterSyncAdvance(beforeViews, afterViews, "after-fee-prepaid-gate");
  }
  const afterRelayerStats = await readFeeRouterAggregateUserStats(feeRouterView, ctx.relayer.address, ctx.relayer);
  const [afterUserFeeAmount, , afterUserFeeValid] = (await feeRouterView
    .connect(ctx.relayer)
    .getUserFeeStatisticsWithMeta(ctx.relayer.address, feeType)) as [bigint, bigint, boolean];
  const [afterUserDynamicFee, , afterUserDynamicFeeValid] = (await feeRouterView
    .connect(ctx.relayer)
    .getUserDynamicFeeWithMeta(ctx.relayer.address, feeType)) as [bigint, bigint, boolean];
  if (!afterUserFeeValid || !afterUserDynamicFeeValid) {
    if (feeRouterReady || process.env.LIVE_STRICT_FEE_ROUTER_GATE === "1") {
      throw new Error("after-fee-prepaid-gate: FeeRouterView cached user fee fields are invalid");
    }
    console.log(
      "  [Notice] after-fee-prepaid-gate: FeeRouterView user fee caches are still cold; skipping strict user-cache assertions",
    );
  }

  const { platformAmt, ecoAmt } = calcRevenueSplit(amount, platformBps, ecoBps);
  assertFeeDistributionReceiptAttribution({
    stage: "prepaid gate",
    receipt: prepaidReceipt,
    feeRouter,
    feeRouterAddr: ctx.feeRouterAddr,
    feeRouterView,
    feeRouterViewAddr,
    token: ctx.borrowAssetAddr,
    feeType,
    actor: ctx.relayer.address,
    user: ctx.relayer.address,
    totalAmount: amount,
    distributedAmount: amount,
    platformAmount: platformAmt,
    ecoAmount: ecoAmt,
    remainingAmount: 0n,
    appliedFeeBps: totalFeeBps,
    expectedPushBlock,
    requireFeeRouterViewPush: feeRouterReady,
  });

  const payerGroup = [ctx.relayer.address, platformTreasury, ecosystemVault, ctx.feeRouterAddr];
  const recipientGroup = [platformTreasury, ecosystemVault];
  const relayerKey = normalizeAddress(ctx.relayer.address);
  const platformKey = normalizeAddress(platformTreasury);
  const ecosystemKey = normalizeAddress(ecosystemVault);
  const feeRouterKey = normalizeAddress(ctx.feeRouterAddr);
  const recipientOverlapsPayerGroup = recipientGroup.some((address) =>
    addressOverlaps(address, [ctx.relayer.address, ctx.feeRouterAddr]),
  );
  expectBigintEq(
    "prepaid gate aggregate group conservation",
    sumBalancesForGroup(afterBalances, payerGroup),
    sumBalancesForGroup(beforeBalances, payerGroup),
  );
  if (!recipientOverlapsPayerGroup) {
    expectBigintEq(
      "prepaid gate aggregate recipient delta",
      sumBalancesForGroup(afterBalances, recipientGroup) - sumBalancesForGroup(beforeBalances, recipientGroup),
      amount,
    );
  } else {
    console.log("  [Notice] prepaid gate: recipient group overlaps payer/router; aggregate recipient delta is not observable from address balances");
  }
  if (uniqueRoleAddress(ctx.relayer.address, [platformTreasury, ecosystemVault, ctx.feeRouterAddr])) {
    expectBigintEq(
      "prepaid gate relayer net delta",
      beforeBalances.get(relayerKey)! - afterBalances.get(relayerKey)!,
      amount,
    );
  } else {
    console.log("  [Notice] prepaid gate: relayer overlaps another fee role; skipping standalone relayer net-delta assertion");
  }
  if (uniqueRoleAddress(platformTreasury, [ctx.relayer.address, ecosystemVault, ctx.feeRouterAddr])) {
    expectBigintEq(
      "prepaid gate platform delta",
      afterBalances.get(platformKey)! - beforeBalances.get(platformKey)!,
      platformAmt,
    );
  } else {
    console.log("  [Notice] prepaid gate: platform treasury overlaps another fee role; skipping standalone platform delta assertion");
  }
  if (uniqueRoleAddress(ecosystemVault, [ctx.relayer.address, platformTreasury, ctx.feeRouterAddr])) {
    expectBigintEq(
      "prepaid gate ecosystem delta",
      afterBalances.get(ecosystemKey)! - beforeBalances.get(ecosystemKey)!,
      ecoAmt,
    );
  } else {
    console.log("  [Notice] prepaid gate: ecosystem vault overlaps another fee role; skipping standalone ecosystem delta assertion");
  }
  if (uniqueRoleAddress(ctx.feeRouterAddr, [ctx.relayer.address, platformTreasury, ecosystemVault])) {
    expectBigintEq(
      "prepaid gate FeeRouter balance delta",
      afterBalances.get(feeRouterKey)! - beforeBalances.get(feeRouterKey)!,
      0n,
    );
  } else {
    console.log("  [Notice] prepaid gate: FeeRouter overlaps another fee role; skipping standalone FeeRouter delta assertion");
  }
  if (beforeUserFeeValid && afterUserFeeValid) {
    expectBigintEq("prepaid gate user fee statistic delta", afterUserFeeAmount - beforeUserFeeBaseline, amount);
  } else if (afterUserFeeValid && afterUserFeeAmount < amount) {
    throw new Error(
      `prepaid gate user fee statistic post-refresh is smaller than current distribution: amount=${amount.toString()} postRefresh=${afterUserFeeAmount.toString()}`,
    );
  } else if (afterUserFeeValid) {
    console.log(
      `  [Notice] prepaid gate: fee-type user statistic cache was cold; post-refresh cumulative value=${afterUserFeeAmount.toString()} includes historical distributions`,
    );
  } else {
    console.log("  [Notice] prepaid gate: skip fee-type user statistic assertion because user cache remains invalid");
  }
  if (afterUserDynamicFeeValid) {
    expectBigintEq("prepaid gate user dynamic fee cache", afterUserDynamicFee, totalFeeBps);
  } else {
    console.log("  [Notice] prepaid gate: skip user dynamic fee assertion because cache remains invalid");
  }
  if (feeRouterReady) {
    if (!afterRelayerStats.isValid) {
      throw new Error("prepaid gate: FeeRouterView relayer aggregate user stats remain invalid after refresh");
    }
    if (!beforeRelayerStats.isValid) {
      console.log(
        "  [Notice] prepaid gate: relayer aggregate user stats baseline was stale; validating against the stored pre-refresh snapshot",
      );
    }
    if (afterRelayerStats.transactionCount <= beforeRelayerStats.transactionCount) {
      throw new Error("prepaid gate: relayer FeeRouterView user transactionCount should increase");
    }
    expectBigintEq(
      "prepaid gate totalFeePaid delta",
      afterRelayerStats.totalFeePaid - beforeRelayerStats.totalFeePaid,
      amount,
    );
  } else {
    console.log("  [Notice] prepaid gate: skip FeeRouterView aggregate user assertions because publish-ready is false");
  }
  if (beforeUserDynamicFeeValid && beforeUserDynamicFeeBaseline !== 0n && beforeUserDynamicFeeBaseline !== totalFeeBps) {
    console.log(
      `  [Notice] pre-existing user dynamic fee cache for feeType changed from ${beforeUserDynamicFeeBaseline.toString()} to ${afterUserDynamicFee.toString()}`,
    );
  }

  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);