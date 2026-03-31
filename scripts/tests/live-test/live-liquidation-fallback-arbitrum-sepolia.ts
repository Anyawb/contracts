import { ethers, network } from "hardhat";

import { envBool, envStr } from "../_addressResolver";
import { decodeRevert } from "../../utils/decodeRevert";
import {
  assignFreshBorrower,
  bootstrapFundsFlowLiveTest,
  depositCollateral,
  finalizeSingleMatch,
  type FundsFlowLiveContext,
  fundFundsFlowActors,
  getGuaranteeState,
  getOrderForView,
  reserveForLending,
} from "./_fundsFlowLive";
import { isRetryableNetworkError, runWithNetworkRetry } from "./_networkRetry";
import { key } from "./_mockLiveUtils";

function topicHash(signature: string) {
  return ethers.id(signature).toLowerCase();
}

function extractRevertData(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const candidate = error as Record<string, any>;
  const direct = candidate.data;
  if (typeof direct === "string" && direct.startsWith("0x")) {
    return direct;
  }
  const nestedError = candidate.error;
  if (nestedError && typeof nestedError === "object") {
    const nestedData = (nestedError as Record<string, any>).data;
    if (typeof nestedData === "string" && nestedData.startsWith("0x")) {
      return nestedData;
    }
  }
  const info = candidate.info;
  if (info && typeof info === "object") {
    const infoData = (info as Record<string, any>).data;
    if (typeof infoData === "string" && infoData.startsWith("0x")) {
      return infoData;
    }
    const infoError = (info as Record<string, any>).error;
    if (infoError && typeof infoError === "object") {
      const infoErrorData = (infoError as Record<string, any>).data;
      if (typeof infoErrorData === "string" && infoErrorData.startsWith("0x")) {
        return infoErrorData;
      }
    }
  }
  return undefined;
}

function describeRevert(error: unknown) {
  const revertData = extractRevertData(error);
  if (revertData) {
    return `${decodeRevert(revertData)} raw=${revertData}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function expectRevert(label: string, action: () => Promise<unknown>) {
  try {
    await action();
  } catch {
    console.log(`  [ExpectedRevert] ${label}`);
    return;
  }
  throw new Error(`${label}: expected revert`);
}

function expectBigintEq(label: string, actual: bigint, expected: bigint) {
  if (actual !== expected) {
    throw new Error(`${label}: expected=${expected.toString()} actual=${actual.toString()}`);
  }
}

function expectAddressEq(label: string, actual: string, expected: string) {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label}: expected=${expected} actual=${actual}`);
  }
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureSignerNativeBalance(
  ctx: FundsFlowLiveContext,
  target: { address: string },
  requiredBalanceWei: bigint,
  label: string,
) {
  const beforeBalance = await ethers.provider.getBalance(target.address);
  if (beforeBalance >= requiredBalanceWei) {
    return beforeBalance;
  }

  const sponsorReserve = ethers.parseEther(envStr("LIVE_FRESH_BORROWER_RELAYER_RESERVE_ETH") ?? "0.0002");
  let remainingTopUp = requiredBalanceWei - beforeBalance;
  const seenSponsors = new Set<string>();
  const sponsors = [ctx.lender, ctx.viewer, ctx.updater].filter((signer): signer is NonNullable<typeof signer> => {
    if (!signer?.address) {
      return false;
    }
    const signerKey = signer.address.toLowerCase();
    if (signerKey === target.address.toLowerCase() || seenSponsors.has(signerKey)) {
      return false;
    }
    seenSponsors.add(signerKey);
    return true;
  });

  for (const sponsor of sponsors) {
    if (remainingTopUp === 0n) {
      break;
    }
    const sponsorBalance = await ethers.provider.getBalance(sponsor.address);
    const affordableTopUp = sponsorBalance > sponsorReserve ? sponsorBalance - sponsorReserve : 0n;
    const topUpAmount = remainingTopUp > affordableTopUp ? affordableTopUp : remainingTopUp;
    if (topUpAmount === 0n) {
      continue;
    }
    await (await sponsor.sendTransaction({ to: target.address, value: topUpAmount })).wait();
    remainingTopUp -= topUpAmount;
  }

  const finalBalance = await ethers.provider.getBalance(target.address);
  console.log(
    `  [FallbackCheck] nativeTopUp label=${label} before=${ethers.formatEther(beforeBalance)} after=${ethers.formatEther(finalBalance)} required=${ethers.formatEther(requiredBalanceWei)}`,
  );
  if (finalBalance < requiredBalanceWei) {
    throw new Error(
      `${label}: insufficient native balance for fallback execution: have=${ethers.formatEther(finalBalance)} ETH required=${ethers.formatEther(requiredBalanceWei)} ETH`,
    );
  }
  return finalBalance;
}

