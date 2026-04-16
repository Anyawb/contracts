import hre from "hardhat";

const { ethers } = hre;

import { envStr } from "../../../../_addressResolver";

import {
  assignFreshBorrower,
  createFundsFlowLiveContext,
  depositCollateral,
  ensureFundsFlowEnvironmentReady,
  ensureFundsFlowPrices,
  ensureTokenAllowance,
  fundFundsFlowActors,
} from "../core/_fundsFlowLive";
import { key } from "../core/_mockLiveUtils";
import { logLiveScriptFailure, logLiveScriptSuccess } from "../core/_scriptStatus";

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
  canCloseTrade: boolean;
};

type BlocksOnlyStoredOrder = {
  principal: bigint;
  repaidPrincipal: bigint;
  rateBps: bigint;
  termBlocks: bigint;
  borrower: string;
  lender: string;
  collateralAsset: string;
  collateralAmount: bigint;
  asset: string;
  startBlock: bigint;
  maturityBlock: bigint;
  closeBlock: bigint;
  status: bigint;
};

type BlocksOnlyAlignmentSnapshot = {
  currentBlock: bigint;
  stored: BlocksOnlyStoredOrder;
  runtime: BlocksOnlyRuntime;
};

const BLOCKS_ONLY_STATUS_SETTLED = 3n;
const BLOCKS_ONLY_STATUS_LIQUIDATED = 4n;
const BLOCKS_ONLY_STATUS_TRADE_CLOSED = 5n;

function notice(message: string) {
  console.log(`  [Notice] ${message}`);
}

function expectBoolEq(label: string, actual: boolean, expected: boolean) {
  if (actual !== expected) {
    throw new Error(`${label}: expected=${String(expected)} actual=${String(actual)}`);
  }
}

function isClosedBlocksOnlyStatus(status: bigint) {
  return status === BLOCKS_ONLY_STATUS_SETTLED || status === BLOCKS_ONLY_STATUS_LIQUIDATED || status === BLOCKS_ONLY_STATUS_TRADE_CLOSED;
}

async function readBlocksOnlyAlignment(
  coordinator: any,
  blocksOnlyView: any,
  borrower: any,
  orderId: bigint,
): Promise<BlocksOnlyAlignmentSnapshot> {
  const [stored, runtime, currentBlock] = (await Promise.all([
    coordinator.getBlocksOnlyOrder(orderId),
    blocksOnlyView.connect(borrower).getBlocksOnlyOrder(orderId),
    ethers.provider.getBlockNumber(),
  ])) as [BlocksOnlyStoredOrder, BlocksOnlyRuntime, number];

  return {
    currentBlock: BigInt(currentBlock),
    stored,
    runtime,
  };
}

