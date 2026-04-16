import hre, { network } from "hardhat";

import { envBool, envStr } from "../../../../_addressResolver";
import { bootstrapFundsFlowLiveTest, getOrderForView, observeExtendedViews } from "../core/_fundsFlowLive";
import { readSeededLiquidationLog, seedLiquidatableOrder } from "../core/_liquidationSeed";
import { runWithNetworkRetry } from "../core/_networkRetry";
import { key } from "../core/_mockLiveUtils";
import { logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";

const { ethers } = hre;

const LOAN_STATUS = {
  Active: 0n,
  Repaid: 1n,
  Liquidated: 2n,
  Defaulted: 3n,
  LiquidatedWithShortfall: 4n,
  DefaultedWithShortfall: 5n,
} as const;

type ShortfallLedgerView = {
  orderId: bigint;
  borrower: string;
  debtAsset: string;
  collateralAsset: string;
  status: bigint;
  pricingMode: bigint;
  recoverySource: bigint;
  liquidationBlock: bigint;
  valuationBlock: bigint;
  coveredDebt: bigint;
  remainingDebt: bigint;
  shortfallAmount: bigint;
  recoveredAmount: bigint;
  lastRecoveryBlock: bigint;
  evidenceHash: string;
};

type ResolvedShortfallOrder = {
  orderId: bigint;
  source: string;
  defaultTrigger: boolean;
};

const SHORTFALL_STATUS = {
  OPEN: 1,
  PARTIALLY_RECOVERED: 2,
  RECOVERED: 3,
  RESOLVED: 4,
  MANUAL_SETTLEMENT: 5,
  WRITTEN_OFF: 6,
} as const;

const RECOVERY_SOURCE = {
  INSURANCE_FUND: 2,
  OFFCHAIN_RECOVERY: 3,
  MANUAL_SETTLEMENT: 4,
  GOVERNANCE_WRITE_OFF: 5,
} as const;

const PRICING_MODE = {
  STRICT_ORACLE: 0n,
} as const;

function formatLoanStatus(status: bigint) {
  switch (status) {
    case LOAN_STATUS.Active:
      return "Active";
    case LOAN_STATUS.Repaid:
      return "Repaid";
    case LOAN_STATUS.Liquidated:
      return "Liquidated";
    case LOAN_STATUS.Defaulted:
      return "Defaulted";
    case LOAN_STATUS.LiquidatedWithShortfall:
      return "LiquidatedWithShortfall";
    case LOAN_STATUS.DefaultedWithShortfall:
      return "DefaultedWithShortfall";
    default:
      return `Unknown(${status.toString()})`;
  }
}

function isWithShortfallStatus(status: bigint) {
  return status === LOAN_STATUS.LiquidatedWithShortfall || status === LOAN_STATUS.DefaultedWithShortfall;
}

function assertOk(cond: unknown, message: string): asserts cond {
  if (!cond) {
    throw new Error(message);
  }
}

async function hasAnyRole(acm: any, address: string, names: string[]) {
  for (const name of names) {
    if ((await acm.hasRole(key(name), address)) as boolean) {
      return true;
    }
  }
  return false;
}

async function expectStaticRevert(label: string, action: () => Promise<unknown>, hints: string[] = []) {
  try {
    await action();
  } catch (error) {
    const message = String((error as any)?.shortMessage ?? (error as any)?.message ?? error);
    if (hints.length > 0 && !hints.some((hint) => message.includes(hint))) {
      throw new Error(`${label}: reverted with unexpected reason: ${message}`);
    }
    console.log(`  [ExpectedRevert] ${label}`);
    return;
  }
  throw new Error(`${label}: expected revert`);
}

async function pickUnauthorizedSigner(ctx: any) {
  for (const signer of [ctx.lender, ctx.viewer, ctx.borrower]) {
    if (!signer) continue;
    if (String(signer.address).toLowerCase() === ctx.relayer.address.toLowerCase()) {
      continue;
    }
    const hasSetParameter = await hasAnyRole(ctx.acm, signer.address, ["ACTION_SET_PARAMETER", "SET_PARAMETER"]);
    const hasAdmin = await hasAnyRole(ctx.acm, signer.address, ["ACTION_ADMIN", "ADMIN"]);
    if (!hasSetParameter && !hasAdmin) {
      return signer;
    }
  }
  return null;
}

function parseOptionalBigInt(name: string) {
  const raw = envStr(name)?.trim();
  if (!raw) {
    return null;
  }
  return BigInt(raw);
}

function findParsedEvent(receipt: any, contract: any, eventName: string) {
  const emitter = String(contract.target ?? contract.address ?? "").toLowerCase();
  for (const log of receipt?.logs ?? []) {
    if (String(log.address ?? "").toLowerCase() !== emitter) {
      continue;
    }
    try {
      const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === eventName) {
        return parsed;
      }
    } catch {
      // Ignore unrelated logs.
    }
  }
  return null;
}

