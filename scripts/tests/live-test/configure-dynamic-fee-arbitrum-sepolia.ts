import { ethers } from "hardhat";

import { envStr } from "../_addressResolver";
import { createFundsFlowLiveContext, ensureFundsFlowEnvironmentReady } from "./_fundsFlowLive";
import { key } from "./_mockLiveUtils";

function envBigint(name: string, fallback: bigint) {
  const raw = envStr(name)?.trim();
  if (!raw) {
    return fallback;
  }
  return BigInt(raw);
}

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Configure Live Dynamic Fee",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  await ensureFundsFlowEnvironmentReady(ctx);

  const feeTypeName = envStr("FEE_DYNAMIC_TYPE_NAME") ?? "LIVE_DYNAMIC_FEE_TEST";
  const desiredBps = envBigint("FEE_DYNAMIC_BPS", 200n);
  const allowOverwrite = envStr("ALLOW_DYNAMIC_FEE_OVERWRITE") === "1";
  const feeType = ethers.keccak256(ethers.toUtf8Bytes(feeTypeName));
  const dynamicUpdatedType = key("DYNAMIC_FEE_UPDATED").toLowerCase();
  const feeRouter = (await ethers.getContractAt(
    [
      "event DataPushed(bytes32 indexed dataTypeHash, bytes payload)",
      "function isTokenSupported(address token) view returns (bool)",
      "function getDynamicFee(address token,bytes32 feeType) view returns (uint256)",
      "function setDynamicFee(address token,bytes32 feeType,uint256 feeBps)",
    ],
    ctx.feeRouterAddr,
    ctx.relayer,
  )) as any;

  const hasSetParameter = (await ctx.acm.hasRole(key("SET_PARAMETER"), ctx.relayer.address)) as boolean;
  if (!hasSetParameter) {
    throw new Error(`relayer ${ctx.relayer.address} lacks SET_PARAMETER role required to configure dynamic fee`);
  }

  const isTokenSupported = (await feeRouter.isTokenSupported(ctx.borrowAssetAddr)) as boolean;
  if (!isTokenSupported) {
    throw new Error(`FeeRouter does not support borrow asset ${ctx.borrowAssetAddr}`);
  }

  const currentBps = (await feeRouter.getDynamicFee(ctx.borrowAssetAddr, feeType)) as bigint;

  console.log("=== Configure Live Dynamic Fee ===");
  console.log(`Registry=${ctx.registryAddr}`);
  console.log(`FeeRouter=${ctx.feeRouterAddr}`);
  console.log(`Relayer=${ctx.relayer.address}`);
  console.log(`Token=${ctx.borrowAssetAddr} (${ctx.borrowSymbol})`);
  console.log(`FeeTypeName=${feeTypeName}`);
  console.log(`FeeType=${feeType}`);
  console.log(`CurrentBps=${currentBps.toString()}`);
  console.log(`DesiredBps=${desiredBps.toString()}`);

  if (currentBps === desiredBps) {
    console.log("✅ dynamic fee already configured");
    return;
  }

  if (currentBps !== 0n && !allowOverwrite) {
    throw new Error(
      `dynamic fee already configured with different bps: current=${currentBps.toString()} desired=${desiredBps.toString()}; set ALLOW_DYNAMIC_FEE_OVERWRITE=1 to overwrite`,
    );
  }

  const receipt = await (await feeRouter.setDynamicFee(ctx.borrowAssetAddr, feeType, desiredBps)).wait();
  const updatedBps = (await feeRouter.getDynamicFee(ctx.borrowAssetAddr, feeType)) as bigint;
  if (updatedBps !== desiredBps) {
    throw new Error(`dynamic fee post-check mismatch: expected=${desiredBps.toString()} got=${updatedBps.toString()}`);
  }

  const updatePush = (receipt.logs ?? [])
    .filter((log: any) => String(log.topics?.[0] ?? "").toLowerCase() === feeRouter.interface.getEvent("DataPushed").topicHash.toLowerCase())
    .map((log: any) => feeRouter.interface.parseLog({ topics: log.topics, data: log.data }))
    .find((entry: any) => entry && String(entry.args[0] ?? "").toLowerCase() === dynamicUpdatedType);
  if (!updatePush) {
    throw new Error("missing DYNAMIC_FEE_UPDATED DataPushed after setDynamicFee");
  }

  console.log(`TxHash=${receipt.hash}`);
  console.log(`UpdatedBps=${updatedBps.toString()}`);
  console.log("✅ configure-dynamic-fee-arbitrum-sepolia PASSED");
}

main().catch((error) => {
  console.error("\n❌ configure-dynamic-fee-arbitrum-sepolia FAILED\n");
  console.error(error);
  process.exit(1);
});