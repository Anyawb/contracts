import { ethers } from "hardhat";

import { createFundsFlowLiveContext } from "../tests/live-test/_fundsFlowLive";
import { key } from "../tests/live-test/_mockLiveUtils";

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Repair Live FeeRouterView",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  const registry = (await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    ctx.registryAddr,
  )) as any;
  const vaultCore = (await ethers.getContractAt(
    ["function viewContractAddrVar() view returns (address)"],
    ctx.vaultCoreAddr,
  )) as any;

  const viewGatewayAddr = (await vaultCore.viewContractAddrVar()) as string;
  const feeRouterViewAddr = (await registry.getModuleOrRevert(key("FEE_ROUTER_VIEW"))) as string;
  const vaultRouter = (await ethers.getContractAt(
    [
      "function feeRouterViewAddrVar() view returns (address)",
      "function setFeeRouterView(address newFeeRouterView)",
    ],
    viewGatewayAddr,
  )) as any;

  const before = (await vaultRouter.feeRouterViewAddrVar()) as string;
  console.log("=== Repair Live FeeRouterView ===");
  console.log(`Registry=${ctx.registryAddr}`);
  console.log(`VaultCore=${ctx.vaultCoreAddr}`);
  console.log(`viewGateway=${viewGatewayAddr}`);
  console.log(`RegistryFeeRouterView=${feeRouterViewAddr}`);
  console.log(`VaultRouter.feeRouterViewAddrVar(before)=${before}`);

  if (before.toLowerCase() === feeRouterViewAddr.toLowerCase()) {
    console.log("already configured; nothing to do");
    return;
  }

  await vaultRouter.connect(ctx.relayer).setFeeRouterView.staticCall(feeRouterViewAddr);
  const receipt = await (await vaultRouter.connect(ctx.relayer).setFeeRouterView(feeRouterViewAddr)).wait();
  const after = (await vaultRouter.feeRouterViewAddrVar()) as string;

  console.log(`tx=${receipt.hash}`);
  console.log(`VaultRouter.feeRouterViewAddrVar(after)=${after}`);
  if (after.toLowerCase() !== feeRouterViewAddr.toLowerCase()) {
    throw new Error(`feeRouterView target mismatch after repair: expected ${feeRouterViewAddr} got ${after}`);
  }
}

main().catch((error) => {
  console.error("\n❌ repair-live-feerouter-view FAILED\n");
  console.error(error);
  process.exit(1);
});