async function refreshPrice(ctx: FundsFlowLiveContext, asset: string, label: string) {
  const nowBlock = BigInt(await ethers.provider.getBlockNumber());
  const [price, priceBlock] = (await ctx.priceOracle.getPrice(asset)) as [bigint, bigint, bigint];
  if (price === 0n || priceBlock === 0n) {
    throw new Error(`${label}: price oracle returned zero/invalid price for asset ${asset}`);
  }
  const hasUpdatePrice = (await ctx.acm.hasRole(key("UPDATE_PRICE"), ctx.relayer.address)) as boolean;
  if (!hasUpdatePrice) {
    throw new Error(`relayer ${ctx.relayer.address} lacks UPDATE_PRICE role required by keeper refresh runbook`);
  }
  if (ctx.updater) {
    await (await ctx.updater.connect(ctx.relayer).updateAssetPrice(asset, price, nowBlock)).wait();
    return;
  }
  if (!ctx.allowDirectOraclePriceWrite) {
    throw new Error(`${label}: PriceUpdater is unavailable and direct oracle writes are disabled`);
  }
  await (await ctx.priceOracle.connect(ctx.relayer).updatePrice(asset, price, nowBlock)).wait();
}

async function mineTo(targetBlock: bigint) {
  const current = BigInt(await ethers.provider.getBlockNumber());
  if (current >= targetBlock) {
    return;
  }
  const delta = targetBlock - current;
  try {
    await network.provider.send("hardhat_mine", [`0x${delta.toString(16)}`]);
  } catch {
    for (let remaining = delta; remaining > 0n; remaining -= 1n) {
      await network.provider.send("evm_mine", []);
    }
  }
}