async function resolveShortfallOrderId(allowAutoSeedOnMockNetworks: boolean): Promise<ResolvedShortfallOrder> {
  const configuredOrderId = parseOptionalBigInt("LIVE_SHORTFALL_ORDER_ID");
  const configuredSeedLogFile = envStr("LIVE_SHORTFALL_SEED_LOG_FILE")?.trim();

  if (configuredOrderId !== null) {
    return {
      orderId: configuredOrderId,
      source: "configured-order-id",
      defaultTrigger: false,
    };
  }

  if (configuredSeedLogFile) {
    const seeded = readSeededLiquidationLog(configuredSeedLogFile);
    return {
      orderId: seeded.orderId,
      source: `seed-log:${configuredSeedLogFile}`,
      defaultTrigger: true,
    };
  }

  if (allowAutoSeedOnMockNetworks && network.name !== "localhost" && network.name !== "hardhat") {
    const seeded = await seedLiquidatableOrder({
      label: "Seed Shortfall Ledger Order",
      noticeLabel: "using fresh shortfall-ledger borrower",
      collateralAmountUnitsDefault: "10",
      borrowAmountUnitsDefault: "1200",
    });
    console.log(
      `  [ShortfallSeed] auto-seeded orderId=${seeded.orderId.toString()} borrower=${seeded.borrower} source=${seeded.source}`,
    );
    return {
      orderId: seeded.orderId,
      source: `auto-seed:${seeded.source}`,
      defaultTrigger: true,
    };
  }

  throw new Error(
    "shortfall live audit requires LIVE_SHORTFALL_ORDER_ID or LIVE_SHORTFALL_SEED_LOG_FILE; set LIVE_SHORTFALL_AUTO_SEED_ON_MOCK_NETWORKS=1 on mock-capable environments to auto-seed and liquidate",
  );
}

