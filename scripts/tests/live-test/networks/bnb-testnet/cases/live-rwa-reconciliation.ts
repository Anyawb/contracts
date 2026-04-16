import hre from "hardhat";

import { envBool, envStr } from "../../../../_addressResolver";
import { createFundsFlowLiveContext } from "../core/_fundsFlowLive";
import { runWithNetworkRetry } from "../core/_networkRetry";
import { logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";
import { key } from "../core/_mockLiveUtils";
import { runLiveRoleReadinessAudit } from "../../../../tools/live-role-readiness-audit";

const { ethers } = hre;

const LOAN_STATUS = {
  Active: 0n,
  Repaid: 1n,
  Liquidated: 2n,
  Defaulted: 3n,
  LiquidatedWithShortfall: 4n,
  DefaultedWithShortfall: 5n,
} as const;

const MANUAL_SHORTFALL_NOTE =
  "current protocol treats reserve/lenderCompensation/offchain receipts as audit inputs only; shortfall debt changes still require explicit SettlementManager.applyShortfallRecovery(...) or setShortfallStatus(...) calls";

function assertOk(cond: unknown, message: string): asserts cond {
  if (!cond) {
    throw new Error(message);
  }
}

function parseOptionalBigInt(name: string) {
  const raw = envStr(name)?.trim();
  if (!raw) {
    return null;
  }
  return BigInt(raw);
}

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

function parseReceiptStatus() {
  const raw = (envStr("LIVE_RWA_REC_OFFCHAIN_RECEIPT_STATUS") ?? "none").trim().toLowerCase();
  switch (raw) {
    case "none":
    case "pending":
    case "success":
    case "failed":
    case "timeout":
      return raw;
    default:
      throw new Error(`unsupported LIVE_RWA_REC_OFFCHAIN_RECEIPT_STATUS=${raw}`);
  }
}

function looksCleanlySettled(status: bigint, debt: bigint, hasActiveShortfall: boolean) {
  return status === LOAN_STATUS.Repaid && debt === 0n && !hasActiveShortfall;
}

async function main() {
  const audit = await runLiveRoleReadinessAudit();
  const orderId = parseOptionalBigInt("LIVE_RWA_REC_ORDER_ID");

  if (orderId === null) {
    console.log(
      "  [RWA-Reconciliation] role matrix and SettlementManager bridge readiness passed. This entry is audit-only: reserve/lenderCompensation/offchain receipts do not auto-trigger shortfall recovery. Set LIVE_RWA_REC_ORDER_ID to compare onchain debt against an offchain settlement/support snapshot.",
    );
    logLiveScriptSuccess(__filename, "AUDITED");
    return;
  }

  const ctx = await createFundsFlowLiveContext({
    label: "Live RWA Reconciliation",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });
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
  const settlementManager = (await ethers.getContractAt(
    [
      "function hasActiveShortfall(uint256 orderId) view returns (bool)",
      "function getShortfallLedger(uint256 orderId) view returns ((uint256 orderId,address borrower,address debtAsset,address collateralAsset,uint8 status,uint8 pricingMode,uint8 recoverySource,uint256 liquidationBlock,uint256 valuationBlock,uint256 coveredDebt,uint256 remainingDebt,uint256 shortfallAmount,uint256 recoveredAmount,uint256 lastRecoveryBlock,bytes32 evidenceHash))",
    ],
    ctx.settlementManagerAddr,
    ctx.viewer,
  )) as any;

  const order = await ctx.orderEngine.getLoanOrderForView(orderId);
  assertOk(order.borrower && order.borrower !== ethers.ZeroAddress, `orderId=${orderId.toString()} is not present on current registry ${ctx.registryAddr}`);

  const [orderStatus, totalDue, onchainDebt, hasActiveShortfall] = await Promise.all([
    orderStatusReader.getOrderStatusForView(orderId) as Promise<bigint>,
    ctx.orderEngine.getOrderTotalDueForView(orderId) as Promise<bigint>,
    lendingEngine.getDebt(order.borrower, order.asset) as Promise<bigint>,
    settlementManager.hasActiveShortfall(orderId) as Promise<boolean>,
  ]);

  let shortfallLedger: any = null;
  if (hasActiveShortfall || envBool("LIVE_RWA_REC_READ_SHORTFALL_LEDGER", true)) {
    try {
      shortfallLedger = await settlementManager.getShortfallLedger(orderId);
    } catch {
      shortfallLedger = null;
    }
  }

  const offchainSupportedDebt = parseOptionalBigInt("LIVE_RWA_REC_OFFCHAIN_SUPPORTED_DEBT_WEI");
  const offchainReceiptStatus = parseReceiptStatus();
  const offchainReceiptId = envStr("LIVE_RWA_REC_OFFCHAIN_RECEIPT_ID")?.trim() ?? "n/a";
  const requireZeroDebtOnSuccess = envBool("LIVE_RWA_REC_REQUIRE_ZERO_DEBT_ON_SUCCESS", false);

  console.log(
    `  [RWA-Reconciliation] orderId=${orderId.toString()} borrower=${String(order.borrower)} asset=${String(order.asset)} status=${formatLoanStatus(BigInt(orderStatus))} totalDue=${BigInt(totalDue).toString()} onchainDebt=${onchainDebt.toString()} activeShortfall=${String(hasActiveShortfall)} receiptStatus=${offchainReceiptStatus} receiptId=${offchainReceiptId}`,
  );
  console.log(
    `  [RWA-Reconciliation] readinessAudit network=${audit.networkName} registry=${audit.registryAddr} bridgeFailures=${audit.failedBridgeChecks.length} missingRoles=${audit.missing.length}`,
  );
  console.log(`  [RWA-Reconciliation] note=${MANUAL_SHORTFALL_NOTE}`);
  if (shortfallLedger) {
    console.log(
      `  [RWA-Reconciliation] shortfall status=${BigInt(shortfallLedger.status).toString()} remainingDebt=${BigInt(shortfallLedger.remainingDebt).toString()} recovered=${BigInt(shortfallLedger.recoveredAmount).toString()}`,
    );
  }

  if (offchainSupportedDebt !== null) {
    if (offchainSupportedDebt < onchainDebt) {
      throw new Error(
        `[RWA-REC-01] offchain supported debt is below the onchain debt ledger: supported=${offchainSupportedDebt.toString()} onchain=${onchainDebt.toString()}`,
      );
    }
    if (offchainSupportedDebt > onchainDebt) {
      throw new Error(
        `[RWA-REC-02] offchain supported debt exceeds the onchain debt ledger: supported=${offchainSupportedDebt.toString()} onchain=${onchainDebt.toString()}`,
      );
    }
  }

  if (offchainReceiptStatus === "success" && requireZeroDebtOnSuccess && onchainDebt > 0n) {
    throw new Error(
      `[RWA-REC-03] offchain receipt is marked success but onchain debt is still outstanding: debt=${onchainDebt.toString()}`,
    );
  }

  if ((offchainReceiptStatus === "failed" || offchainReceiptStatus === "timeout" || offchainReceiptStatus === "pending")
    && looksCleanlySettled(BigInt(orderStatus), onchainDebt, hasActiveShortfall)) {
    throw new Error(
      `[RWA-SETTLE-01] order looks fully settled onchain while offchain receipt status is ${offchainReceiptStatus}`,
    );
  }

  if ((offchainReceiptStatus === "failed" || offchainReceiptStatus === "timeout")
    && !hasActiveShortfall
    && onchainDebt > 0n
    && BigInt(orderStatus) === LOAN_STATUS.Active) {
    throw new Error(
      `[RWA-SETTLE-02] offchain settlement failed but the order still looks active without an explicit shortfall/default pathway: debt=${onchainDebt.toString()}`,
    );
  }

  if (offchainReceiptStatus === "pending" && BigInt(orderStatus) === LOAN_STATUS.Repaid && onchainDebt > 0n) {
    throw new Error(
      `[RWA-SETTLE-03] order status is Repaid while an offchain receipt is still pending and debt remains non-zero: debt=${onchainDebt.toString()}`,
    );
  }

  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);