async function main() {
  const configuredOrderId = envStr("LIQUIDATION_FALLBACK_ORDER_ID") ?? envStr("LIQUIDATION_ORDER_ID");
  const allowRiskTriggeredConfiguredOrder = envBool("LIQUIDATION_ACCEPT_RISK_TRIGGERED_ORDER", false);
  const { ctx } = await bootstrapFundsFlowLiveTest({
    label: "Live Liquidation Fallback",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  const hasActionLiquidate = (await ctx.acm.hasRole(key("LIQUIDATE"), ctx.relayer.address)) as boolean;
  const hasActionAdmin = (await ctx.acm.hasRole(key("ACTION_ADMIN"), ctx.relayer.address)) as boolean;
  if (!hasActionLiquidate) {
    throw new Error(`relayer ${ctx.relayer.address} lacks LIQUIDATE role required by SettlementManager`);
  }
  if (!hasActionAdmin) {
    throw new Error(`relayer ${ctx.relayer.address} lacks ACTION_ADMIN role required to pause LiquidationManager`);
  }
  if (network.name !== "localhost" && network.name !== "hardhat" && !envBool("ALLOW_LIQUIDATION_MANAGER_PAUSE", false)) {
    throw new Error("set ALLOW_LIQUIDATION_MANAGER_PAUSE=1 before pausing LiquidationManager on a non-local network");
  }

  const registry = (await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    ctx.registryAddr,
  )) as any;
  const settlementManagerAddr = ctx.settlementManagerAddr;
  const liquidationManagerAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_MANAGER"))) as string;
  const liquidationViewAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_VIEW"))) as string;
  const lendingEngineAddr = (await registry.getModuleOrRevert(key("LENDING_ENGINE"))) as string;
  const liquidationPayoutManagerAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_PAYOUT_MANAGER"))) as string;
  const feeRouterAddr = ctx.feeRouterAddr;

  const liquidationPayoutManager = (await ethers.getContractAt(
    [
      "function calculateShares(uint256 collateralAmount) view returns (uint256,uint256,uint256,uint256)",
      "function getRecipients() view returns ((address platform,address reserve,address lenderCompensation))",
    ],
    liquidationPayoutManagerAddr,
    ctx.viewer,
  )) as any;
  const collateralManager = (await ethers.getContractAt(
    ["function getCollateral(address user,address asset) view returns (uint256)"],
    ctx.collateralManagerAddr,
    ctx.viewer,
  )) as any;
  const feeRouter = (await ethers.getContractAt(
    [
      "function getPlatformTreasury() view returns (address)",
      "function getEcosystemVault() view returns (address)",
      "function isTokenSupported(address token) view returns (bool)",
      "function addSupportedToken(address token)",
    ],
    feeRouterAddr,
    ctx.relayer,
  )) as any;
  const collateralToken = (await ethers.getContractAt(
    ["function balanceOf(address account) view returns (uint256)"],
    ctx.collateralAssetAddr,
    ctx.viewer,
  )) as any;

  const settlementManagerHasLiquidateRole = (await ctx.acm.hasRole(key("LIQUIDATE"), settlementManagerAddr)) as boolean;
  if (!settlementManagerHasLiquidateRole) {
    try {
      await (await ctx.acm.connect(ctx.relayer).grantRole(key("LIQUIDATE"), settlementManagerAddr)).wait();
    } catch {
      // fall through to explicit verification below
    }
  }
  if (!((await ctx.acm.hasRole(key("LIQUIDATE"), settlementManagerAddr)) as boolean)) {
    throw new Error(`SettlementManager ${settlementManagerAddr} lacks LIQUIDATE role required for fallback collateral exits`);
  }

  const settlementManagerHasDepositRole = (await ctx.acm.hasRole(key("DEPOSIT"), settlementManagerAddr)) as boolean;
  if (!settlementManagerHasDepositRole) {
    try {
      await (await ctx.acm.connect(ctx.relayer).grantRole(key("DEPOSIT"), settlementManagerAddr)).wait();
    } catch {
      // fall through to explicit verification below
    }
  }
  if (!((await ctx.acm.hasRole(key("DEPOSIT"), settlementManagerAddr)) as boolean)) {
    throw new Error(`SettlementManager ${settlementManagerAddr} lacks DEPOSIT role required for FeeRouter.distributePrepaid`);
  }

  let orderId: bigint;
  let borrowerAddr: string;
  if (configuredOrderId) {
    orderId = BigInt(configuredOrderId);
    const existingOrder = await getOrderForView(ctx, orderId);
    if (!existingOrder.borrower || existingOrder.borrower === ethers.ZeroAddress || !existingOrder.asset || existingOrder.asset === ethers.ZeroAddress) {
      throw new Error(
        `configured fallback liquidation order is stale or missing on current registry: orderId=${orderId.toString()} registry=${ctx.registryAddr} borrower=${String(existingOrder.borrower)} asset=${String(existingOrder.asset)}`,
      );
    }
    borrowerAddr = existingOrder.borrower;
    const currentBlock = BigInt(await ethers.provider.getBlockNumber());
    if (currentBlock <= existingOrder.maturity && !allowRiskTriggeredConfiguredOrder) {
      throw new Error(
        `configured fallback liquidation order is not overdue: currentBlock=${currentBlock.toString()} maturity=${existingOrder.maturity.toString()}`,
      );
    }
    if (currentBlock <= existingOrder.maturity && allowRiskTriggeredConfiguredOrder) {
      console.log(
        `  [Notice] configured fallback liquidation order is not overdue but risk-triggered execution is allowed: orderId=${orderId.toString()} maturity=${existingOrder.maturity.toString()} currentBlock=${currentBlock.toString()}`,
      );
    }
  } else {
    await assignFreshBorrower(ctx, { noticeLabel: "using fresh liquidation-fallback borrower" });
    if (network.name !== "localhost" && network.name !== "hardhat") {
      throw new Error("set LIQUIDATION_ORDER_ID to an existing overdue order for non-local fallback liquidation tests");
    }
    await fundFundsFlowActors(ctx, {
      borrowerBorrowAmount: ctx.totalDue,
      borrowerCollateralAmount: ctx.collateralAmount,
      lenderBorrowAmount: ctx.borrowAmount,
    });
    await depositCollateral(ctx, ctx.collateralAmount);
    const reserve = await reserveForLending(ctx);
    const finalized = await finalizeSingleMatch(ctx, reserve);
    orderId = finalized.orderId;
    borrowerAddr = ctx.borrower.address;
    const createdOrder = await getOrderForView(ctx, orderId);
    await expectRevert("fallback settleOrLiquidate should reject before maturity", async () => {
      const settlementManagerBefore = (await ethers.getContractAt(
        ["function settleOrLiquidate(uint256 orderId)"],
        ctx.settlementManagerAddr,
        ctx.relayer,
      )) as any;
      await settlementManagerBefore.connect(ctx.relayer).settleOrLiquidate.staticCall(orderId);
    });
    await mineTo(createdOrder.maturity + 1n);
  }

  await refreshPrice(ctx, ctx.borrowAssetAddr, "fallback-debt-asset");
  await refreshPrice(ctx, ctx.collateralAssetAddr, "fallback-collateral-asset");

  const lendingEngine = (await ethers.getContractAt(
    ["function getDebt(address user,address asset) view returns (uint256)", "function getReducibleDebtAmount(address user,address asset) view returns (uint256)"],
    lendingEngineAddr,
  )) as any;
  const settlementManager = (await ethers.getContractAt(
    [
      "event LiquidationManagerFallbackActivated(uint256 indexed orderId,address indexed user,address indexed collateralAsset,address debtAsset,address liquidator,bytes reason,uint256 blockNumber)",
      "event FallbackPayoutExecuted(address indexed user,address indexed collateralAsset,address platform,address reserve,address lenderCompensation,address indexed liquidator,uint256 platformShare,uint256 reserveShare,uint256 lenderShare,uint256 liquidatorShare)",
      "function settleOrLiquidate(uint256 orderId)",
    ],
    settlementManagerAddr,
    ctx.relayer,
  )) as any;
  const liquidationManager = (await ethers.getContractAt(
    ["function pause()", "function unpause()", "function paused() view returns (bool)"],
    liquidationManagerAddr,
    ctx.relayer,
  )) as any;
  const liquidatorView = (await ethers.getContractAt(
    ["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"],
    liquidationViewAddr,
    ctx.viewer,
  )) as any;

  const debtBefore = (await lendingEngine.getDebt(borrowerAddr, ctx.borrowAssetAddr)) as bigint;
  const reducibleBefore = (await lendingEngine.getReducibleDebtAmount(borrowerAddr, ctx.borrowAssetAddr)) as bigint;
  if (debtBefore === 0n || reducibleBefore === 0n) {
    throw new Error("fallback liquidation requires active reducible debt");
  }

  const guaranteeState = await getGuaranteeState(ctx, borrowerAddr, ctx.borrowAssetAddr);
  const collateralBalanceBefore = (await collateralManager.getCollateral(borrowerAddr, ctx.collateralAssetAddr)) as bigint;
  const [platformShare] = (await liquidationPayoutManager.calculateShares(collateralBalanceBefore)) as [bigint, bigint, bigint, bigint];
  const payoutRecipients = await liquidationPayoutManager.getRecipients();
  const feeRouterPlatformTreasury = (await feeRouter.getPlatformTreasury()) as string;
  const feeRouterEcosystemVault = (await feeRouter.getEcosystemVault()) as string;
  const guaranteeFundTokenBalance = ctx.guaranteeFundAddr && ctx.guaranteeFundAddr !== ethers.ZeroAddress
    ? (await ctx.borrowToken.balanceOf(ctx.guaranteeFundAddr)) as bigint
    : 0n;
  const feeRouterCollateralBalanceBefore = (await collateralToken.balanceOf(feeRouterAddr)) as bigint;

  console.log(`  [FallbackCheck] orderId=${orderId.toString()} borrower=${borrowerAddr}`);
  console.log(
    `  [FallbackCheck] debtBefore=${debtBefore.toString()} reducibleBefore=${reducibleBefore.toString()} collateralBefore=${collateralBalanceBefore.toString()}`,
  );
  console.log(
    `  [FallbackCheck] payoutRecipients platform=${String(payoutRecipients.platform)} reserve=${String(payoutRecipients.reserve)} lenderCompensation=${String(payoutRecipients.lenderCompensation)}`,
  );
  console.log(
    `  [FallbackCheck] feeRouter platformTreasury=${feeRouterPlatformTreasury} ecosystemVault=${feeRouterEcosystemVault} collateralBalanceBefore=${feeRouterCollateralBalanceBefore.toString()}`,
  );
  console.log(
    `  [FallbackCheck] guarantee enabled=${guaranteeState.enabled} active=${guaranteeState.active} guaranteeId=${guaranteeState.guaranteeId.toString()} locked=${guaranteeState.locked.toString()} promisedInterest=${guaranteeState.record?.promisedInterest?.toString() ?? "0"} gfmTokenBalance=${guaranteeFundTokenBalance.toString()}`,
  );

  if (
    guaranteeState.enabled
    && guaranteeState.active
    && guaranteeState.record
    && guaranteeState.locked < guaranteeState.record.promisedInterest
  ) {
    throw new Error(
      `active guarantee underfunded for fallback default: locked=${guaranteeState.locked.toString()} promisedInterest=${guaranteeState.record.promisedInterest.toString()}`,
    );
  }

  if (platformShare > 0n) {
    const collateralTokenSupported = (await feeRouter.isTokenSupported(ctx.collateralAssetAddr)) as boolean;
    if (!collateralTokenSupported) {
      const relayerHasSetParameter = (await ctx.acm.hasRole(key("SET_PARAMETER"), ctx.relayer.address)) as boolean;
      if (!relayerHasSetParameter) {
        throw new Error(
          `FeeRouter does not support collateral asset ${ctx.collateralAssetAddr} and relayer ${ctx.relayer.address} lacks SET_PARAMETER role to add it`,
        );
      }
      await (await feeRouter.connect(ctx.relayer).addSupportedToken(ctx.collateralAssetAddr)).wait();
    }
    if (!((await feeRouter.isTokenSupported(ctx.collateralAssetAddr)) as boolean)) {
      throw new Error(`FeeRouter does not support collateral asset ${ctx.collateralAssetAddr} required for fallback platform-share prepaid routing`);
    }
  }

  try {
    await settlementManager.connect(ctx.relayer).settleOrLiquidate.staticCall(orderId);
  } catch (error) {
    console.log(
      `  [Notice] pre-pause settleOrLiquidate.staticCall reverted; continuing to paused fallback validation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let paused = false;
  let passed = false;
  try {
      const pausedBefore = (await liquidationManager.paused()) as boolean;
      if (pausedBefore) {
        console.log("  [FallbackCheck] liquidationManager already paused before test; reusing paused state");
        paused = true;
      } else {
        try {
          await liquidationManager.connect(ctx.relayer).pause.staticCall();
        } catch (error) {
          throw new Error(
            `LiquidationManager.pause preflight reverted: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await (await liquidationManager.connect(ctx.relayer).pause()).wait();
        paused = true;
      }

    let fallbackGasLimit = 5_000_000n;
    try {
      const estimated = await settlementManager.connect(ctx.relayer).settleOrLiquidate.estimateGas(orderId);
      const buffered = (estimated * 12n) / 10n + 250_000n;
      fallbackGasLimit = buffered > fallbackGasLimit ? buffered : fallbackGasLimit;
      console.log(`  [FallbackCheck] paused-path gasEstimate=${estimated.toString()} gasLimit=${fallbackGasLimit.toString()}`);
    } catch (error) {
      console.log(
        `  [Notice] paused-path gas estimate failed; using fallback gasLimit=${fallbackGasLimit.toString()}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      await settlementManager.connect(ctx.relayer).settleOrLiquidate.staticCall(orderId);
    } catch (error) {
      throw new Error(`paused-path settleOrLiquidate.staticCall reverted: ${describeRevert(error)}`);
    }

    const feeData = await ethers.provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (!maxFeePerGas || maxFeePerGas <= 0n) {
      throw new Error("unable to determine maxFeePerGas for fallback native balance check");
    }
    const requiredNativeBalance = fallbackGasLimit * maxFeePerGas + ethers.parseEther("0.00005");
    await ensureSignerNativeBalance(ctx, ctx.relayer, requiredNativeBalance, "fallback relayer gas reserve");

    const liquidationReceipt = await (
      await settlementManager.connect(ctx.relayer).settleOrLiquidate(orderId, { gasLimit: fallbackGasLimit })
    ).wait();
    const fallbackTopic = settlementManager.interface.getEvent("LiquidationManagerFallbackActivated").topicHash.toLowerCase();
    const fallbackLog = (liquidationReceipt.logs ?? []).find(
      (log: any) =>
        log.address.toLowerCase() === ctx.settlementManagerAddr.toLowerCase()
        && String(log.topics?.[0] ?? "").toLowerCase() === fallbackTopic,
    );
    if (!fallbackLog) {
      throw new Error("missing LiquidationManagerFallbackActivated event");
    }

    const fallbackPayoutLog = (liquidationReceipt.logs ?? [])
      .map((log: any) => {
        try {
          return settlementManager.interface.parseLog({ topics: log.topics, data: log.data });
        } catch {
          return undefined;
        }
      })
      .find((entry: any) => entry?.name === "FallbackPayoutExecuted");
    if (!fallbackPayoutLog) {
      throw new Error("missing FallbackPayoutExecuted event");
    }

    const payoutPushType = key("LIQUIDATION_PAYOUT").toLowerCase();
    const payoutPush = (liquidationReceipt.logs ?? [])
      .filter((log: any) => String(log.topics?.[0] ?? "").toLowerCase() === liquidatorView.interface.getEvent("DataPushed").topicHash.toLowerCase())
      .map((log: any) => liquidatorView.interface.parseLog({ topics: log.topics, data: log.data }))
      .find((entry: any) => entry && String(entry.args[0]).toLowerCase() === payoutPushType);
    if (!payoutPush) {
      throw new Error("missing LIQUIDATION_PAYOUT DataPushed in fallback path");
    }

    const payoutPayload = ethers.AbiCoder.defaultAbiCoder().decode(
      [
        "address",
        "address",
        "address",
        "address",
        "address",
        "address",
        "uint256",
        "uint256",
        "uint256",
        "uint256",
        "uint256",
      ],
      payoutPush.args[1],
    );
    expectAddressEq("fallback payout borrower", String(payoutPayload[0]), borrowerAddr);
    expectAddressEq("fallback payout liquidator", String(payoutPayload[5]), ctx.relayer.address);
    expectBigintEq(
      "fallback payout platformShare",
      BigInt(payoutPayload[6]),
      BigInt(fallbackPayoutLog.args.platformShare),
    );
    expectBigintEq(
      "fallback payout reserveShare",
      BigInt(payoutPayload[7]),
      BigInt(fallbackPayoutLog.args.reserveShare),
    );
    expectBigintEq(
      "fallback payout lenderShare",
      BigInt(payoutPayload[8]),
      BigInt(fallbackPayoutLog.args.lenderShare),
    );
    expectBigintEq(
      "fallback payout liquidatorShare",
      BigInt(payoutPayload[9]),
      BigInt(fallbackPayoutLog.args.liquidatorShare),
    );

    const debtAfter = (await lendingEngine.getDebt(borrowerAddr, ctx.borrowAssetAddr)) as bigint;
    if (debtAfter > debtBefore) {
      throw new Error(`fallback liquidation increased debt: before=${debtBefore.toString()} after=${debtAfter.toString()}`);
    }
    expectBigintEq("fallback debt delta", debtBefore - debtAfter, reducibleBefore);

    passed = true;
  } finally {
    if (paused) {
      let unpauseError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          if (!((await liquidationManager.paused()) as boolean)) {
            unpauseError = undefined;
            break;
          }
          await (await liquidationManager.connect(ctx.relayer).unpause()).wait();
          unpauseError = undefined;
          break;
        } catch (error) {
          unpauseError = error;
          if (attempt >= 3 || !isRetryableNetworkError(error)) {
            break;
          }
          console.log(`  [Retry] liquidationManager.unpause network error on attempt ${attempt}/3: ${error instanceof Error ? error.message : String(error)}`);
          await sleep(1000 * attempt);
        }
      }
      if (unpauseError) {
        throw unpauseError;
      }
    }
  }

  if (passed) {
    console.log("\n✅ live-liquidation-fallback-arbitrum-sepolia PASSED\n");
  }
}

void runWithNetworkRetry("live-liquidation-fallback-arbitrum-sepolia", main);