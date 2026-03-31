import { ethers } from "hardhat";

import {
  assignFreshBorrower,
  createFundsFlowLiveContext,
  depositCollateral,
  ensureFundsFlowEnvironmentReady,
  ensureFundsFlowPrices,
  expectEqual,
  finalizeSingleMatch,
  fundFundsFlowActors,
  getGuaranteeState,
  repayOrder,
  reserveForLending,
} from "./_fundsFlowLive";
import { runWithNetworkRetry } from "./_networkRetry";
import { explainRevert, key } from "./_mockLiveUtils";

const GUARANTEE_EVENT_IFACE = new ethers.Interface([
  "event GuaranteeLocked(address indexed user,address indexed asset,uint256 amount,uint256 blockNumber)",
  "event GuaranteeReleased(address indexed user,address indexed asset,uint256 amount,uint256 blockNumber)",
  "event GuaranteeForfeited(address indexed user,address indexed asset,uint256 amount,address indexed feeReceiver,uint256 blockNumber)",
  "event DataPushed(bytes32 indexed dataTypeHash, bytes payload)",
]);

function withGasBuffer(estimate: bigint, multiplierBps = 12_000n) {
  return (estimate * multiplierBps) / 10_000n + 50_000n;
}

function parseEmitterLogs(receipt: any, emitterAddr: string, eventName: string) {
  const fragment = GUARANTEE_EVENT_IFACE.getEvent(eventName);
  return (receipt.logs ?? [])
    .filter(
      (log: any) =>
        String(log.address ?? "").toLowerCase() === emitterAddr.toLowerCase()
        && String(log.topics?.[0] ?? "").toLowerCase() === fragment.topicHash.toLowerCase(),
    )
    .map((log: any) => GUARANTEE_EVENT_IFACE.parseLog({ topics: log.topics, data: log.data }));
}

function parseGuaranteePushes(receipt: any, emitterAddr: string, dataTypeName: string) {
  const fragment = GUARANTEE_EVENT_IFACE.getEvent("DataPushed");
  return (receipt.logs ?? [])
    .filter(
      (log: any) =>
        String(log.address ?? "").toLowerCase() === emitterAddr.toLowerCase()
        && String(log.topics?.[0] ?? "").toLowerCase() === fragment.topicHash.toLowerCase(),
    )
    .map((log: any) => GUARANTEE_EVENT_IFACE.parseLog({ topics: log.topics, data: log.data }))
    .filter((entry: any) => String(entry.args.dataTypeHash ?? entry.args[0]).toLowerCase() === key(dataTypeName).toLowerCase());
}

function extractGuaranteePushAmount(dataTypeName: string, payload: string) {
  const payloadBytes = ethers.getBytes(payload);
  if (payloadBytes.length % 32 !== 0 || payloadBytes.length === 0) {
    throw new Error(`unexpected guarantee payload size for ${dataTypeName}: ${payloadBytes.length}`);
  }
  const slotIndex = payloadBytes.length <= 96 ? 0 : 2;
  const slotStart = slotIndex * 32;
  const slotEnd = slotStart + 32;
  return BigInt(ethers.dataSlice(payload, slotStart, slotEnd));
}

