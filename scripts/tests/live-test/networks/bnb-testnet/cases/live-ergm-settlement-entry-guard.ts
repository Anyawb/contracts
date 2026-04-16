import { ethers } from "hardhat";

import { createFundsFlowLiveContext } from "../core/_fundsFlowLive";
import { key } from "../core/_mockLiveUtils";
import { runWithNetworkRetry } from "../core/_networkRetry";
import { logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";

async function expectOnlySettlementManager(label: string, action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    const message = String((error as any)?.shortMessage ?? (error as any)?.message ?? error);
    if (!message.includes("OnlySettlementManager")) {
      throw new Error(`${label}: expected OnlySettlementManager revert, got: ${message}`);
    }
    console.log(`  [ExpectedRevert] ${label}`);
    return;
  }
  throw new Error(`${label}: expected revert`);
}

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live ERGM Settlement Entry Guard",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  const registry = await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    ctx.registryAddr,
  );

  const ergmAddr = await registry.getModuleOrRevert(key("KEY_EARLY_REPAYMENT_GUARANTEE")) as string;
  if (!ergmAddr || ergmAddr === ethers.ZeroAddress) {
    throw new Error("EarlyRepaymentGuaranteeManager is not deployed or not registered");
  }

  const ergm = await ethers.getContractAt(
    [
      "function settleEarlyRepayment(address borrower,address asset,uint256 actualRepayAmount) returns (tuple(uint256 penaltyToLender,uint256 refundToBorrower,uint256 platformFee,uint256 actualInterestPaid))",
      "function processDefault(address borrower,address asset) returns (uint256)",
    ],
    ergmAddr,
  );

  const actor = ctx.relayer;
  await expectOnlySettlementManager("settleEarlyRepayment caller gate", async () =>
    ergm.connect(actor).settleEarlyRepayment.staticCall(actor.address, ctx.borrowAssetAddr, 1n),
  );
  await expectOnlySettlementManager("processDefault caller gate", async () =>
    ergm.connect(actor).processDefault.staticCall(actor.address, ctx.borrowAssetAddr),
  );

  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);
