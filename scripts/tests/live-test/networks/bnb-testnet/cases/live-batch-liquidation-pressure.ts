import { ethers } from "hardhat";

import {
  assignFreshBorrower,
  createFundsFlowLiveContext,
  depositCollateral,
  ensureRelayerNativeGasReserve,
  ensureFundsFlowEnvironmentReady,
  ensureFundsFlowPrices,
  finalizeSingleMatch,
  fundFundsFlowActors,
  reserveForLending,
  type FundsFlowLiveContext,
} from "../core/_fundsFlowLive";
import { runWithNetworkRetry } from "../core/_networkRetry";
import { key, resolveBnbMinGasPriceWei } from "../core/_mockLiveUtils";
import { logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";

type BatchSeededOrder = {
  index: number;
  borrower: string;
  orderId: bigint;
  collateralAsset: string;
  debtAsset: string;
  collateralAmount: bigint;
  debtAmount: bigint;
  bonus: bigint;
  riskScore: bigint;
};

function envInt(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function withGasBuffer(estimate: bigint, multiplierBps = 12_000n) {
  return (estimate * multiplierBps) / 10_000n + 50_000n;
}

function withMinEip1559Fees(feeData: Awaited<ReturnType<typeof ethers.provider.getFeeData>>) {
  const minPriorityFeePerGas = resolveBnbMinGasPriceWei();
  const priorityFeePerGas = feeData.maxPriorityFeePerGas && feeData.maxPriorityFeePerGas > minPriorityFeePerGas
    ? feeData.maxPriorityFeePerGas
    : minPriorityFeePerGas;
  const baseFeePerGas = (feeData as any).lastBaseFeePerGas ?? feeData.gasPrice ?? 0n;
  const maxFeePerGas = feeData.maxFeePerGas && feeData.maxFeePerGas > baseFeePerGas + priorityFeePerGas
    ? feeData.maxFeePerGas
    : baseFeePerGas + priorityFeePerGas;
  return {
    maxFeePerGas,
    maxPriorityFeePerGas: priorityFeePerGas,
  };
}

async function seedLiquidatableOrder(
  ctx: FundsFlowLiveContext,
  index: number,
  lendingEngine: any,
  liquidatorView: any,
  healthViewWriter: any,
  liquidationRiskView: any,
): Promise<BatchSeededOrder> {
  await assignFreshBorrower(ctx, {
    noticeLabel: `using fresh batch-liquidation borrower #${index + 1}`,
  });

  await fundFundsFlowActors(ctx, {
    borrowerBorrowAmount: ctx.totalDue + ctx.interest,
    borrowerCollateralAmount: ctx.collateralAmount,
    lenderBorrowAmount: ctx.borrowAmount,
  });

  await depositCollateral(ctx, ctx.collateralAmount);
  const reserve = await reserveForLending(ctx);
  const finalized = await finalizeSingleMatch(ctx, reserve);

  const debtBefore = (await lendingEngine.getDebt(ctx.borrower.address, ctx.borrowAssetAddr)) as bigint;
  const reducibleBefore = (await lendingEngine.getReducibleDebtAmount(ctx.borrower.address, ctx.borrowAssetAddr)) as bigint;
  const [seizableAmount] = (await liquidatorView
    .connect(ctx.borrower)
    .getSeizableCollateralAmount(ctx.borrower.address, ctx.collateralAssetAddr)) as [bigint, bigint, boolean];

  if (debtBefore === 0n || reducibleBefore === 0n || seizableAmount === 0n) {
    throw new Error(
      `seeded batch liquidation order is not actionable: orderId=${finalized.orderId.toString()} debt=${debtBefore.toString()} reducible=${reducibleBefore.toString()} seizable=${seizableAmount.toString()}`,
    );
  }

  await healthViewWriter.connect(ctx.relayer).pushRiskStatus.staticCall(ctx.borrower.address, 0n, 10_000n, true, 0n);
  const pushRiskStatusGas = withGasBuffer(
    await healthViewWriter.connect(ctx.relayer).pushRiskStatus.estimateGas(ctx.borrower.address, 0n, 10_000n, true, 0n),
  );
  const riskPushFees = withMinEip1559Fees(await ethers.provider.getFeeData());
  await (
    await healthViewWriter.connect(ctx.relayer).pushRiskStatus(ctx.borrower.address, 0n, 10_000n, true, 0n, {
      gasLimit: pushRiskStatusGas,
      ...riskPushFees,
    })
  ).wait();

  const [liquidatable, metadataValid] = (await liquidationRiskView
    .connect(new ethers.VoidSigner(ctx.borrower.address, ethers.provider))
    ["isLiquidatable(address)"](ctx.borrower.address)) as [boolean, boolean, bigint];
  const [riskScore] = (await liquidationRiskView
    .connect(new ethers.VoidSigner(ctx.borrower.address, ethers.provider))
    .getLiquidationRiskScore(ctx.borrower.address)) as [bigint, boolean, bigint];

  if (!metadataValid || !liquidatable) {
    throw new Error(
      `seeded borrower did not become liquidatable: borrower=${ctx.borrower.address} orderId=${finalized.orderId.toString()} riskScore=${riskScore.toString()}`,
    );
  }

  return {
    index,
    borrower: ctx.borrower.address,
    orderId: finalized.orderId,
    collateralAsset: ctx.collateralAssetAddr,
    debtAsset: ctx.borrowAssetAddr,
    collateralAmount: seizableAmount,
    debtAmount: reducibleBefore,
    bonus: 0n,
    riskScore,
  } satisfies BatchSeededOrder;
}

async function main() {
  const batchSize = envInt("LIVE_BATCH_LIQUIDATION_SIZE", 3);
  if (batchSize < 2) {
    throw new Error(`LIVE_BATCH_LIQUIDATION_SIZE must be >= 2, got ${batchSize}`);
  }

  const ctx = await createFundsFlowLiveContext({
    label: "Live Batch Liquidation Pressure",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "500",
  });

  await ensureFundsFlowEnvironmentReady(ctx);
  await ensureFundsFlowPrices(ctx);

  const registry = (await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    ctx.registryAddr,
  )) as any;
  const lendingEngineAddr = (await registry.getModuleOrRevert(key("LENDING_ENGINE"))) as string;
  const liquidationRiskViewAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_RISK_VIEW"))) as string;
  const liquidationViewAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_VIEW"))) as string;
  const liquidationManagerAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_MANAGER"))) as string;

  const hasActionLiquidate = (await ctx.acm.hasRole(key("LIQUIDATE"), ctx.relayer.address)) as boolean;
  const hasActionViewPush = (await ctx.acm.hasRole(key("ACTION_VIEW_PUSH"), ctx.relayer.address)) as boolean;
  const hasViewUserData = (await ctx.acm.hasRole(key("VIEW_USER_DATA"), ctx.relayer.address)) as boolean;

  if (!hasActionLiquidate) {
    throw new Error(`relayer ${ctx.relayer.address} lacks LIQUIDATE role required by LiquidationManager.batchLiquidate`);
  }
  if (!hasActionViewPush) {
    throw new Error(`relayer ${ctx.relayer.address} lacks ACTION_VIEW_PUSH role required to seed liquidation risk state`);
  }
  if (!hasViewUserData) {
    throw new Error(`relayer ${ctx.relayer.address} lacks VIEW_USER_DATA role required by batch liquidation risk queries`);
  }

  const lendingEngine = (await ethers.getContractAt(
    [
      "function getDebt(address user,address asset) view returns (uint256)",
      "function getReducibleDebtAmount(address user,address asset) view returns (uint256)",
    ],
    lendingEngineAddr,
  )) as any;
  const healthViewWriter = (await ethers.getContractAt(
    ["function pushRiskStatus(address user,uint256 healthFactorBps,uint256 minHFBps,bool undercollateralized,uint256 blockNumber)"],
    String(ctx.healthView.target),
    ctx.relayer,
  )) as any;
  const liquidationRiskView = (await ethers.getContractAt(
    [
      "function isLiquidatable(address user) view returns (bool,bool,uint256)",
      "function getLiquidationRiskScore(address user) view returns (uint256,bool,uint256)",
      "function batchIsLiquidatable(address[] users) view returns (bool[],bool,uint256)",
      "function batchGetLiquidationRiskScores(address[] users) view returns (uint256[],bool,uint256)",
    ],
    liquidationRiskViewAddr,
    ctx.relayer,
  )) as any;
  const liquidatorView = (await ethers.getContractAt(
    [
      "event DataPushed(bytes32 indexed dataTypeHash, bytes payload)",
      "function getSeizableCollateralAmount(address user,address asset) view returns (uint256,uint256,bool)",
    ],
    liquidationViewAddr,
    ctx.viewer,
  )) as any;
  const liquidationManager = (await ethers.getContractAt(
    [
      "function batchLiquidate(address[] users,address[] collateralAssets,address[] debtAssets,uint256[] collateralAmounts,uint256[] debtAmounts,uint256[] bonuses)",
    ],
    liquidationManagerAddr,
    ctx.relayer,
  )) as any;

  const seeded: BatchSeededOrder[] = [];
  for (let index = 0; index < batchSize; index += 1) {
    seeded.push(await seedLiquidatableOrder(ctx, index, lendingEngine, liquidatorView, healthViewWriter, liquidationRiskView));
  }

  const borrowers = seeded.map((entry) => entry.borrower);
  const collateralAssets = seeded.map((entry) => entry.collateralAsset);
  const debtAssets = seeded.map((entry) => entry.debtAsset);
  const collateralAmounts = seeded.map((entry) => entry.collateralAmount);
  const debtAmounts = seeded.map((entry) => entry.debtAmount);
  const bonuses = seeded.map((entry) => entry.bonus);

  const [batchFlags, batchFlagsValid] = (await liquidationRiskView.batchIsLiquidatable(borrowers)) as [boolean[], boolean, bigint];
  const [batchScores, batchScoresValid] = (await liquidationRiskView.batchGetLiquidationRiskScores(borrowers)) as [bigint[], boolean, bigint];
  if (!batchFlagsValid || !batchScoresValid) {
    throw new Error("batch liquidation risk queries returned invalid metadata");
  }
  if (batchFlags.length !== seeded.length || batchScores.length !== seeded.length) {
    throw new Error(`batch liquidation risk query shape mismatch: flags=${batchFlags.length} scores=${batchScores.length} expected=${seeded.length}`);
  }

  for (let index = 0; index < seeded.length; index += 1) {
    if (!batchFlags[index]) {
      throw new Error(`batchIsLiquidatable returned false for borrower #${index + 1} ${seeded[index].borrower}`);
    }
    if (batchScores[index] !== seeded[index].riskScore) {
      throw new Error(
        `batchGetLiquidationRiskScores mismatch for borrower #${index + 1}: expected=${seeded[index].riskScore.toString()} got=${batchScores[index].toString()}`,
      );
    }
  }

  await liquidationManager.batchLiquidate.staticCall(
    borrowers,
    collateralAssets,
    debtAssets,
    collateralAmounts,
    debtAmounts,
    bonuses,
  );
  const batchEstimate = (await liquidationManager.batchLiquidate.estimateGas(
    borrowers,
    collateralAssets,
    debtAssets,
    collateralAmounts,
    debtAmounts,
    bonuses,
  )) as bigint;
  const batchGasLimit = withGasBuffer(batchEstimate, 13_000n);
  const batchTx = await liquidationManager.batchLiquidate.populateTransaction(
    borrowers,
    collateralAssets,
    debtAssets,
    collateralAmounts,
    debtAmounts,
    bonuses,
  );
  const feeData = await ethers.provider.getFeeData();
  const feePerGas = batchTx.maxFeePerGas ?? batchTx.gasPrice ?? feeData.maxFeePerGas ?? feeData.gasPrice;
  if (!feePerGas || feePerGas <= 0n) {
    throw new Error("unable to determine feePerGas for batchLiquidate relayer reserve");
  }
  const relayerBaseReserve = ethers.parseEther("0.00015");
  await ensureRelayerNativeGasReserve(ctx, `${ctx.label}: batchLiquidate relayer gas reserve`, [
    ctx.borrower,
    ctx.lender,
    ctx.viewer,
    ctx.updater,
  ], {
    desiredBalanceWei: batchGasLimit * feePerGas + relayerBaseReserve,
  });
  const batchReceipt = await (
    await liquidationManager.batchLiquidate(
      borrowers,
      collateralAssets,
      debtAssets,
      collateralAmounts,
      debtAmounts,
      bonuses,
      { gasLimit: batchGasLimit },
    )
  ).wait();

  const dataPushedTopic = liquidatorView.interface.getEvent("DataPushed").topicHash.toLowerCase();
  const parsedPushes = (batchReceipt.logs ?? [])
    .filter(
      (log: any) =>
        String(log.address ?? "").toLowerCase() === liquidationViewAddr.toLowerCase()
        && String(log.topics?.[0] ?? "").toLowerCase() === dataPushedTopic,
    )
    .map((log: any) => liquidatorView.interface.parseLog({ topics: log.topics, data: log.data }));

  const batchUpdatePush = parsedPushes.find(
    (entry: any) => entry && String(entry.args.dataTypeHash ?? entry.args[0]).toLowerCase() === key("LIQUIDATION_BATCH_UPDATE").toLowerCase(),
  ) as any;
  if (!batchUpdatePush) {
    console.log("  [Notice] missing LIQUIDATION_BATCH_UPDATE DataPushed on batchLiquidate receipt; relying on debt reduction and per-order post state");
  } else {
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const decodedBatchPayload = abiCoder.decode(
      [
        "address[]",
        "address[]",
        "address[]",
        "uint256[]",
        "uint256[]",
        "address",
        "uint256[]",
        "uint256",
      ],
      batchUpdatePush.args.payload ?? batchUpdatePush.args[1],
    ) as unknown as [string[], string[], string[], bigint[], bigint[], string, bigint[], bigint];

    const [pushUsers, pushCollateralAssets, pushDebtAssets, pushCollateralAmounts, pushDebtAmounts, pushLiquidator, pushBonuses] = decodedBatchPayload;
    if (pushUsers.length !== seeded.length) {
      throw new Error(`LIQUIDATION_BATCH_UPDATE payload user length mismatch: ${pushUsers.length} vs ${seeded.length}`);
    }
    if (String(pushLiquidator).toLowerCase() !== ctx.relayer.address.toLowerCase()) {
      throw new Error("LIQUIDATION_BATCH_UPDATE liquidator mismatch");
    }

    for (let index = 0; index < seeded.length; index += 1) {
      const item = seeded[index];
      if (String(pushUsers[index]).toLowerCase() !== item.borrower.toLowerCase()) {
        throw new Error(`LIQUIDATION_BATCH_UPDATE borrower mismatch at index ${index}`);
      }
      if (String(pushCollateralAssets[index]).toLowerCase() !== item.collateralAsset.toLowerCase()) {
        throw new Error(`LIQUIDATION_BATCH_UPDATE collateralAsset mismatch at index ${index}`);
      }
      if (String(pushDebtAssets[index]).toLowerCase() !== item.debtAsset.toLowerCase()) {
        throw new Error(`LIQUIDATION_BATCH_UPDATE debtAsset mismatch at index ${index}`);
      }
      if (pushCollateralAmounts[index] !== item.collateralAmount) {
        throw new Error(`LIQUIDATION_BATCH_UPDATE collateralAmount mismatch at index ${index}`);
      }
      if (pushDebtAmounts[index] !== item.debtAmount) {
        throw new Error(`LIQUIDATION_BATCH_UPDATE debtAmount mismatch at index ${index}`);
      }
      if (pushBonuses[index] !== item.bonus) {
        throw new Error(`LIQUIDATION_BATCH_UPDATE bonus mismatch at index ${index}`);
      }
    }
  }

  const payoutPushes = parsedPushes.filter(
    (entry: any) => entry && String(entry.args.dataTypeHash ?? entry.args[0]).toLowerCase() === key("LIQUIDATION_PAYOUT").toLowerCase(),
  );
  if (payoutPushes.length < seeded.length) {
    console.log(
      `  [Notice] LIQUIDATION_PAYOUT pushes after batchLiquidate are incomplete: expected>=${seeded.length} actual=${payoutPushes.length}; relying on post-liquidation debt checks`,
    );
  }

  for (const item of seeded) {
    const debtAfter = (await lendingEngine.getDebt(item.borrower, item.debtAsset)) as bigint;
    if (debtAfter > item.debtAmount) {
      throw new Error(
        `batch liquidation did not reduce debt for borrower=${item.borrower} orderId=${item.orderId.toString()} debtAfter=${debtAfter.toString()} reducibleBefore=${item.debtAmount.toString()}`,
      );
    }
  }

  console.log(
    `  [BatchLiquidation] orders=${seeded.map((entry) => entry.orderId.toString()).join(",")} borrowers=${seeded.map((entry) => entry.borrower).join(",")} gasEstimate=${batchEstimate.toString()} gasLimit=${batchGasLimit.toString()} payoutPushes=${payoutPushes.length}`,
  );
  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);