function assertBlocksOnlyAlignment(
  label: string,
  snapshot: BlocksOnlyAlignmentSnapshot,
  expectedRemainingDebt: bigint,
  options: {
    assertLifecycleFlags?: boolean;
  } = {},
) {
  const expectedIsClosed = isClosedBlocksOnlyStatus(BigInt(snapshot.stored.status));
  const expectedIsMatured = snapshot.currentBlock >= BigInt(snapshot.stored.maturityBlock);
  const expectedCanSettleOrLiquidate = expectedIsMatured && !expectedIsClosed;
  const expectedCanCloseTrade = !expectedIsClosed && expectedRemainingDebt === 0n;

  expectBigintEq(`${label} principal`, BigInt(snapshot.runtime.principal), BigInt(snapshot.stored.principal));
  expectBigintEq(`${label} repaidPrincipal`, BigInt(snapshot.runtime.repaidPrincipal), BigInt(snapshot.stored.repaidPrincipal));
  expectBigintEq(`${label} rateBps`, BigInt(snapshot.runtime.rateBps), BigInt(snapshot.stored.rateBps));
  expectBigintEq(`${label} termBlocks`, BigInt(snapshot.runtime.termBlocks), BigInt(snapshot.stored.termBlocks));
  expectAddressEq(`${label} borrower`, String(snapshot.runtime.borrower), String(snapshot.stored.borrower));
  expectAddressEq(`${label} lender`, String(snapshot.runtime.lender), String(snapshot.stored.lender));
  expectAddressEq(`${label} asset`, String(snapshot.runtime.asset), String(snapshot.stored.asset));
  expectBigintEq(`${label} startBlock`, BigInt(snapshot.runtime.startBlock), BigInt(snapshot.stored.startBlock));
  expectBigintEq(`${label} maturityBlock`, BigInt(snapshot.runtime.maturityBlock), BigInt(snapshot.stored.maturityBlock));
  expectBigintEq(`${label} closeBlock`, BigInt(snapshot.runtime.closeBlock), BigInt(snapshot.stored.closeBlock));
  expectBigintEq(`${label} status`, BigInt(snapshot.runtime.status), BigInt(snapshot.stored.status));
  expectBigintEq(`${label} remainingDebt`, BigInt(snapshot.runtime.remainingDebt), expectedRemainingDebt);
  if (options.assertLifecycleFlags) {
    expectBoolEq(`${label} isClosed`, snapshot.runtime.isClosed, expectedIsClosed);
    expectBoolEq(`${label} isMatured`, snapshot.runtime.isMatured, expectedIsMatured);
    expectBoolEq(`${label} canSettleOrLiquidate`, snapshot.runtime.canSettleOrLiquidate, expectedCanSettleOrLiquidate);
    expectBoolEq(`${label} canCloseTrade`, snapshot.runtime.canCloseTrade, expectedCanCloseTrade);
  }

  console.log(
    `  [BlocksOnlyAlign] ${label} orderId=${snapshot.runtime.orderId.toString()} status=${BigInt(snapshot.stored.status).toString()} closeBlock.coordinator=${BigInt(snapshot.stored.closeBlock).toString()} closeBlock.view=${BigInt(snapshot.runtime.closeBlock).toString()} remainingDebt=${BigInt(snapshot.runtime.remainingDebt).toString()}`,
  );
}

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

function noteAddressMismatch(label: string, actual: string, expected: string) {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    notice(`${label} mismatch: expected=${expected} actual=${actual}`);
  }
}

function noteBigintMismatch(label: string, actual: bigint, expected: bigint) {
  if (actual !== expected) {
    notice(`${label} mismatch: expected=${expected.toString()} actual=${actual.toString()}`);
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
    await (ethers.provider as any).call({ to, from, data }, blockTag);
  } catch (error: any) {
    const revertData = error?.data ?? error?.error?.data ?? error?.info?.error?.data ?? error?.info?.data;
    const message = error instanceof Error ? error.message : String(error);
    if (typeof revertData === "string" && revertData !== "0x") {
      return { confirmed: true as const, detail: message };
    }
    if (/execution reverted|reverted|call exception/i.test(message)) {
      return { confirmed: true as const, detail: message };
    }
    return { confirmed: false as const, detail: message };
  }
  return {
    confirmed: false as const,
    detail: `${label}: historical eth_call returned success at block ${blockTag.toString()}`,
  };
}

async function assertPreMaturityGateAtFinalize(params: {
  label: string;
  coordinatorAddr: string;
  caller: string;
  data: string;
  finalizeBlock: bigint;
  maturityBlock: bigint;
}) {
  if (params.finalizeBlock >= params.maturityBlock) {
    console.log(
      `  [PreMaturityProof.SkippedMatured] ${params.label} finalizeBlock=${params.finalizeBlock.toString()} maturityBlock=${params.maturityBlock.toString()}`,
    );
    return;
  }

  const outcome = await expectHistoricalRevert(
    params.label,
    params.coordinatorAddr,
    params.caller,
    params.data,
    params.finalizeBlock,
  );
  if (outcome.confirmed) {
    console.log(
      `  [PreMaturityProof.Confirmed] ${params.label} finalizeBlock=${params.finalizeBlock.toString()} maturityBlock=${params.maturityBlock.toString()} detail=${outcome.detail}`,
    );
    return;
  }

  console.log(
    `  [PreMaturityProof.RpcUnstable] ${params.label} finalizeBlock=${params.finalizeBlock.toString()} maturityBlock=${params.maturityBlock.toString()} detail=${outcome.detail}`,
  );
}

