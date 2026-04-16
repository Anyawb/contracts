import { ethers } from "hardhat";

import {
  createFundsFlowLiveContext,
  depositCollateral,
  ensureFundsFlowEnvironmentReady,
  ensureFundsFlowPrices,
  ensureTokenAllowance,
  fundFundsFlowActors,
} from "../tests/live-test/networks/arbitrum-sepolia/core/_fundsFlowLive";
import { explainRevert, key } from "../tests/live-test/networks/arbitrum-sepolia/core/_mockLiveUtils";

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

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Diagnose Live Blocks Repay",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  await ensureFundsFlowEnvironmentReady(ctx);
  await ensureFundsFlowPrices(ctx);
  await fundFundsFlowActors(ctx, {
    borrowerCollateralAmount: ctx.collateralAmount,
    lenderBorrowAmount: ctx.borrowAmount,
  });

  const registry = (await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    ctx.registryAddr,
  )) as any;
  const [blocksOnlyCoordinatorAddr, blocksOnlyViewAddr, lendingEngineAddr] = (await Promise.all([
    registry.getModuleOrRevert(key("BLOCKS_ONLY_COORDINATOR")),
    registry.getModuleOrRevert(key("BLOCKS_ONLY_VIEW")),
    registry.getModuleOrRevert(key("LENDING_ENGINE")),
  ])) as string[];

  const coordinator = (await ethers.getContractAt(
    [
      "error BlocksOnlyCoordinator__OnlyBorrower()",
      "error BlocksOnlyCoordinator__OrderNotActive(uint256,uint8)",
      "error BlocksOnlyCoordinator__NotMatured(uint256,uint256,uint256)",
      "function getBlocksOnlyOrderCount() view returns (uint256)",
      "function repayBlocks(uint256 orderId,uint256 repayAmount) returns (uint256)",
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
  )) as any;
  const lendingEngine = (await ethers.getContractAt(
    ["function getDebt(address user,address asset) view returns (uint256)"],
    lendingEngineAddr,
  )) as any;
  const vblBlocks = (await ethers.getContractAt(
    [
      "function reserveForLending(address lenderSigner,address asset,uint256 amount,bytes32 lendIntentHash)",
      "function finalizeMatchBlocks((address borrower,address collateralAsset,uint256 collateralAmount,address borrowAsset,uint256 amount,uint256 termBlocks,uint256 rateBps,uint256 expireAt,bytes32 salt),(address lenderSigner,address asset,uint256 amount,uint256 minTermBlocks,uint256 maxTermBlocks,uint256 minRateBps,uint256 expireAt,bytes32 salt)[] lendIntents,bytes sigBorrower,bytes[] sigLenders)",
    ],
    ctx.vblAddr,
  )) as any;

  const currentBlock = BigInt(await ethers.provider.getBlockNumber());
  const borrowIntent = {
    borrower: ctx.borrower.address,
    collateralAsset: ctx.collateralAssetAddr,
    collateralAmount: ctx.collateralAmount,
    borrowAsset: ctx.borrowAssetAddr,
    amount: ctx.borrowAmount,
    termBlocks: 1n,
    rateBps: 0n,
    expireAt: currentBlock + 1_800n,
    salt: ethers.keccak256(ethers.toUtf8Bytes(`diagnose-blocks-borrow-${Date.now()}`)),
  };
  const lendIntent = {
    lenderSigner: ctx.lender.address,
    asset: ctx.borrowAssetAddr,
    amount: ctx.borrowAmount,
    minTermBlocks: 1n,
    maxTermBlocks: 8n,
    minRateBps: 0n,
    expireAt: currentBlock + 1_800n,
    salt: ethers.keccak256(ethers.toUtf8Bytes(`diagnose-blocks-lend-${Date.now()}`)),
  };
  const domain = {
    name: "RwaLending",
    version: "1",
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    verifyingContract: ctx.vblAddr,
  } as const;

  await depositCollateral(ctx, ctx.collateralAmount);
  const lendHash = ethers.TypedDataEncoder.hashStruct("LendIntentBlocks", LEND_INTENT_BLOCKS_TYPES as any, lendIntent);
  const sigBorrower = await ctx.borrower.signTypedData(domain, BORROW_INTENT_BLOCKS_TYPES as any, borrowIntent as any);
  const sigLender = await ctx.lender.signTypedData(domain, LEND_INTENT_BLOCKS_TYPES as any, lendIntent as any);
  const orderId = (await coordinator.getBlocksOnlyOrderCount()) as bigint;

  await (await vblBlocks.connect(ctx.lender).reserveForLending(ctx.lender.address, ctx.borrowAssetAddr, ctx.borrowAmount, lendHash)).wait();
  await (await vblBlocks.connect(ctx.borrower).finalizeMatchBlocks(borrowIntent as any, [lendIntent] as any, sigBorrower, [sigLender])).wait();

  await ensureTokenAllowance(ctx.borrowToken, ctx.borrower, blocksOnlyCoordinatorAddr, ctx.borrowAmount, "borrow asset -> BlocksOnlyCoordinator repay (diagnose)");

  const runtime = (await blocksOnlyView.getBlocksOnlyOrder(orderId)) as any;
  const [borrowerOrderCount, borrowerOrderCountValid] = (await blocksOnlyView.getBorrowerOrderCount(
    ctx.borrower.address,
  )) as [bigint, boolean, bigint];
  const [borrowerOrderIds, borrowerOrderIdsTotal, borrowerOrderIdsValid] = (await blocksOnlyView.getBorrowerOrderIdsPaginated(
    ctx.borrower.address,
    0,
    16,
  )) as [bigint[], bigint, boolean, bigint];
  const debt = (await lendingEngine.getDebt(ctx.borrower.address, ctx.borrowAssetAddr)) as bigint;
  const allowance = (await ctx.borrowToken.allowance(ctx.borrower.address, blocksOnlyCoordinatorAddr)) as bigint;
  const borrowerBalance = (await ctx.borrowToken.balanceOf(ctx.borrower.address)) as bigint;

  console.log("=== Diagnose Live Blocks Repay ===");
  console.log(`orderId=${orderId.toString()}`);
  console.log(`runtime.borrower=${String(runtime.borrower)}`);
  console.log(`runtime.lender=${String(runtime.lender)}`);
  console.log(`runtime.asset=${String(runtime.asset)}`);
  console.log(`runtime.principal=${BigInt(runtime.principal).toString()} repaidPrincipal=${BigInt(runtime.repaidPrincipal).toString()}`);
  console.log(`runtime.status=${BigInt(runtime.status).toString()}`);
  console.log(`runtime.remainingDebt=${BigInt(runtime.remainingDebt).toString()}`);
  console.log(`runtime.isMatured=${String(runtime.isMatured)} isClosed=${String(runtime.isClosed)} canSettleOrLiquidate=${String(runtime.canSettleOrLiquidate)} canCloseTrade=${String(runtime.canCloseTrade)}`);
  console.log(`borrowerOrderCount=${borrowerOrderCount.toString()} valid=${String(borrowerOrderCountValid)} idsTotal=${borrowerOrderIdsTotal.toString()} idsValid=${String(borrowerOrderIdsValid)} ids=${borrowerOrderIds.map((id) => id.toString()).join(",")}`);
  console.log(`borrowerBalance=${borrowerBalance.toString()}`);
  console.log(`allowance=${allowance.toString()}`);
  console.log(`lendingEngineDebt=${debt.toString()}`);

  try {
    const remaining = (await coordinator.connect(ctx.borrower).repayBlocks.staticCall(orderId, ctx.borrowAmount)) as bigint;
    console.log(`repayBlocks.staticCall remainingDebt=${remaining.toString()}`);
  } catch (error: any) {
    console.log(`repayBlocks.staticCall revert=${explainRevert(error, [coordinator.interface, ctx.borrowToken.interface])}`);
    console.log(`raw=${String(error?.shortMessage ?? error?.message ?? error)}`);
  }

  if (debt !== ctx.borrowAmount) {
    try {
      const remaining = (await coordinator.connect(ctx.borrower).repayBlocks.staticCall(orderId, debt)) as bigint;
      console.log(`repayBlocks.staticCall fullDebt(${debt.toString()}) remainingDebt=${remaining.toString()}`);
    } catch (error: any) {
      console.log(`repayBlocks.staticCall fullDebt revert=${explainRevert(error, [coordinator.interface, ctx.borrowToken.interface])}`);
      console.log(`rawFullDebt=${String(error?.shortMessage ?? error?.message ?? error)}`);
    }
  }
}

main().catch((error) => {
  console.error("\n❌ diagnose-live-blocks-repay FAILED\n");
  console.error(error);
  process.exit(1);
});