async function main() {
  const allowAutoSeedOnMockNetworks = envBool(
    "LIVE_SHORTFALL_AUTO_SEED_ON_MOCK_NETWORKS",
    envBool("LIVE_USE_MOCK_ASSET_PACK", false),
  );
  const expectActiveShortfall = envBool("LIVE_SHORTFALL_EXPECT_ACTIVE", true);
  const { ctx } = await bootstrapFundsFlowLiveTest({
    label: "Live Shortfall Ledger",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  const orderResolution = await resolveShortfallOrderId(allowAutoSeedOnMockNetworks);
  const explicitTrigger = envStr("LIVE_SHORTFALL_TRIGGER_LIQUIDATION")?.trim();
  const shouldTriggerLiquidation = explicitTrigger
    ? envBool("LIVE_SHORTFALL_TRIGGER_LIQUIDATION", false)
    : orderResolution.defaultTrigger;

  const registry = (await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    ctx.registryAddr,
  )) as any;
  const lendingEngineAddr = (await registry.getModuleOrRevert(key("LENDING_ENGINE"))) as string;

  const orderStatusReader = (await ethers.getContractAt(
    ["function getOrderStatusForView(uint256 orderId) view returns (uint8)"],
    ctx.orderEngineAddr,
    ctx.viewer,
  )) as any;
  const lendingEngine = (await ethers.getContractAt(
    ["function getDebt(address user,address asset) view returns (uint256)"],
    lendingEngineAddr,
    ctx.viewer,
  )) as any;
  const settlementManagerRead = (await ethers.getContractAt(
    [
      "function settleOrLiquidate(uint256 orderId)",
      "function applyShortfallRecovery(uint256 orderId,uint8 recoverySource,uint256 recoveryAmount,bytes32 evidenceHash)",
      "function setShortfallStatus(uint256 orderId,uint8 newStatus,bytes32 evidenceHash)",
      "function getShortfallLedger(uint256 orderId) view returns ((uint256 orderId,address borrower,address debtAsset,address collateralAsset,uint8 status,uint8 pricingMode,uint8 recoverySource,uint256 liquidationBlock,uint256 valuationBlock,uint256 coveredDebt,uint256 remainingDebt,uint256 shortfallAmount,uint256 recoveredAmount,uint256 lastRecoveryBlock,bytes32 evidenceHash))",
      "function hasActiveShortfall(uint256 orderId) view returns (bool)",
      "event LiquidationShortfallOpened(uint256 indexed orderId,address indexed borrower,address indexed debtAsset,uint8 status,uint8 pricingMode,uint256 coveredDebt,uint256 remainingDebt,uint256 shortfallAmount,uint256 valuationBlock,uint256 liquidationBlock,bytes32 evidenceHash)",
    ],
    ctx.settlementManagerAddr,
    ctx.viewer,
  )) as any;
  const settlementManagerWrite = settlementManagerRead.connect(ctx.relayer) as any;

  const orderId = orderResolution.orderId;
  const order = await getOrderForView(ctx, orderId);
  assertOk(order.borrower && order.borrower !== ethers.ZeroAddress, `orderId=${orderId.toString()} is not present on current registry ${ctx.registryAddr}`);

  let openedEvent: any = null;
  if (shouldTriggerLiquidation) {
    const hasLiquidateRole = (await ctx.acm.hasRole(key("LIQUIDATE"), ctx.relayer.address)) as boolean;
    if (!hasLiquidateRole) {
      throw new Error(`relayer ${ctx.relayer.address} lacks LIQUIDATE role required by SettlementManager`);
    }
    await settlementManagerWrite.settleOrLiquidate.staticCall(orderId);
    const receipt = await (await settlementManagerWrite.settleOrLiquidate(orderId)).wait();
    openedEvent = findParsedEvent(receipt, settlementManagerRead, "LiquidationShortfallOpened");
    assertOk(openedEvent, `orderId=${orderId.toString()} liquidation completed without LiquidationShortfallOpened; provide a known shortfall order via LIVE_SHORTFALL_ORDER_ID for pure inspection mode`);
  }

  const [ledger, hasActiveShortfall, orderStatus, debtAfter] = await Promise.all([
    settlementManagerRead.getShortfallLedger(orderId) as Promise<ShortfallLedgerView>,
    settlementManagerRead.hasActiveShortfall(orderId) as Promise<boolean>,
    orderStatusReader.getOrderStatusForView(orderId) as Promise<bigint>,
    lendingEngine.getDebt(order.borrower, order.asset) as Promise<bigint>,
  ]);
  const snapshot = await observeExtendedViews(ctx, "shortfall-ledger-audit");

  assertOk(ledger.orderId === orderId, `shortfall ledger orderId mismatch: expected ${orderId.toString()} got ${ledger.orderId.toString()}`);
  assertOk(ledger.borrower.toLowerCase() === order.borrower.toLowerCase(), "shortfall ledger borrower mismatch");
  assertOk(ledger.debtAsset.toLowerCase() === order.asset.toLowerCase(), "shortfall ledger debt asset mismatch");
  assertOk(ledger.remainingDebt > 0n, "shortfall remainingDebt must stay positive for dedicated shortfall audit");
  assertOk(ledger.shortfallAmount > 0n, "shortfallAmount must stay positive for dedicated shortfall audit");
  assertOk(ledger.coveredDebt > 0n, "coveredDebt must remain positive for dedicated shortfall audit");
  assertOk(ledger.liquidationBlock > 0n, "shortfall liquidationBlock must be recorded");
  assertOk(ledger.valuationBlock > 0n, "shortfall valuationBlock must be recorded");
  assertOk(ledger.valuationBlock <= ledger.liquidationBlock, "valuationBlock cannot exceed liquidationBlock");
  assertOk(
    ledger.pricingMode === PRICING_MODE.STRICT_ORACLE,
    `shortfall pricingMode must be STRICT_ORACLE(0), got ${ledger.pricingMode.toString()}`,
  );
  assertOk(debtAfter === ledger.remainingDebt, `debt ledger mismatch after shortfall: debt=${debtAfter.toString()} ledger.remainingDebt=${ledger.remainingDebt.toString()}`);

  const hasSetParameter = await hasAnyRole(ctx.acm, ctx.relayer.address, ["ACTION_SET_PARAMETER", "SET_PARAMETER"]);
  const governanceEvidence = ethers.keccak256(ethers.toUtf8Bytes(`live-shortfall-governance-${Date.now().toString()}`));
  const dryRunRecoveryAmount = ledger.remainingDebt > 1n ? ledger.remainingDebt / 2n : ledger.remainingDebt;

  if (hasSetParameter) {
    await expectStaticRevert(
      "shortfall write-off requires non-zero evidence hash",
      () => settlementManagerWrite.setShortfallStatus.staticCall(orderId, SHORTFALL_STATUS.WRITTEN_OFF, ethers.ZeroHash),
      ["EvidenceHashRequired", "evidence"],
    );
    await expectStaticRevert(
      "shortfall recovery rejects governance write-off source",
      () => settlementManagerWrite.applyShortfallRecovery.staticCall(orderId, RECOVERY_SOURCE.GOVERNANCE_WRITE_OFF, 1n, governanceEvidence),
      ["InvalidShortfallRecoverySource", "recovery source"],
    );
    await expectStaticRevert(
      "shortfall insurance recovery requires non-zero evidence hash",
      () => settlementManagerWrite.applyShortfallRecovery.staticCall(orderId, RECOVERY_SOURCE.INSURANCE_FUND, 1n, ethers.ZeroHash),
      ["RecoveryEvidenceHashRequired", "evidence"],
    );
    await expectStaticRevert(
      "shortfall offchain recovery requires non-zero evidence hash",
      () => settlementManagerWrite.applyShortfallRecovery.staticCall(orderId, RECOVERY_SOURCE.OFFCHAIN_RECOVERY, 1n, ethers.ZeroHash),
      ["RecoveryEvidenceHashRequired", "evidence"],
    );
    await settlementManagerWrite.applyShortfallRecovery.staticCall(
      orderId,
      RECOVERY_SOURCE.MANUAL_SETTLEMENT,
      dryRunRecoveryAmount,
      governanceEvidence,
    );
    console.log(
      `  [ShortfallStateMachine] relayer has SET_PARAMETER; static recovery preview passed amount=${dryRunRecoveryAmount.toString()}`,
    );
  } else {
    const unauthorizedSigner = await pickUnauthorizedSigner(ctx);
    if (unauthorizedSigner) {
      const deniedWrite = settlementManagerRead.connect(unauthorizedSigner) as any;
      await expectStaticRevert(
        "shortfall recovery caller gate",
        () => deniedWrite.applyShortfallRecovery.staticCall(orderId, RECOVERY_SOURCE.MANUAL_SETTLEMENT, 1n, governanceEvidence),
      );
      await expectStaticRevert(
        "shortfall status caller gate",
        () => deniedWrite.setShortfallStatus.staticCall(orderId, SHORTFALL_STATUS.MANUAL_SETTLEMENT, governanceEvidence),
      );
    } else {
      console.log("  [Notice] no distinct unauthorized signer found; skipping negative caller-gate coverage for shortfall governance writes");
    }
    console.log(`  [Notice] relayer ${ctx.relayer.address} lacks ACTION_SET_PARAMETER; shortfall write-path checks limited to caller-gate coverage`);
  }

  if (envBool("LIVE_SHORTFALL_ENABLE_WRITE_RECOVERY", false)) {
    if (!hasSetParameter) {
      throw new Error("LIVE_SHORTFALL_ENABLE_WRITE_RECOVERY=1 requires relayer to hold ACTION_SET_PARAMETER or SET_PARAMETER");
    }
    const writeAmount = envBool("LIVE_SHORTFALL_WRITE_FULL_RECOVERY", false) ? ledger.remainingDebt : (ledger.remainingDebt > 1n ? ledger.remainingDebt / 2n : ledger.remainingDebt);
    await settlementManagerWrite.applyShortfallRecovery.staticCall(
      orderId,
      RECOVERY_SOURCE.MANUAL_SETTLEMENT,
      writeAmount,
      governanceEvidence,
    );
    const recoveryReceipt = await (await settlementManagerWrite.applyShortfallRecovery(
      orderId,
      RECOVERY_SOURCE.MANUAL_SETTLEMENT,
      writeAmount,
      governanceEvidence,
    )).wait();
    const ledgerAfterRecovery = await settlementManagerRead.getShortfallLedger(orderId) as ShortfallLedgerView;
    assertOk(ledgerAfterRecovery.recoveredAmount >= ledger.recoveredAmount + writeAmount, "recoveredAmount did not increase after optional write recovery");
    assertOk(ledgerAfterRecovery.remainingDebt + writeAmount === ledger.remainingDebt, "remainingDebt did not decrease by write recovery amount");
    console.log(
      `  [ShortfallStateMachineWrite] tx=${recoveryReceipt?.hash ?? "n/a"} recoveredDelta=${writeAmount.toString()} remainingDebt=${ledgerAfterRecovery.remainingDebt.toString()}`,
    );
  }

  if (expectActiveShortfall) {
    assertOk(hasActiveShortfall, "expected active shortfall ledger state");
    assertOk(isWithShortfallStatus(BigInt(orderStatus)), `expected with-shortfall order status, got ${formatLoanStatus(BigInt(orderStatus))}`);
  }

  console.log(
    `  [ShortfallLedger] source=${orderResolution.source} orderId=${orderId.toString()} status=${formatLoanStatus(BigInt(orderStatus))} shortfallStatus=${ledger.status.toString()} pricingMode=${ledger.pricingMode.toString()} remainingDebt=${ledger.remainingDebt.toString()} coveredDebt=${ledger.coveredDebt.toString()} active=${String(hasActiveShortfall)}`,
  );
  if (openedEvent) {
    console.log(
      `  [ShortfallEvent] coveredDebt=${BigInt(openedEvent.args.coveredDebt).toString()} remainingDebt=${BigInt(openedEvent.args.remainingDebt).toString()} shortfallAmount=${BigInt(openedEvent.args.shortfallAmount).toString()}`,
    );
  }
  console.log(
    `  [ViewSnapshot] userDebt=${snapshot.statisticsUser?.debt?.toString() ?? "n/a"} systemDebt=${snapshot.statisticsGlobal?.totalDebt?.toString() ?? "n/a"} feeRouterValid=${snapshot.feeRouterSync?.isValid ?? false}`,
  );

  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);