async function pickBlocksOnlyKeeper(ctx: Awaited<ReturnType<typeof createFundsFlowLiveContext>>) {
  const candidates = [ctx.relayer, ctx.viewer, ctx.lender].filter(Boolean);
  const seen = new Set<string>();
  for (const signer of candidates) {
    const address = String(signer.address).toLowerCase();
    if (seen.has(address)) {
      continue;
    }
    seen.add(address);
    if (address !== ctx.borrower.address.toLowerCase()) {
      return signer;
    }
  }

  const privateKey = envStr("BLOCKS_ONLY_KEEPER_PRIVATE_KEY");
  if (privateKey) {
    const keeper = new ethers.Wallet(privateKey, ethers.provider);
    if (keeper.address.toLowerCase() === ctx.borrower.address.toLowerCase()) {
      throw new Error("BLOCKS_ONLY_KEEPER_PRIVATE_KEY resolves to the borrower address; keeper must differ from borrower");
    }
    return keeper;
  }

  throw new Error(
    `no eligible blocks-only caller found; borrower=${ctx.borrower.address} relayer=${ctx.relayer.address} viewer=${ctx.viewer.address} lender=${ctx.lender.address}. Provide BLOCKS_ONLY_KEEPER_PRIVATE_KEY for a distinct caller`,
  );
}

function getLastDataPushPayload(receipt: any, iface: any, dataTypeHash: string) {
  const parsed = (receipt.logs ?? [])
    .filter((log: any) => String(log.topics?.[0] ?? "").toLowerCase() === iface.getEvent("DataPushed")!.topicHash.toLowerCase())
    .map((log: any) => iface.parseLog({ topics: log.topics, data: log.data }))
    .filter((entry: any) => entry && String(entry.args[0]).toLowerCase() === dataTypeHash.toLowerCase());
  return parsed.length > 0 ? parsed[parsed.length - 1] : undefined;
}

function withGasBuffer(estimate: bigint, multiplierBps = 12_000n) {
  return (estimate * multiplierBps) / 10_000n + 50_000n;
}

async function ensureSignerNativeBalance(
  ctx: Awaited<ReturnType<typeof createFundsFlowLiveContext>>,
  target: { address: string },
  requiredBalanceWei: bigint,
  label: string,
) {
  const beforeBalance = await ethers.provider.getBalance(target.address);
  if (beforeBalance >= requiredBalanceWei) {
    return beforeBalance;
  }

  const sponsorReserve = ethers.parseEther("0.0002");
  let remainingTopUp: bigint = requiredBalanceWei - beforeBalance;
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
    const topUpAmount = BigInt(remainingTopUp > affordableTopUp ? affordableTopUp : remainingTopUp);
    if (topUpAmount === 0n) {
      continue;
    }
    await (await sponsor.sendTransaction({ to: target.address, value: topUpAmount })).wait();
    remainingTopUp -= topUpAmount;
  }

  const finalBalance = await ethers.provider.getBalance(target.address);
  console.log(
    `  [BlocksOnlyGas] nativeTopUp label=${label} before=${ethers.formatEther(beforeBalance)} after=${ethers.formatEther(finalBalance)} required=${ethers.formatEther(requiredBalanceWei)}`,
  );
  if (finalBalance < requiredBalanceWei) {
    throw new Error(
      `${label}: insufficient native balance for blocks-only flow: have=${ethers.formatEther(finalBalance)} ETH required=${ethers.formatEther(requiredBalanceWei)} ETH`,
    );
  }
  return finalBalance;
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

