import fs from "fs";
import path from "path";

import { ethers } from "hardhat";

import { createFundsFlowLiveContext } from "../tests/live-test/networks/arbitrum-sepolia/core/_fundsFlowLive";

const EIP1967_IMPLEMENTATION_SLOT = "0x360894A13BA1A3210667C828492DB98DCA3E2076CC3735A920A3CA505D382BBC";

function artifactPath(relativePath: string) {
  return path.join(process.cwd(), "abi", relativePath);
}

function loadDeployedBytecode(relativePath: string) {
  const content = fs.readFileSync(artifactPath(relativePath), "utf8");
  const artifact = JSON.parse(content) as { deployedBytecode: string };
  return artifact.deployedBytecode;
}

async function getImplementationAddress(proxyAddr: string) {
  const raw = await ethers.provider.getStorage(proxyAddr, EIP1967_IMPLEMENTATION_SLOT);
  if (!raw || raw === "0x") {
    return ethers.ZeroAddress;
  }
  return ethers.getAddress(`0x${raw.slice(26)}`);
}

async function codeHash(address: string) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") {
    return { size: 0, hash: ethers.ZeroHash };
  }
  return { size: (code.length - 2) / 2, hash: ethers.keccak256(code) };
}

async function tryCall(label: string, tx: { to: string; data: string; from?: string }) {
  try {
    await ethers.provider.call(tx);
    return `${label}: ok`;
  } catch (error: any) {
    return `${label}: revert ${String(error?.shortMessage ?? error?.message ?? error)}`;
  }
}

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Inspect Live FeeRouterView",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  const vaultCore = (await ethers.getContractAt(
    [
      "function viewContractAddrVar() view returns (address)",
    ],
    ctx.vaultCoreAddr,
  )) as any;
  const viewGatewayAddr = (await vaultCore.viewContractAddrVar()) as string;
  const vaultRouter = (await ethers.getContractAt(
    [
      "function feeRouterViewAddrVar() view returns (address)",
      "function pushGlobalStatsUpdate(uint256 totalDistributions,uint256 totalAmountDistributed)",
    ],
    viewGatewayAddr,
  )) as any;
  const feeRouterViewAddrVar = (await vaultRouter.feeRouterViewAddrVar()) as string;

  const feeRouterView = (await ethers.getContractAt(
    [
      "function getSyncStatus() view returns (bool,uint256,bool)",
      "function getFeeRouter() view returns (address)",
      "function getRegistry() view returns (address)",
      "function pushGlobalStatsUpdate(uint256 totalDistributions,uint256 totalAmountDistributed)",
    ],
    ctx.feeRouterView!.target,
  )) as any;
  const platformTreasury = (await ctx.feeRouter.getPlatformTreasury()) as string;
  const ecosystemVault = (await ctx.feeRouter.getEcosystemVault()) as string;

  const modules = [
    {
      name: "FeeRouter",
      proxy: ctx.feeRouterAddr,
      artifact: "Vault/FeeRouter.sol/FeeRouter.json",
    },
    {
      name: "VaultRouter(viewGateway)",
      proxy: viewGatewayAddr,
      artifact: "Vault/VaultRouter.sol/VaultRouter.json",
    },
    {
      name: "FeeRouterView",
      proxy: ctx.feeRouterView!.target as string,
      artifact: "Vault/view/modules/FeeRouterView.sol/FeeRouterView.json",
    },
  ];

  console.log("=== Live FeeRouterView Drift Inspection ===");
  console.log(`Registry=${ctx.registryAddr}`);
  console.log(`VaultCore=${ctx.vaultCoreAddr}`);
  console.log(`viewContractAddrVar()=${viewGatewayAddr}`);
  console.log(`VaultRouter.feeRouterViewAddrVar()=${feeRouterViewAddrVar}`);
  console.log(`Registry.FEE_ROUTER_VIEW=${String(ctx.feeRouterView!.target)}`);
  console.log(`FeeRouter.platformTreasury=${platformTreasury}`);
  console.log(`FeeRouter.ecosystemVault=${ecosystemVault}`);
  console.log(
    `AddressOverlap relayer==platform=${String(ctx.relayer.address.toLowerCase() === platformTreasury.toLowerCase())} relayer==eco=${String(ctx.relayer.address.toLowerCase() === ecosystemVault.toLowerCase())} platform==eco=${String(platformTreasury.toLowerCase() === ecosystemVault.toLowerCase())}`,
  );
  console.log(`FeeRouterView.getRegistry()=${await feeRouterView.getRegistry()}`);
  console.log(`FeeRouterView.getFeeRouter()=${await feeRouterView.getFeeRouter()}`);

  const [syncValid, lastSyncBlock, needsSync] = (await feeRouterView.getSyncStatus()) as [boolean, bigint, boolean];
  console.log(`FeeRouterView.getSyncStatus() valid=${String(syncValid)} lastSyncBlock=${lastSyncBlock.toString()} needsSync=${String(needsSync)}`);

  for (const module of modules) {
    const impl = await getImplementationAddress(module.proxy);
    const proxyCode = await codeHash(module.proxy);
    const implCode = impl === ethers.ZeroAddress ? { size: 0, hash: ethers.ZeroHash } : await codeHash(impl);
    const localBytecode = loadDeployedBytecode(module.artifact);
    const localHash = localBytecode && localBytecode !== "0x" ? ethers.keccak256(localBytecode) : ethers.ZeroHash;

    console.log(`\n[${module.name}]`);
    console.log(`proxy=${module.proxy}`);
    console.log(`proxyCodeSize=${proxyCode.size} proxyCodeHash=${proxyCode.hash}`);
    console.log(`implementation=${impl}`);
    console.log(`implementationCodeSize=${implCode.size} implementationCodeHash=${implCode.hash}`);
    console.log(`localDeployedBytecodeHash=${localHash}`);
    console.log(`matchesLocal=${String(localHash !== ethers.ZeroHash && localHash === implCode.hash)}`);
  }

  const feeRouterViewIface = feeRouterView.interface;
  const vaultRouterIface = vaultRouter.interface;
  const feeRouterViewCallData = feeRouterViewIface.encodeFunctionData("pushGlobalStatsUpdate", [1n, 2n]);
  const vaultRouterCallData = vaultRouterIface.encodeFunctionData("pushGlobalStatsUpdate", [1n, 2n]);

  console.log("\n[WriterGate simulation]");
  console.log(await tryCall("FeeRouterView.pushGlobalStatsUpdate from FeeRouter", {
    to: String(ctx.feeRouterView!.target),
    from: ctx.feeRouterAddr,
    data: feeRouterViewCallData,
  }));
  console.log(await tryCall("FeeRouterView.pushGlobalStatsUpdate from viewGateway", {
    to: String(ctx.feeRouterView!.target),
    from: viewGatewayAddr,
    data: feeRouterViewCallData,
  }));
  console.log(await tryCall("VaultRouter.pushGlobalStatsUpdate from FeeRouter", {
    to: viewGatewayAddr,
    from: ctx.feeRouterAddr,
    data: vaultRouterCallData,
  }));
  console.log(await tryCall("VaultRouter.pushGlobalStatsUpdate from relayer", {
    to: viewGatewayAddr,
    from: ctx.relayer.address,
    data: vaultRouterCallData,
  }));
}

main().catch((error) => {
  console.error("\n❌ inspect-live-feerouter-view FAILED\n");
  console.error(error);
  process.exit(1);
});