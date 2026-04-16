import { ethers, network } from "hardhat";

import { envBool, envStr } from "../../../../_addressResolver";
import { runWithNetworkRetry } from "../core/_networkRetry";
import {
  createFundsFlowLiveContext,
  ensureFundsFlowEnvironmentReady,
  ensureFundsFlowPrices,
  ensureTokenAllowance,
  getTokenBalances,
  observeExtendedViews,
} from "../core/_fundsFlowLive";
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
import { key } from "../core/_mockLiveUtils";
import { logLiveScriptFailure, logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";

function uniqAddresses(addresses: string[]) {
  return [...new Set(addresses.filter((address) => address && address !== ethers.ZeroAddress))];
}

function getLastDataPush(receipt: any, iface: any, dataTypeHash: string) {
  return (receipt.logs ?? [])
    .filter((log: any) => String(log.topics?.[0] ?? "").toLowerCase() === iface.getEvent("DataPushed").topicHash.toLowerCase())
    .map((log: any) => iface.parseLog({ topics: log.topics, data: log.data }))
    .filter((entry: any) => entry && String(entry.args[0]).toLowerCase() === dataTypeHash.toLowerCase())
    .at(-1);
}

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live Fee Dynamic Gate",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  await ensureFundsFlowEnvironmentReady(ctx);
  await ensureFundsFlowPrices(ctx);

  const hasActionDeposit = (await ctx.acm.hasRole(key("DEPOSIT"), ctx.relayer.address)) as boolean;
  if (!hasActionDeposit) {
    throw new Error(`relayer ${ctx.relayer.address} lacks DEPOSIT role required by FeeRouter.distributeDynamic`);
  }

  const { feeRouter, feeRouterView } = await getFeeGateContracts(ctx);
  if (!feeRouterView) {
    throw new Error("FeeRouterView is not registered");
  }
  const feeRouterViewAddr = String(feeRouterView.target);

  const amount = ethers.parseUnits(envStr("FEE_DYNAMIC_AMOUNT_UNITS") ?? "100", ctx.borrowDecimals);
  const feeTypeName = envStr("FEE_DYNAMIC_TYPE_NAME") ?? "LIVE_DYNAMIC_FEE_TEST";
  const feeType = ethers.keccak256(ethers.toUtf8Bytes(feeTypeName));
  const configuredRequestedBps = BigInt(envStr("FEE_DYNAMIC_BPS") ?? "200");
  const platformTreasury = (await feeRouter.getPlatformTreasury()) as string;
  const ecosystemVault = (await feeRouter.getEcosystemVault()) as string;
  const allowWrite = envBool("ALLOW_DYNAMIC_FEE_WRITE", network.name === "localhost" || network.name === "hardhat");
  const hasSetParameter = (await ctx.acm.hasRole(key("SET_PARAMETER"), ctx.relayer.address)) as boolean;
  const dynamicUpdatedType = key("DYNAMIC_FEE_UPDATED").toLowerCase();

  const relayerBalance = (await ctx.borrowToken.balanceOf(ctx.relayer.address)) as bigint;
  if (relayerBalance < amount) {
    throw new Error(
      `relayer borrow-token balance is insufficient for dynamic-fee gate: need=${amount.toString()} have=${relayerBalance.toString()}`,
    );
  }

  let originalBps = (await feeRouter.getDynamicFee(ctx.borrowAssetAddr, feeType)) as bigint;
  let activeBps = originalBps;
  let wroteTempConfig = false;

  try {
    if (activeBps === 0n) {
      if (!allowWrite) {
        throw new Error(
          `dynamic fee is not configured for feeType=${feeTypeName}; set ALLOW_DYNAMIC_FEE_WRITE=1 or preconfigure the fee type on-chain`,
        );
      }
      if (!hasSetParameter) {
        throw new Error(`relayer ${ctx.relayer.address} lacks SET_PARAMETER role required to configure dynamic fee`);
      }
      const updateReceipt = await (
        await feeRouter.connect(ctx.relayer).setDynamicFee(ctx.borrowAssetAddr, feeType, configuredRequestedBps)
      ).wait();
      const updatePush = getLastDataPush(updateReceipt, feeRouter.interface, dynamicUpdatedType);
      if (!updatePush) {
        throw new Error("missing DYNAMIC_FEE_UPDATED DataPushed");
      }
      const payload = ethers.AbiCoder.defaultAbiCoder().decode(
        ["address", "bytes32", "uint256", "uint256", "address", "uint256"],
        updatePush.args[1],
      );
      if (String(payload[0]).toLowerCase() !== ctx.borrowAssetAddr.toLowerCase()) {
        throw new Error("dynamic fee update payload token mismatch");
      }
      if (String(payload[1]).toLowerCase() !== feeType.toLowerCase()) {
        throw new Error("dynamic fee update payload feeType mismatch");
      }
      expectBigintEq("dynamic fee update old fee", BigInt(payload[2]), 0n);
      expectBigintEq("dynamic fee update new fee", BigInt(payload[3]), configuredRequestedBps);
      activeBps = configuredRequestedBps;
      wroteTempConfig = true;
    }

    const tracked = uniqAddresses([ctx.relayer.address, platformTreasury, ecosystemVault, ctx.feeRouterAddr]);
    const beforeBalances = normalizeBalanceMap(await getTokenBalances(ctx, ctx.borrowToken, tracked));
    const beforeViews = await observeExtendedViews(ctx, "before-fee-dynamic-gate");
    requireFeeRouterPresence(beforeViews, "before-fee-dynamic-gate");
    const beforeRelayerStats = await readFeeRouterAggregateUserStats(feeRouterView, ctx.relayer.address, ctx.relayer);
    const [beforeUserFeeAmount, , beforeUserFeeValid] = (await feeRouterView
      .connect(ctx.relayer)
      .getUserFeeStatisticsWithMeta(ctx.relayer.address, feeType)) as [bigint, bigint, boolean];
    const beforeUserFeeBaseline = beforeUserFeeValid ? beforeUserFeeAmount : 0n;
    await ensureTokenAllowance(ctx.borrowToken, ctx.relayer, ctx.feeRouterAddr, amount, "borrow asset -> FeeRouter.distributeDynamic");
    const dynamicReceipt = await (await feeRouter.connect(ctx.relayer).distributeDynamic(ctx.borrowAssetAddr, amount, feeType)).wait();
    logFeeRouterViewPushFailures("after-fee-dynamic-distribute", dynamicReceipt, feeRouter.interface);

    const afterBalances = normalizeBalanceMap(await getTokenBalances(ctx, ctx.borrowToken, tracked));
    const afterViews = await observeExtendedViews(ctx, "after-fee-dynamic-gate");
    const feeRouterReady = requireFeeRouterGate(afterViews, "after-fee-dynamic-gate");
    const expectedPushBlock = feeRouterReady ? afterViews.feeRouterSync?.lastSyncBlock : undefined;
    requireFeeRouterSyncAdvance(beforeViews, afterViews, "after-fee-dynamic-gate");
    const afterRelayerStats = await readFeeRouterAggregateUserStats(feeRouterView, ctx.relayer.address, ctx.relayer);
    const [afterUserFeeAmount, , afterUserFeeValid] = (await feeRouterView
      .connect(ctx.relayer)
      .getUserFeeStatisticsWithMeta(ctx.relayer.address, feeType)) as [bigint, bigint, boolean];
    const [afterUserDynamicFee, , afterUserDynamicFeeValid] = (await feeRouterView
      .connect(ctx.relayer)
      .getUserDynamicFeeWithMeta(ctx.relayer.address, feeType)) as [bigint, bigint, boolean];
    if (!afterUserFeeValid || !afterUserDynamicFeeValid) {
      throw new Error("after-fee-dynamic-gate: FeeRouterView cached user dynamic fee fields are invalid");
    }

    const ecoDynamicBps = activeBps / 2n;
    const platformAmt = calcFee(amount, activeBps);
    const ecoAmt = calcFee(amount, ecoDynamicBps);
    const distributed = platformAmt + ecoAmt;
    const appliedBps = activeBps + ecoDynamicBps;
    assertFeeDistributionReceiptAttribution({
      stage: "dynamic gate",
      receipt: dynamicReceipt,
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
      appliedFeeBps: appliedBps,
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
      "dynamic gate aggregate group conservation",
      sumBalancesForGroup(afterBalances, payerGroup),
      sumBalancesForGroup(beforeBalances, payerGroup),
    );
    assertRoleBasedNetDeltas({
      stage: "dynamic gate",
      beforeBalances,
      afterBalances,
      roleDeltas: [
        { label: "relayer", address: ctx.relayer.address, expectedDelta: -distributed },
        { label: "platform", address: platformTreasury, expectedDelta: platformAmt },
        { label: "ecosystem", address: ecosystemVault, expectedDelta: ecoAmt },
        { label: "feeRouter", address: ctx.feeRouterAddr, expectedDelta: 0n },
      ],
    });
    expectBigintEq("dynamic gate user fee statistic delta", afterUserFeeAmount - beforeUserFeeBaseline, distributed);
    expectBigintEq("dynamic gate user dynamic fee cache", afterUserDynamicFee, appliedBps);
    if (!afterRelayerStats.isValid) {
      throw new Error("dynamic gate: FeeRouterView relayer aggregate user stats remain invalid after refresh");
    }
    if (afterRelayerStats.transactionCount <= beforeRelayerStats.transactionCount) {
      throw new Error("dynamic gate: relayer FeeRouterView user transactionCount should increase");
    }
    expectBigintEq(
      "dynamic gate totalFeePaid delta",
      afterRelayerStats.totalFeePaid - beforeRelayerStats.totalFeePaid,
      distributed,
    );

    logLiveScriptSuccess(__filename);
  } finally {
    if (wroteTempConfig) {
      await (await feeRouter.connect(ctx.relayer).setDynamicFee(ctx.borrowAssetAddr, feeType, originalBps)).wait();
    }
  }
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);