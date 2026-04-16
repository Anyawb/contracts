import { ethers } from "hardhat";

import { envStr } from "../../../../_addressResolver";
import {
  createFundsFlowLiveContext,
  ensureFundsFlowEnvironmentReady,
  ensureFundsFlowPrices,
  ensureTokenAllowance,
  getTokenBalances,
  observeExtendedViews,
} from "../core/_fundsFlowLive";
import { runWithNetworkRetry } from "../core/_networkRetry";
import { key } from "../core/_mockLiveUtils";
import {
  assertRoleBasedNetDeltas,
  assertFeeDistributionReceiptAttribution,
  calcFee,
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
import { logLiveScriptFailure, logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";

function uniqAddresses(addresses: string[]) {
  return [...new Set(addresses.filter((address) => address && address !== ethers.ZeroAddress))];
}

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live Fee Remaining Gate",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  await ensureFundsFlowEnvironmentReady(ctx);
  await ensureFundsFlowPrices(ctx);

  const hasActionDeposit = (await ctx.acm.hasRole(key("DEPOSIT"), ctx.relayer.address)) as boolean;
  if (!hasActionDeposit) {
    throw new Error(`relayer ${ctx.relayer.address} lacks DEPOSIT role required by FeeRouter.distributeNormal`);
  }

  const { feeRouter, feeRouterView } = await getFeeGateContracts(ctx);
  if (!feeRouterView) {
    throw new Error("FeeRouterView is not registered");
  }
  const feeRouterViewAddr = String(feeRouterView.target);

  const amount = ethers.parseUnits(envStr("FEE_REMAINING_AMOUNT_UNITS") ?? "100", ctx.borrowDecimals);
  const platformTreasury = (await feeRouter.getPlatformTreasury()) as string;
  const ecosystemVault = (await feeRouter.getEcosystemVault()) as string;
  const platformBps = (await feeRouter.getPlatformFeeBps()) as bigint;
  const ecoBps = (await feeRouter.getEcosystemFeeBps()) as bigint;
  const feeType = key("DEPOSIT");

  const relayerBalance = (await ctx.borrowToken.balanceOf(ctx.relayer.address)) as bigint;
  if (relayerBalance < amount) {
    throw new Error(
      `relayer borrow-token balance is insufficient for remaining-fee gate: need=${amount.toString()} have=${relayerBalance.toString()}`,
    );
  }

  const tracked = uniqAddresses([ctx.relayer.address, platformTreasury, ecosystemVault, ctx.feeRouterAddr]);
  const beforeBalances = normalizeBalanceMap(await getTokenBalances(ctx, ctx.borrowToken, tracked));
  const beforeViews = await observeExtendedViews(ctx, "before-fee-remaining-gate");
  requireFeeRouterPresence(beforeViews, "before-fee-remaining-gate");
  const beforeRelayerStats = await readFeeRouterAggregateUserStats(feeRouterView, ctx.relayer.address, ctx.relayer);
  const [beforeUserFeeAmount, , beforeUserFeeValid] = (await feeRouterView
    .connect(ctx.relayer)
    .getUserFeeStatisticsWithMeta(ctx.relayer.address, feeType)) as [bigint, bigint, boolean];
  const beforeUserFeeBaseline = beforeUserFeeValid ? beforeUserFeeAmount : 0n;
  await ensureTokenAllowance(ctx.borrowToken, ctx.relayer, ctx.feeRouterAddr, amount, "borrow asset -> FeeRouter.distributeNormal");
  const remainingReceipt = await (await feeRouter.connect(ctx.relayer).distributeNormal(ctx.borrowAssetAddr, amount)).wait();
  logFeeRouterViewPushFailures("after-fee-remaining-distribute", remainingReceipt, feeRouter.interface);

  const afterBalances = normalizeBalanceMap(await getTokenBalances(ctx, ctx.borrowToken, tracked));
  const afterViews = await observeExtendedViews(ctx, "after-fee-remaining-gate");
  const feeRouterReady = requireFeeRouterGate(afterViews, "after-fee-remaining-gate");
  const expectedPushBlock = feeRouterReady ? afterViews.feeRouterSync?.lastSyncBlock : undefined;
  requireFeeRouterSyncAdvance(beforeViews, afterViews, "after-fee-remaining-gate");
  const afterRelayerStats = await readFeeRouterAggregateUserStats(feeRouterView, ctx.relayer.address, ctx.relayer);
  const [afterUserFeeAmount, , afterUserFeeValid] = (await feeRouterView
    .connect(ctx.relayer)
    .getUserFeeStatisticsWithMeta(ctx.relayer.address, feeType)) as [bigint, bigint, boolean];
  if (!afterUserFeeValid) {
    throw new Error("after-fee-remaining-gate: FeeRouterView user fee statistics are invalid");
  }

  const platformAmt = calcFee(amount, platformBps);
  const ecoAmt = calcFee(amount, ecoBps);
  const distributed = platformAmt + ecoAmt;
  assertFeeDistributionReceiptAttribution({
    stage: "remaining gate",
    receipt: remainingReceipt,
    feeRouter,
    feeRouterAddr: ctx.feeRouterAddr,
    feeRouterView,
    feeRouterViewAddr,
    token: ctx.borrowAssetAddr,
    feeType,
    actor: ctx.relayer.address,
    user: ctx.relayer.address,
    totalAmount: amount,
    distributedAmount: distributed,
    platformAmount: platformAmt,
    ecoAmount: ecoAmt,
    remainingAmount: amount - distributed,
    appliedFeeBps: platformBps + ecoBps,
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
    "remaining gate aggregate group conservation",
    sumBalancesForGroup(afterBalances, payerGroup),
    sumBalancesForGroup(beforeBalances, payerGroup),
  );
  assertRoleBasedNetDeltas({
    stage: "remaining gate",
    beforeBalances,
    afterBalances,
    roleDeltas: [
      { label: "relayer", address: ctx.relayer.address, expectedDelta: -distributed },
      { label: "platform", address: platformTreasury, expectedDelta: platformAmt },
      { label: "ecosystem", address: ecosystemVault, expectedDelta: ecoAmt },
      { label: "feeRouter", address: ctx.feeRouterAddr, expectedDelta: 0n },
    ],
  });
  expectBigintEq("remaining gate user fee statistic delta", afterUserFeeAmount - beforeUserFeeBaseline, distributed);

  if (!afterRelayerStats.isValid) {
    throw new Error("remaining gate: FeeRouterView relayer aggregate user stats remain invalid after refresh");
  }
  if (afterRelayerStats.transactionCount <= beforeRelayerStats.transactionCount) {
    throw new Error("remaining gate: relayer FeeRouterView user transactionCount should increase");
  }
  expectBigintEq(
    "remaining gate totalFeePaid delta",
    afterRelayerStats.totalFeePaid - beforeRelayerStats.totalFeePaid,
    distributed,
  );

  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);