async function runEarlyRepaymentBranch() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live Guarantee Events Early Repay",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "500",
  });

  await assignFreshBorrower(ctx, { noticeLabel: "using fresh guarantee-events borrower (early repay)" });
  await ensureFundsFlowEnvironmentReady(ctx);
  await ensureFundsFlowPrices(ctx);

  if (!ctx.gfm || !ctx.ergm) {
    throw new Error("guarantee modules are not registered in current environment");
  }

  const ergmAdmin = (await ethers.getContractAt(
    [
      "function setGuaranteeEnabled(address asset,bool enabled)",
      "function isGuaranteeEnabled(address asset) view returns (bool)",
      "function previewEarlyRepayment(uint256 guaranteeId,uint256 actualRepayAmount) view returns ((uint256 penaltyToLender,uint256 refundToBorrower,uint256 platformFee,uint256 actualInterestPaid))",
    ],
    ctx.ergmAddr,
    ctx.relayer,
  )) as any;

  const wasEnabled = (await ergmAdmin.isGuaranteeEnabled(ctx.borrowAssetAddr)) as boolean;
  if (!wasEnabled) {
    await (await ergmAdmin.setGuaranteeEnabled(ctx.borrowAssetAddr, true)).wait();
  }

  try {
    await fundFundsFlowActors(ctx, {
      borrowerBorrowAmount: ctx.totalDue + ctx.interest,
      borrowerCollateralAmount: ctx.collateralAmount,
      lenderBorrowAmount: ctx.borrowAmount,
    });

    if (ctx.interest > 0n) {
      await (await ctx.borrowToken.connect(ctx.borrower).approve(ctx.guaranteeFundAddr, ctx.interest)).wait();
    }

    await depositCollateral(ctx, ctx.collateralAmount);
    const reserve = await reserveForLending(ctx);
    const finalized = await finalizeSingleMatch(ctx, reserve);
    const guaranteeAfterFinalize = await getGuaranteeState(ctx);

    const lockedEvents = parseEmitterLogs(finalized.receipt, ctx.guaranteeFundAddr, "GuaranteeLocked");
    const lockedPushes = parseGuaranteePushes(finalized.receipt, ctx.guaranteeFundAddr, "GUARANTEE_LOCKED");
    if (lockedEvents.length !== 1 || lockedPushes.length !== 1) {
      throw new Error(`expected exactly one GuaranteeLocked event/push on finalize, got events=${lockedEvents.length} pushes=${lockedPushes.length}`);
    }

    const lockedEvent = lockedEvents[0] as any;
    expectEqual(BigInt(lockedEvent.args.amount ?? lockedEvent.args[2] ?? 0), ctx.interest, "guarantee locked event amount");
    const lockedAmount = extractGuaranteePushAmount(
      "GUARANTEE_LOCKED",
      String(lockedPushes[0].args.payload ?? lockedPushes[0].args[1]),
    );
    expectEqual(lockedAmount, ctx.interest, "guarantee locked push amount");
    expectEqual(guaranteeAfterFinalize.locked, ctx.interest, "guarantee locked state after finalize");

    const preview = (await ergmAdmin.previewEarlyRepayment(guaranteeAfterFinalize.guaranteeId, ctx.totalDue)) as any;
    const refundToBorrower = BigInt(preview.refundToBorrower ?? preview[1] ?? 0);
    const penaltyToLender = BigInt(preview.penaltyToLender ?? preview[0] ?? 0);
    const platformFee = BigInt(preview.platformFee ?? preview[2] ?? 0);

    const repayReceipt = await repayOrder(ctx, finalized.orderId, ctx.totalDue);
    const guaranteeAfterRepay = await getGuaranteeState(ctx);
    expectEqual(guaranteeAfterRepay.locked, 0n, "guarantee locked state after early repay");
    if (guaranteeAfterRepay.active) {
      throw new Error("guarantee should be inactive after early repay branch");
    }

    const releasedEvents = parseEmitterLogs(repayReceipt, ctx.guaranteeFundAddr, "GuaranteeReleased");
    const releasedPushes = parseGuaranteePushes(repayReceipt, ctx.guaranteeFundAddr, "GUARANTEE_RELEASED");
    const forfeitedEvents = parseEmitterLogs(repayReceipt, ctx.guaranteeFundAddr, "GuaranteeForfeited");
    const forfeitedPushes = parseGuaranteePushes(repayReceipt, ctx.guaranteeFundAddr, "GUARANTEE_FORFEITED");

    const releasedSum = releasedEvents.reduce((sum: bigint, entry: any) => sum + BigInt(entry.args.amount ?? entry.args[2] ?? 0), 0n);
    const forfeitedSum = forfeitedEvents.reduce((sum: bigint, entry: any) => sum + BigInt(entry.args.amount ?? entry.args[2] ?? 0), 0n);
    if (releasedPushes.length !== releasedEvents.length || forfeitedPushes.length !== forfeitedEvents.length) {
      throw new Error(
        `guarantee release/forfeit push count mismatch: released events=${releasedEvents.length} pushes=${releasedPushes.length}; forfeited events=${forfeitedEvents.length} pushes=${forfeitedPushes.length}`,
      );
    }

    const releasedPushSum = releasedPushes.reduce((sum: bigint, entry: any) => {
      const amount = extractGuaranteePushAmount("GUARANTEE_RELEASED", String(entry.args.payload ?? entry.args[1]));
      return sum + amount;
    }, 0n);
    const forfeitedPushSum = forfeitedPushes.reduce((sum: bigint, entry: any) => {
      const amount = extractGuaranteePushAmount("GUARANTEE_FORFEITED", String(entry.args.payload ?? entry.args[1]));
      return sum + amount;
    }, 0n);
    expectEqual(releasedPushSum, releasedSum, "guarantee released push total on early repay");
    expectEqual(forfeitedPushSum, forfeitedSum, "guarantee forfeited push total on early repay");
    expectEqual(releasedSum + forfeitedSum, ctx.interest, "early repay guarantee event conservation");

    console.log(
      `  [GuaranteeEvents.EarlyRepay] orderId=${finalized.orderId.toString()} locked=${ctx.interest.toString()} released=${releasedSum.toString()} forfeited=${forfeitedSum.toString()} previewRefund=${refundToBorrower.toString()} previewPenalty=${penaltyToLender.toString()} previewPlatformFee=${platformFee.toString()}`,
    );
  } finally {
    if (!wasEnabled) {
      await (await ergmAdmin.setGuaranteeEnabled(ctx.borrowAssetAddr, false)).wait();
    }
  }
}