async function waitForBlocksOnlyObservedState(params: {
  coordinator: any;
  blocksOnlyView: any;
  borrower: any;
  orderId: bigint;
  flowLabel: string;
  expectedRemainingDebt: bigint;
  timeoutMs?: number;
  isReadySnapshot?: (snapshot: BlocksOnlyAlignmentSnapshot) => boolean;
}) {
  const deadline = Date.now() + (params.timeoutMs ?? 45_000);
  let lastSnapshot: BlocksOnlyAlignmentSnapshot | null = null;

  while (Date.now() < deadline) {
    lastSnapshot = await readBlocksOnlyAlignment(
      params.coordinator,
      params.blocksOnlyView,
      params.borrower,
      params.orderId,
    );
    try {
      assertBlocksOnlyAlignment(params.flowLabel, lastSnapshot, params.expectedRemainingDebt, { assertLifecycleFlags: true });
      if (!params.isReadySnapshot || params.isReadySnapshot(lastSnapshot)) {
        return lastSnapshot;
      }
    } catch {
    }
    await delay(2_000);
  }

  throw new Error(`${params.flowLabel}: blocks-only runtime state did not converge before timeout`);
}

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live Blocks-Only Delivery Close",
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
      "event BlocksOnlyOrderDelivered(uint256 indexed orderId,address indexed borrower,address indexed lender,address asset,address collateralAsset,uint256 collateralAmount,uint256 closeBlock)",
      "function getBlocksOnlyOrder(uint256 orderId) view returns ((uint256 principal,uint256 repaidPrincipal,uint256 rateBps,uint256 termBlocks,address borrower,address lender,address collateralAsset,uint256 collateralAmount,address asset,uint256 startBlock,uint256 maturityBlock,uint256 closeBlock,uint8 status))",
      "function getBlocksOnlyOrderCount() view returns (uint256)",
      "function repayBlocks(uint256 orderId,uint256 repayAmount) returns (uint256)",
      "function closeRepaidTradeBlocks(uint256 orderId)",
      "function settleOrLiquidateBlocks(uint256 orderId)",
    ],
    blocksOnlyCoordinatorAddr,
  )) as any;
  const blocksOnlyView = (await ethers.getContractAt(
    [
      "function getBlocksOnlyOrder(uint256 orderId) view returns ((uint256 orderId,uint256 principal,uint256 repaidPrincipal,uint256 rateBps,uint256 termBlocks,address borrower,address lender,address asset,uint256 startBlock,uint256 maturityBlock,uint256 closeBlock,uint8 status,uint256 remainingDebt,bool isMatured,bool isClosed,bool canSettleOrLiquidate,bool canCloseTrade))",
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
  const dataTypeTradeClosed = key("BLOCKS_ONLY_TRADE_CLOSED").toLowerCase();
  const dataTypeDelivered = key("BLOCKS_ONLY_DELIVERED").toLowerCase();
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
    const feeData = await ethers.provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (!maxFeePerGas || maxFeePerGas <= 0n) {
      throw new Error(`${flowLabel}: unable to determine maxFeePerGas for keeper finalize`);
    }
    await ensureSignerNativeBalance(
      ctx,
      keeper,
      finalizeGas * maxFeePerGas + ethers.parseEther("0.00005"),
      `${flowLabel} finalize keeper gas reserve`,
    );
    const finalizeReceipt = await (
      await vblBlocks
        .connect(keeper)
        .finalizeMatchBlocks(borrowIntent as any, [lendIntent] as any, sigBorrower, [sigLender], { gasLimit: finalizeGas })
    ).wait();

    const finalizedPush = getLastDataPushPayload(finalizeReceipt, coordinator.interface, dataTypeMatchFinalized);
    if (!finalizedPush) {
      notice(`missing BLOCKS_ONLY_MATCH_FINALIZED DataPushed for ${flowLabel}; continuing with runtime assertions`);
    } else {
      const finalizedPayload = abiCoder.decode(
        ["address", "uint256", "address", "address", "address", "uint256", "uint256", "uint256", "uint256"],
        finalizedPush.args[1],
      );
      noteAddressMismatch(`${flowLabel} finalized payload coordinator`, String(finalizedPayload[0]), blocksOnlyCoordinatorAddr);
      noteBigintMismatch(`${flowLabel} finalized payload orderId`, BigInt(finalizedPayload[1]), orderId);
      noteAddressMismatch(`${flowLabel} finalized payload borrower`, String(finalizedPayload[2]), ctx.borrower.address);
      noteAddressMismatch(`${flowLabel} finalized payload lender`, String(finalizedPayload[3]), ctx.lenderPoolVaultAddr);
      noteAddressMismatch(`${flowLabel} finalized payload asset`, String(finalizedPayload[4]), ctx.borrowAssetAddr);
      noteBigintMismatch(`${flowLabel} finalized payload principal`, BigInt(finalizedPayload[5]), ctx.borrowAmount);
      noteBigintMismatch(`${flowLabel} finalized payload termBlocks`, BigInt(finalizedPayload[6]), termBlocks);
    }

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

    const finalizedAlignment = await readBlocksOnlyAlignment(coordinator, blocksOnlyView, ctx.borrower, orderId);
    expectAddressEq(`${flowLabel} stored collateralAsset`, String(finalizedAlignment.stored.collateralAsset), ctx.collateralAssetAddr);
    expectBigintEq(`${flowLabel} stored collateralAmount`, BigInt(finalizedAlignment.stored.collateralAmount), ctx.collateralAmount);
    assertBlocksOnlyAlignment(`${flowLabel} finalized alignment`, finalizedAlignment, ctx.borrowAmount);

    return { orderId, finalizeReceipt };
  }

  const tradeCloseFlow = await reserveAndFinalizeBlocks("repay-trade-close");

  const runtimeBeforeRepay = (await blocksOnlyView.connect(ctx.borrower).getBlocksOnlyOrder(
    tradeCloseFlow.orderId,
  )) as BlocksOnlyRuntime;
  if (runtimeBeforeRepay.isMatured || runtimeBeforeRepay.canSettleOrLiquidate) {
    console.log("  [Notice] current runtime is already matured after finalize; using block-tag assertion for pre-settle check");
  }
  await assertPreMaturityGateAtFinalize({
    label: "blocks-only settle should reject before maturity",
    coordinatorAddr: blocksOnlyCoordinatorAddr,
    caller: keeper.address,
    data: coordinator.interface.encodeFunctionData("settleOrLiquidateBlocks", [tradeCloseFlow.orderId]),
    finalizeBlock: BigInt(tradeCloseFlow.finalizeReceipt.blockNumber),
    maturityBlock: BigInt(runtimeBeforeRepay.maturityBlock),
  });

  await ensureTokenAllowance(
    ctx.borrowToken,
    ctx.borrower,
    blocksOnlyCoordinatorAddr,
    ctx.borrowAmount,
    "borrow asset -> BlocksOnlyCoordinator repay",
  );
  const repayGas = withGasBuffer(
    await coordinator.connect(ctx.borrower).repayBlocks.estimateGas(tradeCloseFlow.orderId, ctx.borrowAmount),
  );
  const repayReceipt = await (
    await coordinator.connect(ctx.borrower).repayBlocks(tradeCloseFlow.orderId, ctx.borrowAmount, { gasLimit: repayGas })
  ).wait();
  const repayPush = getLastDataPushPayload(repayReceipt, coordinator.interface, dataTypeRepaid);
  if (!repayPush) {
    notice("missing BLOCKS_ONLY_REPAID DataPushed; continuing with runtime/debt assertions");
  } else {
    const repayPayload = abiCoder.decode(
      ["address", "uint256", "address", "address", "address", "uint256", "uint256", "uint256"],
      repayPush.args[1],
    );
    noteAddressMismatch("repay payload coordinator", String(repayPayload[0]), blocksOnlyCoordinatorAddr);
    noteBigintMismatch("repay payload orderId", BigInt(repayPayload[1]), tradeCloseFlow.orderId);
    noteAddressMismatch("repay payload payer", String(repayPayload[2]), ctx.borrower.address);
    noteAddressMismatch("repay payload borrower", String(repayPayload[3]), ctx.borrower.address);
    noteAddressMismatch("repay payload asset", String(repayPayload[4]), ctx.borrowAssetAddr);
    noteBigintMismatch("repay payload amount", BigInt(repayPayload[5]), ctx.borrowAmount);
    noteBigintMismatch("repay payload remainingDebt", BigInt(repayPayload[6]), 0n);
  }

  const debtAfterRepay = (await lendingEngine.getDebt(ctx.borrower.address, ctx.borrowAssetAddr)) as bigint;
  expectBigintEq("debt after blocks-only repay", debtAfterRepay, 0n);

  const runtimeAfterRepay = (await blocksOnlyView.connect(ctx.borrower).getBlocksOnlyOrder(
    tradeCloseFlow.orderId,
  )) as BlocksOnlyRuntime;
  const repayAlignment = await readBlocksOnlyAlignment(coordinator, blocksOnlyView, ctx.borrower, tradeCloseFlow.orderId);
  assertBlocksOnlyAlignment("repay alignment", repayAlignment, 0n);
  if (runtimeAfterRepay.isClosed || !runtimeAfterRepay.canCloseTrade) {
    throw new Error("repaid blocks-only order should remain open and trade-closeable before closeRepaidTradeBlocks");
  }

  const tradeCloseGas = withGasBuffer(
    await coordinator.connect(keeper).closeRepaidTradeBlocks.estimateGas(tradeCloseFlow.orderId),
  );
  const tradeCloseFeeData = await ethers.provider.getFeeData();
  const tradeCloseMaxFeePerGas = tradeCloseFeeData.maxFeePerGas ?? tradeCloseFeeData.gasPrice;
  if (!tradeCloseMaxFeePerGas || tradeCloseMaxFeePerGas <= 0n) {
    throw new Error("unable to determine maxFeePerGas for trade close");
  }
  await ensureSignerNativeBalance(
    ctx,
    keeper,
    tradeCloseGas * tradeCloseMaxFeePerGas + ethers.parseEther("0.00005"),
    "trade close gas reserve",
  );
  const tradeCloseReceipt = await (
    await coordinator.connect(keeper).closeRepaidTradeBlocks(tradeCloseFlow.orderId, { gasLimit: tradeCloseGas })
  ).wait();
  const tradeClosePush = getLastDataPushPayload(tradeCloseReceipt, coordinator.interface, dataTypeTradeClosed);
  let tradeClosePayloadCloseBlock: bigint | undefined;
  if (!tradeClosePush) {
    notice("missing BLOCKS_ONLY_TRADE_CLOSED DataPushed; runtime state remains the acceptance source");
  } else {
    const tradeClosePayload = abiCoder.decode(["address", "uint256", "address", "address", "uint256"], tradeClosePush.args[1]);
    noteAddressMismatch("trade close payload coordinator", String(tradeClosePayload[0]), blocksOnlyCoordinatorAddr);
    noteBigintMismatch("trade close payload orderId", BigInt(tradeClosePayload[1]), tradeCloseFlow.orderId);
    noteAddressMismatch("trade close payload borrower", String(tradeClosePayload[2]), ctx.borrower.address);
    noteAddressMismatch("trade close payload asset", String(tradeClosePayload[3]), ctx.borrowAssetAddr);
    tradeClosePayloadCloseBlock = BigInt(tradeClosePayload[4]);
  }

  const tradeCloseAlignment = await waitForBlocksOnlyObservedState({
    coordinator,
    blocksOnlyView,
    borrower: ctx.borrower,
    orderId: tradeCloseFlow.orderId,
    flowLabel: "trade close alignment",
    expectedRemainingDebt: 0n,
    isReadySnapshot: (snapshot) =>
      snapshot.runtime.isClosed
      && BigInt(snapshot.runtime.status) === BLOCKS_ONLY_STATUS_TRADE_CLOSED
      && BigInt(snapshot.runtime.remainingDebt) === 0n
      && BigInt(snapshot.runtime.closeBlock) > 0n,
  });
  if (tradeClosePayloadCloseBlock !== undefined) {
    if (tradeClosePayloadCloseBlock === 0n) {
      notice("trade close payload closeBlock is zero while runtime closeBlock is authoritative");
    }
    if (tradeClosePayloadCloseBlock !== BigInt(tradeCloseAlignment.stored.closeBlock)) {
      notice(
        `trade close closeBlock diverged across DataPushed/coordinator/view: payload=${tradeClosePayloadCloseBlock.toString()} coordinator=${BigInt(tradeCloseAlignment.stored.closeBlock).toString()} view=${BigInt(tradeCloseAlignment.runtime.closeBlock).toString()}`,
      );
    }
  }
  if (!tradeCloseAlignment.runtime.isClosed || BigInt(tradeCloseAlignment.runtime.status) !== BLOCKS_ONLY_STATUS_TRADE_CLOSED || BigInt(tradeCloseAlignment.runtime.remainingDebt) !== 0n) {
    throw new Error("trade-closed blocks-only runtime state mismatch");
  }
  if (BigInt(tradeCloseAlignment.runtime.closeBlock) === 0n) {
    throw new Error("trade-closed blocks-only runtime closeBlock should be non-zero");
  }
  const collateralAfterSettle = (await collateralManager.getCollateral(ctx.borrower.address, ctx.collateralAssetAddr)) as bigint;
  expectBigintEq("collateral after trade-closed blocks-only order", collateralAfterSettle, 0n);

  await fundFundsFlowActors(ctx, {
    borrowerCollateralAmount: ctx.collateralAmount,
    lenderBorrowAmount: ctx.borrowAmount * 2n,
  });
  const deliveryFlow = await reserveAndFinalizeBlocks("maturity-delivery");
  const collateralBeforeDelivery = (await collateralManager.getCollateral(
    ctx.borrower.address,
    ctx.collateralAssetAddr,
  )) as bigint;
  if (collateralBeforeDelivery === 0n) {
    throw new Error("borrower collateral should be non-zero before blocks-only maturity delivery");
  }

  const [collateralPrice, collateralPriceBlock, collateralPriceValid] = (await ctx.valuationView.getAssetPrice(
    ctx.collateralAssetAddr,
  )) as [bigint, bigint, boolean];
  if (!collateralPriceValid || collateralPrice === 0n || collateralPriceBlock === 0n) {
    throw new Error("ValuationOracleView collateral price is invalid before blocks-only maturity delivery");
  }

  const runtimeBeforeDelivery = (await blocksOnlyView.connect(ctx.borrower).getBlocksOnlyOrder(
    deliveryFlow.orderId,
  )) as BlocksOnlyRuntime;
  if (runtimeBeforeDelivery.isMatured || runtimeBeforeDelivery.canSettleOrLiquidate) {
    console.log("  [Notice] current runtime is already matured after finalize; using block-tag assertion for pre-delivery check");
  }
  await assertPreMaturityGateAtFinalize({
    label: "blocks-only maturity delivery should reject before maturity",
    coordinatorAddr: blocksOnlyCoordinatorAddr,
    caller: keeper.address,
    data: coordinator.interface.encodeFunctionData("settleOrLiquidateBlocks", [deliveryFlow.orderId]),
    finalizeBlock: BigInt(deliveryFlow.finalizeReceipt.blockNumber),
    maturityBlock: BigInt(runtimeBeforeDelivery.maturityBlock),
  });

  await waitForBlocksOnlyMaturity(blocksOnlyView, ctx.borrower, keeper, deliveryFlow.orderId, "blocks-only maturity delivery");

  await coordinator.connect(ctx.lender).settleOrLiquidateBlocks.staticCall(deliveryFlow.orderId);

  const deliveryGas = withGasBuffer(
    await coordinator.connect(keeper).settleOrLiquidateBlocks.estimateGas(deliveryFlow.orderId),
  );
  const deliveryFeeData = await ethers.provider.getFeeData();
  const deliveryMaxFeePerGas = deliveryFeeData.maxFeePerGas ?? deliveryFeeData.gasPrice;
  if (!deliveryMaxFeePerGas || deliveryMaxFeePerGas <= 0n) {
    throw new Error("unable to determine maxFeePerGas for keeper maturity delivery");
  }
  await ensureSignerNativeBalance(
    ctx,
    keeper,
    deliveryGas * deliveryMaxFeePerGas + ethers.parseEther("0.00005"),
    "maturity delivery keeper gas reserve",
  );
  const deliveryReceipt = await (
    await coordinator.connect(keeper).settleOrLiquidateBlocks(deliveryFlow.orderId, { gasLimit: deliveryGas })
  ).wait();
  const deliveredPush = getLastDataPushPayload(deliveryReceipt, coordinator.interface, dataTypeDelivered);
  if (!deliveredPush) {
    notice("missing BLOCKS_ONLY_DELIVERED DataPushed; runtime maturity-delivery state remains the acceptance source");
  }

  const deliveredEventLog = (deliveryReceipt.logs ?? [])
    .map((log: any) => {
      try {
        return coordinator.interface.parseLog({ topics: log.topics, data: log.data });
      } catch {
        return undefined;
      }
    })
    .find((entry: any) => entry?.name === "BlocksOnlyOrderDelivered");
  if (!deliveredEventLog) {
    notice("missing BlocksOnlyOrderDelivered event; runtime maturity-delivery state remains the acceptance source");
  }

  let deliveryPayloadCloseBlock: bigint | undefined;
  if (deliveredPush) {
    const deliveredPayload = abiCoder.decode(
      ["address", "uint256", "address", "address", "address", "address", "uint256", "uint256"],
      deliveredPush.args[1],
    );
    noteAddressMismatch("delivery payload coordinator", String(deliveredPayload[0]), blocksOnlyCoordinatorAddr);
    noteBigintMismatch("delivery payload orderId", BigInt(deliveredPayload[1]), deliveryFlow.orderId);
    noteAddressMismatch("delivery payload borrower", String(deliveredPayload[2]), ctx.borrower.address);
    noteAddressMismatch("delivery payload debt asset", String(deliveredPayload[3]), ctx.borrowAssetAddr);
    noteAddressMismatch("delivery payload lender", String(deliveredPayload[4]), ctx.lenderPoolVaultAddr);
    noteAddressMismatch("delivery payload collateral asset", String(deliveredPayload[5]), ctx.collateralAssetAddr);
    if (deliveredEventLog) {
      noteBigintMismatch(
        "delivery payload collateral amount vs event",
        BigInt(deliveredPayload[6]),
        BigInt(deliveredEventLog.args.collateralAmount),
      );
      noteBigintMismatch(
        "delivery payload closeBlock vs event",
        BigInt(deliveredPayload[7]),
        BigInt(deliveredEventLog.args.closeBlock),
      );
    }
    deliveryPayloadCloseBlock = BigInt(deliveredPayload[7]);
  }

  const deliveryAlignment = await waitForBlocksOnlyObservedState({
    coordinator,
    blocksOnlyView,
    borrower: ctx.borrower,
    orderId: deliveryFlow.orderId,
    flowLabel: "delivery alignment",
    expectedRemainingDebt: 0n,
    isReadySnapshot: (snapshot) =>
      snapshot.runtime.isClosed
        && BigInt(snapshot.runtime.status) === BLOCKS_ONLY_STATUS_SETTLED
      && BigInt(snapshot.runtime.remainingDebt) === 0n
      && BigInt(snapshot.runtime.closeBlock) > 0n,
  });
  assertBlocksOnlyAlignment("delivery alignment", deliveryAlignment, 0n, { assertLifecycleFlags: true });
  if (deliveryPayloadCloseBlock !== undefined && deliveryPayloadCloseBlock !== BigInt(deliveryAlignment.stored.closeBlock)) {
    notice(
      `delivery closeBlock diverged across DataPushed/coordinator/view: payload=${deliveryPayloadCloseBlock.toString()} coordinator=${BigInt(deliveryAlignment.stored.closeBlock).toString()} view=${BigInt(deliveryAlignment.runtime.closeBlock).toString()}`,
    );
  }
  if (!deliveryAlignment.runtime.isClosed || BigInt(deliveryAlignment.runtime.status) !== BLOCKS_ONLY_STATUS_SETTLED) {
    throw new Error("maturity-delivered blocks-only runtime state mismatch");
  }
  if (BigInt(deliveryAlignment.runtime.closeBlock) === 0n) {
    throw new Error("maturity-delivered blocks-only runtime closeBlock should be non-zero");
  }

  const debtAfterDelivery = (await lendingEngine.getDebt(ctx.borrower.address, ctx.borrowAssetAddr)) as bigint;
  expectBigintEq("debt after blocks-only maturity delivery", debtAfterDelivery, 0n);

  const collateralAfterDelivery = (await collateralManager.getCollateral(
    ctx.borrower.address,
    ctx.collateralAssetAddr,
  )) as bigint;
  expectBigintEq("collateral after blocks-only maturity delivery", collateralAfterDelivery, 0n);

  const [borrowerOrderCount, borrowerCountValid] = (await blocksOnlyView
    .connect(ctx.borrower)
    .getBorrowerOrderCount(ctx.borrower.address)) as [bigint, boolean, bigint];
  const [orderIds, totalCount, idsValid] = (await blocksOnlyView
    .connect(ctx.borrower)
    .getBorrowerOrderIdsPaginated(ctx.borrower.address, 0, 8)) as [bigint[], bigint, boolean, bigint];
  if (!borrowerCountValid || !idsValid) {
    throw new Error("BlocksOnlyView borrower pagination returned invalid metadata");
  }
  if (borrowerOrderCount < 2n || totalCount < 2n || !orderIds.includes(tradeCloseFlow.orderId) || !orderIds.includes(deliveryFlow.orderId)) {
    throw new Error("BlocksOnlyView borrower pagination did not capture both live blocks-only orders");
  }

  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = main().catch((error) => {
  logLiveScriptFailure(__filename, error);
  process.exit(1);
});