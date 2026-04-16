import { ethers } from "hardhat";

import { envStr } from "../../../../_addressResolver";
import {
  createFundsFlowLiveContext,
  ensureFundsFlowEnvironmentReady,
  ensureFundsFlowPrices,
  getTokenBalances,
  observeExtendedViews,
} from "../core/_fundsFlowLive";
import { runWithNetworkRetry } from "../core/_networkRetry";
import {
  assertRoleBasedNetDeltas,
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
} from "../core/_feeLiveUtils";
import { key } from "../core/_mockLiveUtils";
import { logLiveScriptFailure, logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";

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

  await (await ctx.borrowToken.connect(ctx.relayer).transfer(ctx.feeRouterAddr, amount)).wait();
  const prepaidReceipt = await (
    await feeRouter.connect(ctx.relayer).distributePrepaid(ctx.borrowAssetAddr, amount, feeType, ctx.relayer.address)
  ).wait();
  logFeeRouterViewPushFailures("after-fee-prepaid-distribute", prepaidReceipt, feeRouter.interface);

  const afterBalances = normalizeBalanceMap(await getTokenBalances(ctx, ctx.borrowToken, tracked));
  const afterViews = await observeExtendedViews(ctx, "after-fee-prepaid-gate");
  const feeRouterReady = requireFeeRouterGate(afterViews, "after-fee-prepaid-gate");
  const expectedPushBlock = feeRouterReady ? afterViews.feeRouterSync?.lastSyncBlock : undefined;
  requireFeeRouterSyncAdvance(beforeViews, afterViews, "after-fee-prepaid-gate");
  const afterRelayerStats = await readFeeRouterAggregateUserStats(feeRouterView, ctx.relayer.address, ctx.relayer);
  const [afterUserFeeAmount, , afterUserFeeValid] = (await feeRouterView
    .connect(ctx.relayer)
    .getUserFeeStatisticsWithMeta(ctx.relayer.address, feeType)) as [bigint, bigint, boolean];
  const [afterUserDynamicFee, , afterUserDynamicFeeValid] = (await feeRouterView
    .connect(ctx.relayer)
    .getUserDynamicFeeWithMeta(ctx.relayer.address, feeType)) as [bigint, bigint, boolean];
  if (!afterUserFeeValid || !afterUserDynamicFeeValid) {
    throw new Error("after-fee-prepaid-gate: FeeRouterView cached user fee fields are invalid");
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
  expectBigintEq(
    "prepaid gate aggregate group conservation",
    sumBalancesForGroup(afterBalances, payerGroup),
    sumBalancesForGroup(beforeBalances, payerGroup),
  );
  assertRoleBasedNetDeltas({
    stage: "prepaid gate",
    beforeBalances,
    afterBalances,
    roleDeltas: [
      { label: "relayer", address: ctx.relayer.address, expectedDelta: 0n - amount },
      { label: "platform", address: platformTreasury, expectedDelta: platformAmt },
      { label: "ecosystem", address: ecosystemVault, expectedDelta: ecoAmt },
      { label: "feeRouter", address: ctx.feeRouterAddr, expectedDelta: 0n },
    ],
  });
  if (beforeUserFeeValid && afterUserFeeValid) {
    expectBigintEq("prepaid gate user fee statistic delta", afterUserFeeAmount - beforeUserFeeBaseline, amount);
  } else if (afterUserFeeAmount < amount) {
    throw new Error(
      `prepaid gate user fee statistic post-refresh is smaller than current distribution: amount=${amount.toString()} postRefresh=${afterUserFeeAmount.toString()}`,
    );
  } else {
    expectBigintEq("prepaid gate user fee statistic post-refresh floor", afterUserFeeAmount >= amount ? 1n : 0n, 1n);
  }
  expectBigintEq("prepaid gate user dynamic fee cache", afterUserDynamicFee, totalFeeBps);
  if (!afterRelayerStats.isValid) {
    throw new Error("prepaid gate: FeeRouterView relayer aggregate user stats remain invalid after refresh");
  }
  if (afterRelayerStats.transactionCount <= beforeRelayerStats.transactionCount) {
    throw new Error("prepaid gate: relayer FeeRouterView user transactionCount should increase");
  }
  expectBigintEq(
    "prepaid gate totalFeePaid delta",
    afterRelayerStats.totalFeePaid - beforeRelayerStats.totalFeePaid,
    amount,
  );
  if (beforeUserDynamicFeeValid && beforeUserDynamicFeeBaseline !== 0n && beforeUserDynamicFeeBaseline !== totalFeeBps) {
    console.log(
      `  [Notice] pre-existing user dynamic fee cache for feeType changed from ${beforeUserDynamicFeeBaseline.toString()} to ${afterUserDynamicFee.toString()}`,
    );
  }

  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);