async function runDefaultBranch() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live Guarantee Events Default",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "500",
  });

  await assignFreshBorrower(ctx, { noticeLabel: "using fresh guarantee-events borrower (default)" });
  await ensureFundsFlowEnvironmentReady(ctx);
  await ensureFundsFlowPrices(ctx);

  if (!ctx.gfm || !ctx.ergm) {
    throw new Error("guarantee modules are not registered in current environment");
  }

  const ergmAdmin = (await ethers.getContractAt(
    [
      "function setGuaranteeEnabled(address asset,bool enabled)",
      "function isGuaranteeEnabled(address asset) view returns (bool)",
    ],
    ctx.ergmAddr,
    ctx.relayer,
  )) as any;
  const lendingEngine = (await ethers.getContractAt(
    ["function getDebt(address user,address asset) view returns (uint256)"],
    await ((await ethers.getContractAt(["function getModuleOrRevert(bytes32) view returns (address)"], ctx.registryAddr)) as any).getModuleOrRevert(key("LENDING_ENGINE")),
  )) as any;
  const settlementManager = (await ethers.getContractAt(
    ["function settleOrLiquidate(uint256 orderId)"],
    ctx.settlementManagerAddr,
    ctx.relayer,
  )) as any;
  const healthViewWriter = (await ethers.getContractAt(
    ["function pushRiskStatus(address user,uint256 healthFactorBps,uint256 minHFBps,bool undercollateralized,uint256 blockNumber)"],
    String(ctx.healthView.target),
    ctx.relayer,
  )) as any;

  const wasEnabled = (await ergmAdmin.isGuaranteeEnabled(ctx.borrowAssetAddr)) as boolean;
  if (!wasEnabled) {
    await (await ergmAdmin.setGuaranteeEnabled(ctx.borrowAssetAddr, true)).wait();
  }

  try {
    await fundFundsFlowActors(ctx, {
      borrowerBorrowAmount: ctx.totalDue + ctx.interest,
      borrowerCollateralAmount: ctx.collateralAmount,
      lenderBorrowAmount: ctx.borrowAmount,
    });

    if (ctx.interest > 0n) {
      await (await ctx.borrowToken.connect(ctx.borrower).approve(ctx.guaranteeFundAddr, ctx.interest)).wait();
    }

    await depositCollateral(ctx, ctx.collateralAmount);
    const reserve = await reserveForLending(ctx);
    const finalized = await finalizeSingleMatch(ctx, reserve);
    const guaranteeAfterFinalize = await getGuaranteeState(ctx);
    expectEqual(guaranteeAfterFinalize.locked, ctx.interest, "guarantee locked state before default");

    await healthViewWriter.connect(ctx.relayer).pushRiskStatus.staticCall(ctx.borrower.address, 0n, 10_000n, true, 0n);
    const pushRiskStatusGas = withGasBuffer(
      await healthViewWriter.connect(ctx.relayer).pushRiskStatus.estimateGas(ctx.borrower.address, 0n, 10_000n, true, 0n),
    );
    await (
      await healthViewWriter.connect(ctx.relayer).pushRiskStatus(ctx.borrower.address, 0n, 10_000n, true, 0n, {
        gasLimit: pushRiskStatusGas,
      })
    ).wait();

    try {
      await settlementManager.connect(ctx.relayer).settleOrLiquidate.staticCall(finalized.orderId);
    } catch (error: any) {
      throw new Error(`settleOrLiquidate.staticCall reverted in guarantee default branch: ${explainRevert(error, [settlementManager.interface, ctx.gfm.interface, ctx.ergm.interface])}`);
    }

    const estimate = (await settlementManager.connect(ctx.relayer).settleOrLiquidate.estimateGas(finalized.orderId)) as bigint;
    const liquidationReceipt = await (
      await settlementManager.connect(ctx.relayer).settleOrLiquidate(finalized.orderId, {
        gasLimit: withGasBuffer(estimate, 13_000n),
      })
    ).wait();

    const debtAfter = (await lendingEngine.getDebt(ctx.borrower.address, ctx.borrowAssetAddr)) as bigint;
    const guaranteeAfterDefault = await getGuaranteeState(ctx);
    if (guaranteeAfterDefault.active || guaranteeAfterDefault.locked !== 0n) {
      throw new Error(`guarantee should be fully cleared after default: active=${String(guaranteeAfterDefault.active)} locked=${guaranteeAfterDefault.locked.toString()}`);
    }

    const forfeitedEvents = parseEmitterLogs(liquidationReceipt, ctx.guaranteeFundAddr, "GuaranteeForfeited");
    const forfeitedPushes = parseGuaranteePushes(liquidationReceipt, ctx.guaranteeFundAddr, "GUARANTEE_FORFEITED");
    if (forfeitedEvents.length === 0 || forfeitedPushes.length === 0) {
      throw new Error(`expected GuaranteeForfeited event and DataPushed on default branch, got events=${forfeitedEvents.length} pushes=${forfeitedPushes.length}`);
    }

    const forfeitedEventSum = forfeitedEvents.reduce((sum: bigint, entry: any) => sum + BigInt(entry.args.amount ?? entry.args[2] ?? 0), 0n);
    const forfeitedPushSum = forfeitedPushes.reduce((sum: bigint, entry: any) => {
      const amount = extractGuaranteePushAmount("GUARANTEE_FORFEITED", String(entry.args.payload ?? entry.args[1]));
      return sum + amount;
    }, 0n);
    expectEqual(forfeitedEventSum, guaranteeAfterFinalize.locked, "default guarantee forfeited event total");
    expectEqual(forfeitedPushSum, guaranteeAfterFinalize.locked, "default guarantee forfeited push total");

    console.log(
      `  [GuaranteeEvents.Default] orderId=${finalized.orderId.toString()} lockedBefore=${guaranteeAfterFinalize.locked.toString()} forfeited=${forfeitedEventSum.toString()} debtAfter=${debtAfter.toString()}`,
    );
  } finally {
    if (!wasEnabled) {
      await (await ergmAdmin.setGuaranteeEnabled(ctx.borrowAssetAddr, false)).wait();
    }
  }
}

async function main() {
  await runEarlyRepaymentBranch();
  await runDefaultBranch();
  console.log("\n✅ live-guarantee-events-datapush-arbitrum-sepolia PASSED\n");
}

void runWithNetworkRetry("live-guarantee-events-datapush-arbitrum-sepolia", main);