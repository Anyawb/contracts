import { ethers, network } from "hardhat";

import { envBool, envStr } from "../tests/_addressResolver";
import { createFundsFlowLiveContext, getGuaranteeState } from "../tests/live-test/_fundsFlowLive";
import { explainRevert } from "../tests/live-test/_mockLiveUtils";

const RESOLVE_ERROR_INTERFACE = new ethers.Interface([
  "error SettlementManager__InvalidOrderId()",
  "error SettlementManager__NotLiquidatable()",
  "error SettlementManager__NoCollateral()",
  "error SettlementManager__OrderMismatch()",
  "error SettlementManager__DebtNotCleared()",
  "error GuaranteeRecordNotFound()",
  "error GuaranteeNotActive()",
  "error GuaranteeAlreadyProcessed()",
  "error ExternalModuleRevertedRaw(string module, bytes data)",
  "error MissingRole()",
]);

type CandidateOrder = {
  orderId: bigint;
  principal: bigint;
  rate: bigint;
  term: bigint;
  borrower: string;
  lender: string;
  asset: string;
  maturity: bigint;
  repaidAmount: bigint;
};

function roleKey(roleName: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(roleName));
}

function short(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

async function safeRead<T>(label: string, read: () => Promise<T>) {
  try {
    return await read();
  } catch (error: any) {
    return `<reverted:${label}:${error?.shortMessage ?? error?.message ?? String(error)}>` as T;
  }
}

async function ensureViewRole(acm: any, relayer: any) {
  const role = roleKey("VIEW_SYSTEM_DATA");
  const hasRole = (await acm.hasRole(role, relayer.address)) as boolean;
  if (!hasRole) {
    await (await acm.connect(relayer).grantRole(role, relayer.address)).wait();
  }
}

async function main() {
  if (network.name !== "arbitrumSepolia") {
    throw new Error(`expected --network arbitrumSepolia, got ${network.name}`);
  }

  const mode = (envStr("GUARANTEE_RESOLVE_MODE") ?? "inspect").trim().toLowerCase();
  const grantViewRole = envBool("GRANT_VIEW_ROLE", true);
  const scanMax = Number(envStr("ORDER_SCAN_MAX") ?? "32");

  const ctx = await createFundsFlowLiveContext({
    label: "Resolve Live Guarantee",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  const registry = (await ethers.getContractAt(
    [
      "function getModule(bytes32) view returns (address)",
      "function getModuleOrRevert(bytes32) view returns (address)",
    ],
    ctx.registryAddr,
  )) as any;

  const orderEngineAddr = (await registry.getModuleOrRevert(roleKey("ORDER_ENGINE"))) as string;
  const settlementManagerAddr = (await registry.getModuleOrRevert(roleKey("SETTLEMENT_MANAGER"))) as string;
  const lendingEngineAddr = (await registry.getModuleOrRevert(roleKey("LENDING_ENGINE"))) as string;
  const riskManagerAddr = (await registry.getModuleOrRevert(roleKey("LIQUIDATION_RISK_MANAGER"))) as string;

  if (grantViewRole) {
    await ensureViewRole(ctx.acm, ctx.relayer);
  }

  const orderEngine = (await ethers.getContractAt(
    [
      "function getLoanOrderForView(uint256 orderId) view returns ((uint256 principal,uint256 rate,uint256 term,address borrower,address lender,address asset,uint256 startTimestamp,uint256 maturity,uint256 repaidAmount))",
      "function getUserLoanCountForView(address user) view returns (uint256)",
    ],
    orderEngineAddr,
    ctx.relayer,
  )) as any;
  const lendingEngine = (await ethers.getContractAt(
    [
      "function getUserDebtAssets(address user) view returns (address[])",
      "function getDebt(address user,address asset) view returns (uint256)",
      "function getReducibleDebtAmount(address user,address asset) view returns (uint256)",
    ],
    lendingEngineAddr,
    ctx.relayer,
  )) as any;
  const settlementManager = (await ethers.getContractAt(
    ["function settleOrLiquidate(uint256 orderId)", "function registryAddrVar() view returns (address)"],
    settlementManagerAddr,
    ctx.relayer,
  )) as any;
  const lendingEngineMeta = (await ethers.getContractAt(
    ["function registryAddrVar() view returns (address)"],
    lendingEngineAddr,
    ctx.relayer,
  )) as any;
  const riskManager = (await ethers.getContractAt(
    ["function isLiquidatable(address user) view returns (bool)", "function registryAddrVar() view returns (address)"],
    riskManagerAddr,
    ctx.relayer,
  )) as any;
  const orderEngineMeta = (await ethers.getContractAt(
    ["function getRegistryForView() view returns (address)"],
    orderEngineAddr,
    ctx.relayer,
  )) as any;

  const currentBlock = BigInt(await ethers.provider.getBlockNumber());
  const guarantee = await getGuaranteeState(ctx);
  const debtAssets = (await lendingEngine.getUserDebtAssets(ctx.borrower.address)) as string[];
  const debtAmount = (await lendingEngine.getDebt(ctx.borrower.address, ctx.borrowAssetAddr)) as bigint;
  const reducibleDebt = (await lendingEngine.getReducibleDebtAmount(ctx.borrower.address, ctx.borrowAssetAddr)) as bigint;
  const loanCount = (await orderEngine.getUserLoanCountForView(ctx.borrower.address)) as bigint;
  const riskLiquidatable = (await riskManager.isLiquidatable(ctx.borrower.address)) as boolean;
  const settlementManagerRegistry = await safeRead("SettlementManager.registryAddrVar", async () => settlementManager.registryAddrVar() as Promise<string>);
  const lendingEngineRegistry = await safeRead("LendingEngine.registryAddrVar", async () => lendingEngineMeta.registryAddrVar() as Promise<string>);
  const riskManagerRegistry = await safeRead("RiskManager.registryAddrVar", async () => riskManager.registryAddrVar() as Promise<string>);
  const orderEngineRegistry = await safeRead("OrderEngine.getRegistryForView", async () => orderEngineMeta.getRegistryForView() as Promise<string>);

  const candidates: CandidateOrder[] = [];
  for (let index = 0; index < scanMax; index += 1) {
    try {
      const raw = (await orderEngine.getLoanOrderForView(index)) as any;
      const borrower = String(raw.borrower ?? raw[3]);
      if (borrower.toLowerCase() !== ctx.borrower.address.toLowerCase()) {
        continue;
      }
      candidates.push({
        orderId: BigInt(index),
        principal: BigInt(raw.principal ?? raw[0]),
        rate: BigInt(raw.rate ?? raw[1]),
        term: BigInt(raw.term ?? raw[2]),
        borrower,
        lender: String(raw.lender ?? raw[4]),
        asset: String(raw.asset ?? raw[5]),
        maturity: BigInt(raw.maturity ?? raw[7]),
        repaidAmount: BigInt(raw.repaidAmount ?? raw[8]),
      });
    } catch {
      // ignore missing order ids
    }
  }

  console.log(`Mode=${mode}`);
  console.log(`Registry=${ctx.registryAddr}`);
  console.log(`Borrower=${ctx.borrower.address}`);
  console.log(`Relayer=${ctx.relayer.address}`);
  console.log(`BorrowAsset=${ctx.borrowAssetAddr}`);
  console.log(`SettlementManager=${settlementManagerAddr}`);
  console.log(`LendingEngine=${lendingEngineAddr}`);
  console.log(`RiskManager=${riskManagerAddr}`);
  console.log(`SettlementManager.registry=${settlementManagerRegistry}`);
  console.log(`LendingEngine.registry=${lendingEngineRegistry}`);
  console.log(`RiskManager.registry=${riskManagerRegistry}`);
  console.log(`OrderEngine.registry=${orderEngineRegistry}`);
  console.log(`CurrentBlock=${currentBlock}`);
  console.log(`DebtAssets=${debtAssets.join(",") || "<none>"}`);
  console.log(`DebtAmount=${debtAmount}`);
  console.log(`ReducibleDebt=${reducibleDebt}`);
  console.log(`RiskLiquidatable=${riskLiquidatable}`);
  console.log(`LoanCountForBorrower=${loanCount}`);
  console.log(`Guarantee.enabled=${guarantee.enabled}`);
  console.log(`Guarantee.active=${guarantee.active}`);
  console.log(`Guarantee.locked=${guarantee.locked}`);
  console.log(`Guarantee.guaranteeId=${guarantee.guaranteeId}`);
  if (guarantee.record) {
    console.log(`Guarantee.record.principal=${guarantee.record.principal}`);
    console.log(`Guarantee.record.promisedInterest=${guarantee.record.promisedInterest}`);
    console.log(`Guarantee.record.startTime=${guarantee.record.startTime}`);
    console.log(`Guarantee.record.maturityTime=${guarantee.record.maturityTime}`);
    console.log(`Guarantee.record.lender=${guarantee.record.lender}`);
    console.log(`Guarantee.record.asset=${guarantee.record.asset}`);
  }

  console.log("\n[Candidate Orders]");
  for (const order of candidates) {
    console.log(
      `- orderId=${order.orderId.toString()} asset=${short(order.asset)} principal=${order.principal.toString()} repaid=${order.repaidAmount.toString()} maturity=${order.maturity.toString()} overdue=${currentBlock > order.maturity} lender=${short(order.lender)}`,
    );
  }

  const chosenOrder = candidates.find((order) => {
    const assetMatches = order.asset.toLowerCase() === ctx.borrowAssetAddr.toLowerCase();
    const principalMatches = !guarantee.record || order.principal === guarantee.record.principal;
    const outstanding = order.repaidAmount < ctx.totalDue;
    return assetMatches && principalMatches && outstanding;
  });

  if (!chosenOrder) {
    if (!guarantee.active && debtAmount === 0n && reducibleDebt === 0n) {
      console.log("No active guarantee or outstanding debt. Nothing to resolve.");
      return;
    }
    throw new Error("unable to identify a candidate order for the active guarantee");
  }

  console.log(`\nChosenOrder=${chosenOrder.orderId.toString()}`);
  console.log(`ChosenOrder.overdue=${currentBlock > chosenOrder.maturity}`);

  if (mode === "inspect") {
    return;
  }

  if (mode === "repay") {
    const repayAmount = ctx.totalDue;
    const allowance = (await ctx.borrowToken.allowance(ctx.borrower.address, ctx.vaultCoreAddr)) as bigint;
    if (allowance < repayAmount) {
      await (await ctx.borrowToken.connect(ctx.borrower).approve(ctx.vaultCoreAddr, ethers.MaxUint256)).wait();
    }
    await (await ctx.vaultCore.connect(ctx.borrower).repay(chosenOrder.orderId, ctx.borrowAssetAddr, repayAmount)).wait();
    console.log(`Repaid orderId=${chosenOrder.orderId.toString()} amount=${repayAmount.toString()}`);
  } else if (mode === "liquidate") {
    try {
      await settlementManager.connect(ctx.relayer).settleOrLiquidate.staticCall(chosenOrder.orderId);
    } catch (error: any) {
      throw new Error(
        `settleOrLiquidate staticCall reverted: ${explainRevert(error, [settlementManager.interface, RESOLVE_ERROR_INTERFACE])}`,
      );
    }
    await (await settlementManager.connect(ctx.relayer).settleOrLiquidate(chosenOrder.orderId)).wait();
    console.log(`Liquidated orderId=${chosenOrder.orderId.toString()}`);
  } else {
    throw new Error(`unsupported GUARANTEE_RESOLVE_MODE=${mode}`);
  }

  const guaranteeAfter = await getGuaranteeState(ctx);
  const debtAssetsAfter = (await lendingEngine.getUserDebtAssets(ctx.borrower.address)) as string[];
  const debtAmountAfter = (await lendingEngine.getDebt(ctx.borrower.address, ctx.borrowAssetAddr)) as bigint;
  console.log(`\nAfter.activeGuarantee=${guaranteeAfter.active}`);
  console.log(`After.guaranteeId=${guaranteeAfter.guaranteeId}`);
  console.log(`After.locked=${guaranteeAfter.locked}`);
  console.log(`After.debtAssets=${debtAssetsAfter.join(",") || "<none>"}`);
  console.log(`After.debtAmount=${debtAmountAfter}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});