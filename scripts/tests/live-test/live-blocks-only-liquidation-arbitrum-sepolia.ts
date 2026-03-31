import { ethers } from "hardhat";

import { envStr } from "../_addressResolver";

import {
  assignFreshBorrower,
  createFundsFlowLiveContext,
  depositCollateral,
  ensureFundsFlowEnvironmentReady,
  ensureFundsFlowPrices,
  ensureTokenAllowance,
  fundFundsFlowActors,
} from "./_fundsFlowLive";
import { key } from "./_mockLiveUtils";

const BORROW_INTENT_BLOCKS_TYPES = {
  BorrowIntentBlocks: [
    { name: "borrower", type: "address" },
    { name: "collateralAsset", type: "address" },
    { name: "collateralAmount", type: "uint256" },
    { name: "borrowAsset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "termBlocks", type: "uint256" },
    { name: "rateBps", type: "uint256" },
    { name: "expireAt", type: "uint256" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

const LEND_INTENT_BLOCKS_TYPES = {
  LendIntentBlocks: [
    { name: "lenderSigner", type: "address" },
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "minTermBlocks", type: "uint256" },
    { name: "maxTermBlocks", type: "uint256" },
    { name: "minRateBps", type: "uint256" },
    { name: "expireAt", type: "uint256" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

type BlocksOnlyRuntime = {
  orderId: bigint;
  principal: bigint;
  repaidPrincipal: bigint;
  rateBps: bigint;
  termBlocks: bigint;
  borrower: string;
  lender: string;
  asset: string;
  startBlock: bigint;
  maturityBlock: bigint;
  closeBlock: bigint;
  status: bigint;
  remainingDebt: bigint;
  isMatured: boolean;
  isClosed: boolean;
  canSettleOrLiquidate: boolean;
};

function expectAddressEq(label: string, actual: string, expected: string) {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label}: expected=${expected} actual=${actual}`);
  }
}

function expectBigintEq(label: string, actual: bigint, expected: bigint) {
  if (actual !== expected) {
    throw new Error(`${label}: expected=${expected.toString()} actual=${actual.toString()}`);
  }
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

async function expectHistoricalRevert(
  label: string,
  to: string,
  from: string,
  data: string,
  blockTag: bigint | number,
) {
  try {
    await ethers.provider.call({ to, from, data }, blockTag);
  } catch {
    console.log(`  [ExpectedRevert] ${label}`);
    return;
  }
  throw new Error(`${label}: expected revert at block ${blockTag.toString()}`);
}

async function pickBlocksOnlyKeeper(ctx: Awaited<ReturnType<typeof createFundsFlowLiveContext>>) {
  const candidates = [ctx.relayer, ctx.viewer, ctx.lender].filter(Boolean);
  const seen = new Set<string>();
  let borrowerAliasKeeper: any = null;
  for (const signer of candidates) {
    const address = String(signer.address).toLowerCase();
    if (seen.has(address)) {
      continue;
    }
    seen.add(address);
    if (!((await ctx.acm.hasRole(key("LIQUIDATE"), signer.address)) as boolean)) {
      continue;
    }
    if (address === ctx.borrower.address.toLowerCase()) {
      borrowerAliasKeeper = signer;
      continue;
    }
    if ((await ctx.acm.hasRole(key("LIQUIDATE"), signer.address)) as boolean) {
      return signer;
    }
  }

  const privateKey = envStr("BLOCKS_ONLY_KEEPER_PRIVATE_KEY");
  if (privateKey) {
    const keeper = new ethers.Wallet(privateKey, ethers.provider);
    if (keeper.address.toLowerCase() === ctx.borrower.address.toLowerCase()) {
      throw new Error("BLOCKS_ONLY_KEEPER_PRIVATE_KEY resolves to the borrower address; keeper must differ from borrower");
    }
    if (!((await ctx.acm.hasRole(key("LIQUIDATE"), keeper.address)) as boolean)) {
      throw new Error(`BLOCKS_ONLY_KEEPER_PRIVATE_KEY address ${keeper.address} lacks LIQUIDATE role required by BlocksOnlyCoordinator`);
    }
    return keeper;
  }

  if (borrowerAliasKeeper) {
    console.log(`  [Notice] no distinct keeper available; reusing borrower-alias signer ${borrowerAliasKeeper.address} for blocks-only keeper flow`);
    return borrowerAliasKeeper;
  }

  throw new Error(
    `no eligible blocks-only keeper found; borrower=${ctx.borrower.address} relayer=${ctx.relayer.address} viewer=${ctx.viewer.address} lender=${ctx.lender.address}. Provide BLOCKS_ONLY_KEEPER_PRIVATE_KEY for a distinct LIQUIDATE-capable keeper`,
  );
}

function getLastDataPushPayload(receipt: any, iface: ethers.Interface, dataTypeHash: string) {
  const parsed = (receipt.logs ?? [])
    .filter((log: any) => String(log.topics?.[0] ?? "").toLowerCase() === iface.getEvent("DataPushed").topicHash.toLowerCase())
    .map((log: any) => iface.parseLog({ topics: log.topics, data: log.data }))
    .filter((entry: any) => entry && String(entry.args[0]).toLowerCase() === dataTypeHash.toLowerCase());
  return parsed.length > 0 ? parsed[parsed.length - 1] : undefined;
}

function withGasBuffer(estimate: bigint, multiplierBps = 12_000n) {
  return (estimate * multiplierBps) / 10_000n + 50_000n;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function advanceLiveBlock(signer: any, label: string) {
  const tx = await signer.sendTransaction({
    to: signer.address,
    value: 0n,
  });
  await tx.wait();
  console.log(`  [AdvanceBlock] ${label} block=${tx.blockNumber ?? "unknown"}`);
}

async function waitForBlocksOnlyMaturity(
  blocksOnlyView: any,
  borrower: any,
  blockDriver: any,
  orderId: bigint,
  flowLabel: string,
  timeoutMs = 90_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runtime = (await blocksOnlyView.connect(borrower).getBlocksOnlyOrder(orderId)) as BlocksOnlyRuntime;
    if (runtime.isMatured || runtime.canSettleOrLiquidate) {
      return runtime;
    }
    const currentBlock = BigInt(await ethers.provider.getBlockNumber());
    if (currentBlock < BigInt(runtime.maturityBlock)) {
      await advanceLiveBlock(blockDriver, `${flowLabel} maturity-wait`);
      continue;
    }
    await delay(2_000);
  }
  throw new Error(`${flowLabel}: blocks-only order did not mature within ${timeoutMs}ms`);
}

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live Blocks-Only Liquidation",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  await assignFreshBorrower(ctx, { noticeLabel: "using fresh blocks-only borrower" });

  await ensureFundsFlowEnvironmentReady(ctx);
  await ensureFundsFlowPrices(ctx);
  const keeper = await pickBlocksOnlyKeeper(ctx);

  await fundFundsFlowActors(ctx, {
    borrowerCollateralAmount: ctx.collateralAmount,
    lenderBorrowAmount: ctx.borrowAmount * 2n,
  });

  const registry = (await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)", "function getModule(bytes32) view returns (address)"],
    ctx.registryAddr,
  )) as any;

  const [blocksOnlyCoordinatorAddr, blocksOnlyViewAddr, collateralManagerAddr, lendingEngineAddr] = (await Promise.all([
    registry.getModuleOrRevert(key("BLOCKS_ONLY_COORDINATOR")),
    registry.getModuleOrRevert(key("BLOCKS_ONLY_VIEW")),
    registry.getModuleOrRevert(key("COLLATERAL_MANAGER")),
    registry.getModuleOrRevert(key("LENDING_ENGINE")),
  ])) as string[];

  const vblBlocks = (await ethers.getContractAt(
    [
      "function reserveForLending(address lenderSigner,address asset,uint256 amount,bytes32 lendIntentHash)",
      "function finalizeMatchBlocks((address borrower,address collateralAsset,uint256 collateralAmount,address borrowAsset,uint256 amount,uint256 termBlocks,uint256 rateBps,uint256 expireAt,bytes32 salt),(address lenderSigner,address asset,uint256 amount,uint256 minTermBlocks,uint256 maxTermBlocks,uint256 minRateBps,uint256 expireAt,bytes32 salt)[] lendIntents,bytes sigBorrower,bytes[] sigLenders)",
    ],
    ctx.vblAddr,
  )) as any;
  const coordinator = (await ethers.getContractAt(
    [
      "event DataPushed(bytes32 indexed dataTypeHash, bytes payload)",
      "event BlocksOnlyOrderLiquidated(uint256 indexed orderId,address indexed borrower,address indexed liquidator,address asset,address collateralAsset,uint256 collateralAmount,uint256 debtAmount,uint256 closeBlock)",
      "function getBlocksOnlyOrderCount() view returns (uint256)",
      "function repayBlocks(uint256 orderId,uint256 repayAmount) returns (uint256)",
      "function settleOrLiquidateBlocks(uint256 orderId)",
    ],
    blocksOnlyCoordinatorAddr,
  )) as any;
  const blocksOnlyView = (await ethers.getContractAt(
    [
      "function getBlocksOnlyOrder(uint256 orderId) view returns ((uint256 orderId,uint256 principal,uint256 repaidPrincipal,uint256 rateBps,uint256 termBlocks,address borrower,address lender,address asset,uint256 startBlock,uint256 maturityBlock,uint256 closeBlock,uint8 status,uint256 remainingDebt,bool isMatured,bool isClosed,bool canSettleOrLiquidate))",
      "function getBorrowerOrderCount(address borrower) view returns (uint256,bool,uint256)",
      "function getBorrowerOrderIdsPaginated(address borrower,uint256 offset,uint256 limit) view returns (uint256[] memory,uint256,bool,uint256)",
    ],
    blocksOnlyViewAddr,
    ctx.viewer,
  )) as any;
  const collateralManager = (await ethers.getContractAt(
    ["function getCollateral(address user,address asset) view returns (uint256)"],
    collateralManagerAddr,
  )) as any;
  const lendingEngine = (await ethers.getContractAt(
    ["function getDebt(address user,address asset) view returns (uint256)"],
    lendingEngineAddr,
  )) as any;

  const dataTypeMatchFinalized = key("BLOCKS_ONLY_MATCH_FINALIZED").toLowerCase();
  const dataTypeRepaid = key("BLOCKS_ONLY_REPAID").toLowerCase();
  const dataTypeSettled = key("BLOCKS_ONLY_SETTLED").toLowerCase();
  const dataTypeLiquidated = key("BLOCKS_ONLY_LIQUIDATED").toLowerCase();
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const domain = {
    name: "RwaLending",
    version: "1",
    chainId,
    verifyingContract: ctx.vblAddr,
  } as const;

  async function reserveAndFinalizeBlocks(flowLabel: string, termBlocks = 1n) {
    await depositCollateral(ctx, ctx.collateralAmount);
    await ensureTokenAllowance(ctx.borrowToken, ctx.lender, ctx.vblAddr, ctx.borrowAmount, `borrow asset -> VBL (${flowLabel})`);

    const currentBlock = BigInt(await ethers.provider.getBlockNumber());
    const borrowIntent = {
      borrower: ctx.borrower.address,
      collateralAsset: ctx.collateralAssetAddr,
      collateralAmount: ctx.collateralAmount,
      borrowAsset: ctx.borrowAssetAddr,
      amount: ctx.borrowAmount,
      termBlocks,
      rateBps: 0n,
      expireAt: currentBlock + 1_800n,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`${ctx.label}-${flowLabel}-borrow-${Date.now()}`)),
    };
    const lendIntent = {
      lenderSigner: ctx.lender.address,
      asset: ctx.borrowAssetAddr,
      amount: ctx.borrowAmount,
      minTermBlocks: termBlocks,
      maxTermBlocks: 8n,
      minRateBps: 0n,
      expireAt: currentBlock + 1_800n,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`${ctx.label}-${flowLabel}-lend-${Date.now()}`)),
    };
    const lendHash = ethers.TypedDataEncoder.hashStruct(
      "LendIntentBlocks",
      LEND_INTENT_BLOCKS_TYPES as any,
      lendIntent,
    );
    const sigBorrower = await ctx.borrower.signTypedData(domain, BORROW_INTENT_BLOCKS_TYPES as any, borrowIntent as any);
    const sigLender = await ctx.lender.signTypedData(domain, LEND_INTENT_BLOCKS_TYPES as any, lendIntent as any);
    const orderId = (await coordinator.getBlocksOnlyOrderCount()) as bigint;

    await (await vblBlocks.connect(ctx.lender).reserveForLending(ctx.lender.address, ctx.borrowAssetAddr, ctx.borrowAmount, lendHash)).wait();
    await vblBlocks
      .connect(keeper)
      .finalizeMatchBlocks.staticCall(borrowIntent as any, [lendIntent] as any, sigBorrower, [sigLender]);
    const finalizeGas = withGasBuffer(
      await vblBlocks.connect(keeper).finalizeMatchBlocks.estimateGas(
        borrowIntent as any,
        [lendIntent] as any,
        sigBorrower,
        [sigLender],
      ),
    );
    const finalizeReceipt = await (
      await vblBlocks
        .connect(keeper)
        .finalizeMatchBlocks(borrowIntent as any, [lendIntent] as any, sigBorrower, [sigLender], { gasLimit: finalizeGas })
    ).wait();

    const finalizedPush = getLastDataPushPayload(finalizeReceipt, coordinator.interface, dataTypeMatchFinalized);
    if (!finalizedPush) {
      throw new Error(`missing BLOCKS_ONLY_MATCH_FINALIZED DataPushed for ${flowLabel}`);
    }
    const finalizedPayload = abiCoder.decode(
      ["address", "uint256", "address", "address", "address", "uint256", "uint256", "uint256", "uint256"],
      finalizedPush.args[1],
    );
    expectAddressEq(`${flowLabel} finalized coordinator`, String(finalizedPayload[0]), blocksOnlyCoordinatorAddr);
    expectBigintEq(`${flowLabel} finalized orderId`, BigInt(finalizedPayload[1]), orderId);
    expectAddressEq(`${flowLabel} finalized borrower`, String(finalizedPayload[2]), ctx.borrower.address);
    expectAddressEq(`${flowLabel} finalized lender`, String(finalizedPayload[3]), ctx.lenderPoolVaultAddr);
    expectAddressEq(`${flowLabel} finalized asset`, String(finalizedPayload[4]), ctx.borrowAssetAddr);
    expectBigintEq(`${flowLabel} finalized principal`, BigInt(finalizedPayload[5]), ctx.borrowAmount);
    expectBigintEq(`${flowLabel} finalized termBlocks`, BigInt(finalizedPayload[6]), termBlocks);

    const runtime = (await blocksOnlyView.connect(ctx.borrower).getBlocksOnlyOrder(orderId)) as BlocksOnlyRuntime;
    expectBigintEq(`${flowLabel} runtime orderId`, BigInt(runtime.orderId), orderId);
    expectBigintEq(`${flowLabel} runtime principal`, BigInt(runtime.principal), ctx.borrowAmount);
    expectAddressEq(`${flowLabel} runtime borrower`, String(runtime.borrower), ctx.borrower.address);
    expectAddressEq(`${flowLabel} runtime lender`, String(runtime.lender), ctx.lenderPoolVaultAddr);
    expectAddressEq(`${flowLabel} runtime asset`, String(runtime.asset), ctx.borrowAssetAddr);
    expectBigintEq(`${flowLabel} runtime remainingDebt`, BigInt(runtime.remainingDebt), ctx.borrowAmount);
    if (runtime.isClosed) {
      throw new Error(`${flowLabel}: freshly finalized blocks-only order is unexpectedly closed`);
    }

    return { orderId, finalizeReceipt };
  }

  const settleFlow = await reserveAndFinalizeBlocks("repay-settle");

  const runtimeBeforeRepay = (await blocksOnlyView.connect(ctx.borrower).getBlocksOnlyOrder(
    settleFlow.orderId,
  )) as BlocksOnlyRuntime;
  if (runtimeBeforeRepay.isMatured || runtimeBeforeRepay.canSettleOrLiquidate) {
    console.log("  [Notice] current runtime is already matured after finalize; using historical block-tag assertion for pre-settle check");
  }
  await expectHistoricalRevert(
    "blocks-only settle should reject before maturity",
    blocksOnlyCoordinatorAddr,
    keeper.address,
    coordinator.interface.encodeFunctionData("settleOrLiquidateBlocks", [settleFlow.orderId]),
    BigInt(settleFlow.finalizeReceipt.blockNumber),
  );

  await ensureTokenAllowance(
    ctx.borrowToken,
    ctx.borrower,
    blocksOnlyCoordinatorAddr,
    ctx.borrowAmount,
    "borrow asset -> BlocksOnlyCoordinator repay",
  );
  const repayGas = withGasBuffer(
    await coordinator.connect(ctx.borrower).repayBlocks.estimateGas(settleFlow.orderId, ctx.borrowAmount),
  );
  const repayReceipt = await (
    await coordinator.connect(ctx.borrower).repayBlocks(settleFlow.orderId, ctx.borrowAmount, { gasLimit: repayGas })
  ).wait();
  const repayPush = getLastDataPushPayload(repayReceipt, coordinator.interface, dataTypeRepaid);
  if (!repayPush) {
    throw new Error("missing BLOCKS_ONLY_REPAID DataPushed");
  }
  const repayPayload = abiCoder.decode(
    ["address", "uint256", "address", "address", "address", "uint256", "uint256", "uint256"],
    repayPush.args[1],
  );
  expectAddressEq("repay payload coordinator", String(repayPayload[0]), blocksOnlyCoordinatorAddr);
  expectBigintEq("repay payload orderId", BigInt(repayPayload[1]), settleFlow.orderId);
  expectAddressEq("repay payload payer", String(repayPayload[2]), ctx.borrower.address);
  expectAddressEq("repay payload borrower", String(repayPayload[3]), ctx.borrower.address);
  expectAddressEq("repay payload asset", String(repayPayload[4]), ctx.borrowAssetAddr);
  expectBigintEq("repay payload amount", BigInt(repayPayload[5]), ctx.borrowAmount);
  expectBigintEq("repay payload remainingDebt", BigInt(repayPayload[6]), 0n);

  const debtAfterRepay = (await lendingEngine.getDebt(ctx.borrower.address, ctx.borrowAssetAddr)) as bigint;
  expectBigintEq("debt after blocks-only repay", debtAfterRepay, 0n);

  const runtimeAfterRepay = (await blocksOnlyView.connect(ctx.borrower).getBlocksOnlyOrder(
    settleFlow.orderId,
  )) as BlocksOnlyRuntime;
  if (!runtimeAfterRepay.isMatured || !runtimeAfterRepay.canSettleOrLiquidate || runtimeAfterRepay.isClosed) {
    await waitForBlocksOnlyMaturity(blocksOnlyView, ctx.borrower, keeper, settleFlow.orderId, "repaid blocks-only settle");
  }

  await expectRevert("unauthorized blocks-only settle should reject", async () => {
    await coordinator.connect(ctx.lender).settleOrLiquidateBlocks.staticCall(settleFlow.orderId);
  });

  const settleGas = withGasBuffer(
    await coordinator.connect(keeper).settleOrLiquidateBlocks.estimateGas(settleFlow.orderId),
  );
  const settleReceipt = await (
    await coordinator.connect(keeper).settleOrLiquidateBlocks(settleFlow.orderId, { gasLimit: settleGas })
  ).wait();
  const settlePush = getLastDataPushPayload(settleReceipt, coordinator.interface, dataTypeSettled);
  if (!settlePush) {
    throw new Error("missing BLOCKS_ONLY_SETTLED DataPushed");
  }
  const settlePayload = abiCoder.decode(["address", "uint256", "address", "address", "uint256"], settlePush.args[1]);
  expectAddressEq("settle payload coordinator", String(settlePayload[0]), blocksOnlyCoordinatorAddr);
  expectBigintEq("settle payload orderId", BigInt(settlePayload[1]), settleFlow.orderId);
  expectAddressEq("settle payload borrower", String(settlePayload[2]), ctx.borrower.address);
  expectAddressEq("settle payload asset", String(settlePayload[3]), ctx.borrowAssetAddr);
  if (BigInt(settlePayload[4]) === 0n) {
    throw new Error("settle payload closeBlock should be non-zero");
  }

  const runtimeAfterSettle = (await blocksOnlyView.connect(ctx.borrower).getBlocksOnlyOrder(
    settleFlow.orderId,
  )) as BlocksOnlyRuntime;
  expectBigintEq("settle payload closeBlock", BigInt(settlePayload[4]), BigInt(runtimeAfterSettle.closeBlock));
  if (!runtimeAfterSettle.isClosed || BigInt(runtimeAfterSettle.status) !== 3n || BigInt(runtimeAfterSettle.remainingDebt) !== 0n) {
    throw new Error("settled blocks-only runtime state mismatch");
  }
  const collateralAfterSettle = (await collateralManager.getCollateral(ctx.borrower.address, ctx.collateralAssetAddr)) as bigint;
  expectBigintEq("collateral after settled blocks-only order", collateralAfterSettle, 0n);

  const liquidationFlow = await reserveAndFinalizeBlocks("liquidation");
  const collateralBeforeLiquidation = (await collateralManager.getCollateral(
    ctx.borrower.address,
    ctx.collateralAssetAddr,
  )) as bigint;
  if (collateralBeforeLiquidation === 0n) {
    throw new Error("borrower collateral should be non-zero before blocks-only liquidation");
  }

  const [collateralPrice, collateralPriceBlock, collateralPriceValid] = (await ctx.valuationView.getAssetPrice(
    ctx.collateralAssetAddr,
  )) as [bigint, bigint, boolean];
  if (!collateralPriceValid || collateralPrice === 0n || collateralPriceBlock === 0n) {
    throw new Error("ValuationOracleView collateral price is invalid before blocks-only liquidation");
  }

  const runtimeBeforeLiquidation = (await blocksOnlyView.connect(ctx.borrower).getBlocksOnlyOrder(
    liquidationFlow.orderId,
  )) as BlocksOnlyRuntime;
  if (runtimeBeforeLiquidation.isMatured || runtimeBeforeLiquidation.canSettleOrLiquidate) {
    console.log("  [Notice] current runtime is already matured after finalize; using historical block-tag assertion for pre-liquidation check");
  }
  await expectHistoricalRevert(
    "blocks-only liquidation should reject before maturity",
    blocksOnlyCoordinatorAddr,
    keeper.address,
    coordinator.interface.encodeFunctionData("settleOrLiquidateBlocks", [liquidationFlow.orderId]),
    BigInt(liquidationFlow.finalizeReceipt.blockNumber),
  );

  await waitForBlocksOnlyMaturity(blocksOnlyView, ctx.borrower, keeper, liquidationFlow.orderId, "blocks-only liquidation");

  const liquidationGas = withGasBuffer(
    await coordinator.connect(keeper).settleOrLiquidateBlocks.estimateGas(liquidationFlow.orderId),
  );
  const liquidationReceipt = await (
    await coordinator.connect(keeper).settleOrLiquidateBlocks(liquidationFlow.orderId, { gasLimit: liquidationGas })
  ).wait();
  const liquidationPush = getLastDataPushPayload(liquidationReceipt, coordinator.interface, dataTypeLiquidated);
  if (!liquidationPush) {
    throw new Error("missing BLOCKS_ONLY_LIQUIDATED DataPushed");
  }

  const liquidatedEventLog = (liquidationReceipt.logs ?? [])
    .map((log: any) => {
      try {
        return coordinator.interface.parseLog({ topics: log.topics, data: log.data });
      } catch {
        return undefined;
      }
    })
    .find((entry: any) => entry?.name === "BlocksOnlyOrderLiquidated");
  if (!liquidatedEventLog) {
    throw new Error("missing BlocksOnlyOrderLiquidated event");
  }

  const liquidationPayload = abiCoder.decode(
    ["address", "uint256", "address", "address", "address", "address", "uint256", "uint256", "uint256"],
    liquidationPush.args[1],
  );
  expectAddressEq("liquidation payload coordinator", String(liquidationPayload[0]), blocksOnlyCoordinatorAddr);
  expectBigintEq("liquidation payload orderId", BigInt(liquidationPayload[1]), liquidationFlow.orderId);
  expectAddressEq("liquidation payload borrower", String(liquidationPayload[2]), ctx.borrower.address);
  expectAddressEq("liquidation payload debt asset", String(liquidationPayload[3]), ctx.borrowAssetAddr);
  expectAddressEq("liquidation payload liquidator", String(liquidationPayload[4]), keeper.address);
  expectAddressEq("liquidation payload collateral asset", String(liquidationPayload[5]), ctx.collateralAssetAddr);
  expectBigintEq(
    "liquidation payload collateral amount vs event",
    BigInt(liquidationPayload[6]),
    BigInt(liquidatedEventLog.args.collateralAmount),
  );
  expectBigintEq(
    "liquidation payload debt amount vs event",
    BigInt(liquidationPayload[7]),
    BigInt(liquidatedEventLog.args.debtAmount),
  );
  expectBigintEq(
    "liquidation payload closeBlock vs event",
    BigInt(liquidationPayload[8]),
    BigInt(liquidatedEventLog.args.closeBlock),
  );

  const runtimeAfterLiquidation = (await blocksOnlyView.connect(ctx.borrower).getBlocksOnlyOrder(
    liquidationFlow.orderId,
  )) as BlocksOnlyRuntime;
  if (!runtimeAfterLiquidation.isClosed || BigInt(runtimeAfterLiquidation.status) !== 4n) {
    throw new Error("liquidated blocks-only runtime state mismatch");
  }

  const debtAfterLiquidation = (await lendingEngine.getDebt(ctx.borrower.address, ctx.borrowAssetAddr)) as bigint;
  expectBigintEq("debt after blocks-only liquidation", debtAfterLiquidation, 0n);

  const collateralAfterLiquidation = (await collateralManager.getCollateral(
    ctx.borrower.address,
    ctx.collateralAssetAddr,
  )) as bigint;
  if (collateralAfterLiquidation >= collateralBeforeLiquidation) {
    throw new Error(
      `blocks-only liquidation did not reduce collateral: before=${collateralBeforeLiquidation.toString()} after=${collateralAfterLiquidation.toString()}`,
    );
  }

  const [borrowerOrderCount, borrowerCountValid] = (await blocksOnlyView
    .connect(ctx.borrower)
    .getBorrowerOrderCount(ctx.borrower.address)) as [bigint, boolean, bigint];
  const [orderIds, totalCount, idsValid] = (await blocksOnlyView
    .connect(ctx.borrower)
    .getBorrowerOrderIdsPaginated(ctx.borrower.address, 0, 8)) as [bigint[], bigint, boolean, bigint];
  if (!borrowerCountValid || !idsValid) {
    throw new Error("BlocksOnlyView borrower pagination returned invalid metadata");
  }
  if (borrowerOrderCount < 2n || totalCount < 2n || !orderIds.includes(settleFlow.orderId) || !orderIds.includes(liquidationFlow.orderId)) {
    throw new Error("BlocksOnlyView borrower pagination did not capture both live blocks-only orders");
  }

  console.log("\n✅ live-blocks-only-liquidation-arbitrum-sepolia PASSED\n");
}

main().catch((error) => {
  console.error("\n❌ live-blocks-only-liquidation-arbitrum-sepolia FAILED\n");
  console.error(error);
  process.exit(1);
});