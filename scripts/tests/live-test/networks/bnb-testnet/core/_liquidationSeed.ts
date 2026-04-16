import fs from "fs";

import { ethers } from "hardhat";

import {
  assignFreshBorrower,
  createFundsFlowLiveContext,
  depositCollateral,
  ensureFundsFlowEnvironmentReady,
  ensureFundsFlowPrices,
  finalizeSingleMatch,
  fundFundsFlowActors,
  getOrderForView,
  reserveForLending,
} from "./_fundsFlowLive";
import { key } from "./_mockLiveUtils";

export type SeededLiquidationOrder = {
  orderId: bigint;
  borrower: string;
  maturity: bigint;
  currentBlock: bigint;
  riskScore: bigint;
  acceptRiskTriggeredOrder: boolean;
  source: string;
};

function withGasBuffer(estimate: bigint, multiplierBps = 12_000n) {
  return (estimate * multiplierBps) / 10_000n + 50_000n;
}

function extractRequiredValue(content: string, keyName: string, source: string) {
  const matches = [...content.matchAll(new RegExp(`^${keyName}=(.+)$`, "gm"))];
  const rawValue = matches.at(-1)?.[1]?.trim();
  if (!rawValue) {
    throw new Error(`missing ${keyName} in ${source}`);
  }
  return rawValue;
}

export function parseSeededLiquidationLog(content: string, source = "seed log"): SeededLiquidationOrder {
  return {
    orderId: BigInt(extractRequiredValue(content, "SEEDED_LIQUIDATION_ORDER_ID", source)),
    borrower: extractRequiredValue(content, "SEEDED_LIQUIDATION_BORROWER", source),
    maturity: BigInt(extractRequiredValue(content, "SEEDED_LIQUIDATION_MATURITY", source)),
    currentBlock: BigInt(extractRequiredValue(content, "SEEDED_LIQUIDATION_CURRENT_BLOCK", source)),
    riskScore: BigInt(extractRequiredValue(content, "SEEDED_LIQUIDATION_RISK_SCORE", source)),
    acceptRiskTriggeredOrder:
      extractRequiredValue(content, "SEEDED_LIQUIDATION_ACCEPT_RISK_TRIGGERED_ORDER", source) === "1",
    source,
  };
}

export function readSeededLiquidationLog(logFile: string): SeededLiquidationOrder {
  const content = fs.readFileSync(logFile, "utf8");
  return parseSeededLiquidationLog(content, logFile);
}

async function ensureNativeTopUp(params: {
  ctx: Awaited<ReturnType<typeof createFundsFlowLiveContext>>;
  target: any;
  desiredBalanceWei: bigint;
  reserveWei: bigint;
  label: string;
}) {
  const beforeBalance = await ethers.provider.getBalance(params.target.address);
  if (beforeBalance >= params.desiredBalanceWei) {
    return beforeBalance;
  }

  const requiredTopUp = params.desiredBalanceWei - beforeBalance;
  const seenSponsors = new Set<string>();
  const sponsors = [params.ctx.lender, params.ctx.viewer, params.ctx.updater].filter((signer): signer is NonNullable<typeof signer> => {
    if (!signer?.address) {
      return false;
    }
    const signerKey = signer.address.toLowerCase();
    if (signerKey === params.target.address.toLowerCase() || seenSponsors.has(signerKey)) {
      return false;
    }
    seenSponsors.add(signerKey);
    return true;
  });

  let remainingTopUp = requiredTopUp;
  for (const sponsor of sponsors) {
    if (remainingTopUp === 0n) {
      break;
    }
    const sponsorBalance = await ethers.provider.getBalance(sponsor.address);
    const affordableTopUp = sponsorBalance > params.reserveWei ? sponsorBalance - params.reserveWei : 0n;
    const topUpAmount = remainingTopUp > affordableTopUp ? affordableTopUp : remainingTopUp;
    if (topUpAmount === 0n) {
      continue;
    }
    await (await sponsor.sendTransaction({ to: params.target.address, value: topUpAmount })).wait();
    remainingTopUp -= topUpAmount;
  }

  const finalBalance = await ethers.provider.getBalance(params.target.address);
  if (finalBalance < params.desiredBalanceWei) {
    throw new Error(
      `${params.label} native top-up insufficient: desired=${ethers.formatEther(params.desiredBalanceWei)} actual=${ethers.formatEther(finalBalance)} reserve=${ethers.formatEther(params.reserveWei)}`,
    );
  }
  return finalBalance;
}

