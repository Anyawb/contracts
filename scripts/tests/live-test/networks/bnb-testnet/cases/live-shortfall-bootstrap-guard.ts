import hre, { network } from "hardhat";

import { envStr } from "../../../../_addressResolver";
import { createFundsFlowLiveContext } from "../core/_fundsFlowLive";
import { runWithNetworkRetry } from "../core/_networkRetry";
import { key } from "../core/_mockLiveUtils";
import { logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";

const { ethers } = hre;

const ORDER_PRODUCT_LOAN = 1n;
const SHORTFALL_STATUS_ACTIVE = 1n;

function assertOk(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function resolveCandidateOrderId() {
  const configured = envStr("LIVE_SHORTFALL_BOOTSTRAP_GUARD_ORDER_ID")?.trim();
  if (configured) {
    return BigInt(configured);
  }
  return 900000000001n;
}

async function main() {
  if (network.name !== "localhost" && network.name !== "hardhat") {
    console.log("  [Notice] shortfall bootstrap guard is localhost/fork-only; skipping on live network");
    logLiveScriptSuccess(__filename);
    return;
  }

  const ctx = await createFundsFlowLiveContext({
    label: "Live Shortfall Bootstrap Guard",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  const registry = await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    ctx.registryAddr,
  );

  const [settlementManagerAddr, orderStateStoreAddr] = await Promise.all([
    registry.getModuleOrRevert(key("KEY_SETTLEMENT_MANAGER")) as Promise<string>,
    registry.getModuleOrRevert(key("KEY_ORDER_STATE_STORE")) as Promise<string>,
  ]);

  assertOk(settlementManagerAddr !== ethers.ZeroAddress, "SettlementManager module is not configured");
  assertOk(orderStateStoreAddr !== ethers.ZeroAddress, "OrderStateStore module is not configured");

  const orderStateStore = await ethers.getContractAt(
    [
      "function hasOrderState(uint8 productType,uint256 orderId) view returns (bool)",
      "function syncLoanShortfallState(uint256 orderId,uint256 createdBlockHint,uint8 shortfallStatus)",
    ],
    orderStateStoreAddr,
  );

  let orderId = resolveCandidateOrderId();
  for (let i = 0; i < 5; i += 1) {
    const hasState = (await orderStateStore.hasOrderState(ORDER_PRODUCT_LOAN, orderId)) as boolean;
    if (!hasState) {
      break;
    }
    orderId += 1n;
  }

  const hasStateBefore = (await orderStateStore.hasOrderState(ORDER_PRODUCT_LOAN, orderId)) as boolean;
  assertOk(!hasStateBefore, `expected missing order state for guard orderId=${orderId.toString()}`);

  await ethers.provider.send("hardhat_setBalance", [
    settlementManagerAddr,
    "0x8AC7230489E80000",
  ]);
  await ethers.provider.send("hardhat_impersonateAccount", [settlementManagerAddr]);

  try {
    const settlementManagerSigner = await ethers.getSigner(settlementManagerAddr);
    const tx = await orderStateStore
      .connect(settlementManagerSigner)
      .syncLoanShortfallState(orderId, 0n, SHORTFALL_STATUS_ACTIVE);
    await tx.wait();
  } finally {
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [settlementManagerAddr]);
  }

  const hasStateAfter = (await orderStateStore.hasOrderState(ORDER_PRODUCT_LOAN, orderId)) as boolean;
  assertOk(!hasStateAfter, "shortfall sync must not bootstrap missing loan order state");

  console.log(`  [ShortfallBootstrapGuard] orderId=${orderId.toString()} hasStateBefore=${String(hasStateBefore)} hasStateAfter=${String(hasStateAfter)}`);
  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);