import hre from "hardhat";

const { ethers } = hre;

import { envBool } from "../../../../_addressResolver";
import { createFundsFlowLiveContext } from "../core/_fundsFlowLive";
import { ensureRoleForAccount, key } from "../core/_mockLiveUtils";
import { runWithNetworkRetry } from "../core/_networkRetry";
import { logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";

async function expectCallRevert(label: string, action: () => Promise<unknown>) {
  try {
    await action();
  } catch {
    console.log(`  [ExpectedRevert] ${label}`);
    return;
  }
  throw new Error(`${label}: expected revert`);
}

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live EventHistoryManager",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  if (!ctx.eventHistoryManager || !ctx.eventHistoryManagerAddr || ctx.eventHistoryManagerAddr === ethers.ZeroAddress) {
    throw new Error("EventHistoryManager is not deployed or not registered");
  }

  const registryAddr = await ctx.eventHistoryManager.getRegistry() as string;
  if (registryAddr.toLowerCase() !== ctx.registryAddr.toLowerCase()) {
    throw new Error(`EventHistoryManager registry mismatch: expected ${ctx.registryAddr} got ${registryAddr}`);
  }

  const eventType = key("LIVE_EVENT_HISTORY_SMOKE");
  const extraData = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256", "address"],
    [ctx.borrowAmount, ctx.borrower.address],
  );

  const encodedUnauthorizedCall = ctx.eventHistoryManager.interface.encodeFunctionData("recordEvent", [
    eventType,
    ctx.borrower.address,
    ctx.borrowAssetAddr,
    ctx.borrowAmount,
    extraData,
  ]);
  await expectCallRevert("EventHistoryManager unauthorized record should revert", async () =>
    ethers.provider.call({
      to: ctx.eventHistoryManagerAddr,
      from: ctx.borrower.address,
      data: encodedUnauthorizedCall,
    }),
  );

  const acmOwner = await ctx.acm.owner() as string;
  const autoGrantRuntimeRoles = envBool("LIVE_AUTO_GRANT_RUNTIME_ROLES", true);
  const failOnMissingRuntimeRoles = envBool(
    "LIVE_FAIL_ON_MISSING_RUNTIME_ROLES",
    false,
  );

  const relayerHasManageHistory = await ensureRoleForAccount({
    acm: ctx.acm,
    roleName: "MANAGE_EVENT_HISTORY",
    account: ctx.relayer.address,
    granter: ctx.relayer,
    ownerAddress: acmOwner,
    autoGrant: autoGrantRuntimeRoles,
    label: `relayer ${ctx.relayer.address}`,
  });

  if (!relayerHasManageHistory) {
    const message = "EventHistoryManager writer role MANAGE_EVENT_HISTORY is missing for relayer";
    if (failOnMissingRuntimeRoles) {
      throw new Error(message);
    }
    console.log(`  [Notice] ${message}; positive write assertions skipped`);
    logLiveScriptSuccess(__filename, "PASSED (read-only coverage)");
    return;
  }

  const tx = await ctx.eventHistoryManager
    .connect(ctx.relayer)
    .recordEvent(eventType, ctx.borrower.address, ctx.borrowAssetAddr, ctx.borrowAmount, extraData);
  const receipt = await tx.wait();
  if (!receipt) {
    throw new Error("EventHistoryManager receipt missing");
  }

  const parsedLogs = receipt.logs
    .filter((log: any) => String(log.address ?? "").toLowerCase() === ctx.eventHistoryManagerAddr.toLowerCase())
    .map((log: any) => {
      try {
        return ctx.eventHistoryManager.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .filter(Boolean) as any[];

  const historyRecorded = parsedLogs.find((entry) => entry.name === "HistoryRecorded");
  const dataPushed = parsedLogs.find((entry) => entry.name === "DataPushed");
  if (!historyRecorded) {
    throw new Error("EventHistoryManager did not emit HistoryRecorded");
  }
  if (!dataPushed) {
    throw new Error("EventHistoryManager did not emit DataPushed");
  }

  if (String(historyRecorded.args.eventType ?? historyRecorded.args[0]).toLowerCase() !== eventType.toLowerCase()) {
    throw new Error("EventHistoryManager HistoryRecorded eventType mismatch");
  }
  if (String(historyRecorded.args.user ?? historyRecorded.args[1]).toLowerCase() !== ctx.borrower.address.toLowerCase()) {
    throw new Error("EventHistoryManager HistoryRecorded user mismatch");
  }
  if (String(historyRecorded.args.asset ?? historyRecorded.args[2]).toLowerCase() !== ctx.borrowAssetAddr.toLowerCase()) {
    throw new Error("EventHistoryManager HistoryRecorded asset mismatch");
  }
  if (BigInt(historyRecorded.args.amount ?? historyRecorded.args[3] ?? 0) !== ctx.borrowAmount) {
    throw new Error("EventHistoryManager HistoryRecorded amount mismatch");
  }
  if (String(historyRecorded.args.extraData ?? historyRecorded.args[4]).toLowerCase() !== extraData.toLowerCase()) {
    throw new Error("EventHistoryManager HistoryRecorded extraData mismatch");
  }
  const emittedBlockNumber = BigInt(historyRecorded.args.blockNumber ?? historyRecorded.args[5] ?? 0);
  if (emittedBlockNumber === 0n) {
    throw new Error("EventHistoryManager HistoryRecorded blockNumber should be non-zero");
  }
  if (emittedBlockNumber !== BigInt(receipt.blockNumber)) {
    console.log(
      `  [Notice] EventHistoryManager HistoryRecorded blockNumber differs from receipt: event=${emittedBlockNumber.toString()} receipt=${BigInt(receipt.blockNumber).toString()}`,
    );
  }

  const pushedDataType = String(dataPushed.args.dataType ?? dataPushed.args[0]);
  if (pushedDataType.toLowerCase() !== key("EVENT_HISTORY").toLowerCase()) {
    throw new Error("EventHistoryManager DataPushed dataType mismatch");
  }

  const pushedPayload = String(dataPushed.args.payload ?? dataPushed.args[1]);
  const decodedPayload = ethers.AbiCoder.defaultAbiCoder().decode(
    ["bytes32", "address", "address", "uint256", "bytes"],
    pushedPayload,
  );
  if (String(decodedPayload[0]).toLowerCase() !== eventType.toLowerCase()) {
    throw new Error("EventHistoryManager payload eventType mismatch");
  }
  if (String(decodedPayload[1]).toLowerCase() !== ctx.borrower.address.toLowerCase()) {
    throw new Error("EventHistoryManager payload user mismatch");
  }
  if (String(decodedPayload[2]).toLowerCase() !== ctx.borrowAssetAddr.toLowerCase()) {
    throw new Error("EventHistoryManager payload asset mismatch");
  }
  if (BigInt(decodedPayload[3]) !== ctx.borrowAmount) {
    throw new Error("EventHistoryManager payload amount mismatch");
  }
  if (String(decodedPayload[4]).toLowerCase() !== extraData.toLowerCase()) {
    throw new Error("EventHistoryManager payload extraData mismatch");
  }

  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);