export async function seedLiquidatableOrder(params: {
  label?: string;
  noticeLabel?: string;
  collateralAmountUnitsDefault?: string;
  borrowAmountUnitsDefault?: string;
} = {}): Promise<SeededLiquidationOrder> {
  const ctx = await createFundsFlowLiveContext({
    label: params.label ?? "Seed Liquidatable Order",
    collateralAmountUnitsDefault: params.collateralAmountUnitsDefault ?? "10",
    borrowAmountUnitsDefault: params.borrowAmountUnitsDefault ?? "500",
  });

  await assignFreshBorrower(ctx, {
    noticeLabel: params.noticeLabel ?? "using fresh seeded liquidation borrower",
  });
  await ensureNativeTopUp({
    ctx,
    target: ctx.relayer,
    desiredBalanceWei: ethers.parseEther("0.0002"),
    reserveWei: ethers.parseEther("0.00001"),
    label: "relayer",
  });
  await ensureFundsFlowEnvironmentReady(ctx);
  await ensureFundsFlowPrices(ctx);

  const actionViewPushRole = key("ACTION_VIEW_PUSH");
  const hasActionLiquidate = (await ctx.acm.hasRole(key("LIQUIDATE"), ctx.relayer.address)) as boolean;
  let hasActionViewPush = (await ctx.acm.hasRole(actionViewPushRole, ctx.relayer.address)) as boolean;
  if (!hasActionLiquidate) {
    throw new Error(`relayer ${ctx.relayer.address} lacks LIQUIDATE role required by SettlementManager`);
  }
  if (!hasActionViewPush) {
    try {
      await (await ctx.acm.connect(ctx.relayer).grantRole(actionViewPushRole, ctx.relayer.address)).wait();
      hasActionViewPush = (await ctx.acm.hasRole(actionViewPushRole, ctx.relayer.address)) as boolean;
    } catch {
      // fall through to explicit failure below
    }
  }
  if (!hasActionViewPush) {
    throw new Error(`relayer ${ctx.relayer.address} lacks ACTION_VIEW_PUSH role required to seed mock liquidation risk state`);
  }

  const requiredModuleRoles = [
    { role: key("ORDER_CREATE"), account: ctx.vblAddr, label: "VaultBusinessLogic ORDER_CREATE" },
    { role: key("DEPOSIT"), account: ctx.vblAddr, label: "VaultBusinessLogic DEPOSIT" },
    { role: key("BORROW"), account: ctx.orderEngineAddr, label: "OrderEngine BORROW" },
  ];
  for (const required of requiredModuleRoles) {
    let granted = (await ctx.acm.hasRole(required.role, required.account)) as boolean;
    if (!granted) {
      try {
        await (await ctx.acm.connect(ctx.relayer).grantRole(required.role, required.account)).wait();
        granted = (await ctx.acm.hasRole(required.role, required.account)) as boolean;
      } catch {
        // fall through to explicit failure below
      }
    }
    if (!granted) {
      throw new Error(`missing required module role for seed flow: ${required.label} account=${required.account}`);
    }
  }

  await fundFundsFlowActors(ctx, {
    borrowerBorrowAmount: ctx.totalDue + ctx.interest,
    borrowerCollateralAmount: ctx.collateralAmount,
    lenderBorrowAmount: ctx.borrowAmount,
  });
  await depositCollateral(ctx, ctx.collateralAmount);
  const reserve = await reserveForLending(ctx);
  const finalized = await finalizeSingleMatch(ctx, reserve);
  const order = await getOrderForView(ctx, finalized.orderId);

  const registry = (await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    ctx.registryAddr,
  )) as any;
  const lendingEngineAddr = (await registry.getModuleOrRevert(key("LENDING_ENGINE"))) as string;
  const liquidationRiskViewAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_RISK_VIEW"))) as string;
  const settlementManagerAddr = ctx.settlementManagerAddr;

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
    ],
    liquidationRiskViewAddr,
    ctx.viewer,
  )) as any;
  const settlementManager = (await ethers.getContractAt(
    ["function settleOrLiquidate(uint256 orderId)"],
    settlementManagerAddr,
    ctx.relayer,
  )) as any;

  const debt = (await lendingEngine.getDebt(ctx.borrower.address, ctx.borrowAssetAddr)) as bigint;
  const reducibleDebt = (await lendingEngine.getReducibleDebtAmount(ctx.borrower.address, ctx.borrowAssetAddr)) as bigint;
  if (debt === 0n || reducibleDebt === 0n) {
    throw new Error("seeded liquidation order has no active reducible debt");
  }

  await healthViewWriter.pushRiskStatus.staticCall(ctx.borrower.address, 0n, 10000n, true, 0n);
  const pushRiskStatusGas = withGasBuffer(
    await healthViewWriter.pushRiskStatus.estimateGas(ctx.borrower.address, 0n, 10000n, true, 0n),
  );
  await (
    await healthViewWriter.pushRiskStatus(ctx.borrower.address, 0n, 10000n, true, 0n, { gasLimit: pushRiskStatusGas })
  ).wait();
  const [liquidatable, metadataValid] = (await liquidationRiskView
    .connect(new ethers.VoidSigner(ctx.borrower.address, ethers.provider))
    ["isLiquidatable(address)"](ctx.borrower.address)) as [boolean, boolean, bigint];
  const [riskScore] = (await liquidationRiskView
    .connect(new ethers.VoidSigner(ctx.borrower.address, ethers.provider))
    .getLiquidationRiskScore(ctx.borrower.address)) as [bigint, boolean, bigint];

  if (!metadataValid || !liquidatable) {
    throw new Error(
      `seeded order is not liquidatable after risk push: orderId=${finalized.orderId.toString()} liquidatable=${String(liquidatable)} riskScore=${riskScore.toString()}`,
    );
  }

  await settlementManager.connect(ctx.relayer).settleOrLiquidate.staticCall(finalized.orderId);

  const currentBlock = BigInt(await ethers.provider.getBlockNumber());
  const result = {
    orderId: finalized.orderId,
    borrower: ctx.borrower.address,
    maturity: order.maturity,
    currentBlock,
    riskScore,
    acceptRiskTriggeredOrder: true,
    source: "fresh-seed",
  } satisfies SeededLiquidationOrder;

  console.log(`SEEDED_LIQUIDATION_ORDER_ID=${result.orderId.toString()}`);
  console.log(`SEEDED_LIQUIDATION_BORROWER=${result.borrower}`);
  console.log(`SEEDED_LIQUIDATION_MATURITY=${result.maturity.toString()}`);
  console.log(`SEEDED_LIQUIDATION_CURRENT_BLOCK=${result.currentBlock.toString()}`);
  console.log(`SEEDED_LIQUIDATION_RISK_SCORE=${result.riskScore.toString()}`);
  console.log("SEEDED_LIQUIDATION_ACCEPT_RISK_TRIGGERED_ORDER=1");

  return result;
}