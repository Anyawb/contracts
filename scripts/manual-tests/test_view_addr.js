const hre = require("hardhat");

async function main() {
  const [vaultCore] = await hre.ethers.getSigners();
  
  const VaultRouter = await hre.ethers.getContractFactory("MockVaultRouter");
  const vaultRouter = await VaultRouter.deploy();
  
  const VaultCoreView = await hre.ethers.getContractFactory("MockVaultCoreView");
  const vaultCoreModule = await VaultCoreView.deploy();
  
  console.log("Before setting viewContractAddr:");
  const viewAddrBefore = await vaultCoreModule.viewContractAddrVar();
  console.log("viewContractAddrVar before:", viewAddrBefore);
  
  await vaultCoreModule.setViewContractAddr(await vaultRouter.getAddress());
  
  console.log("\nAfter setting viewContractAddr:");
  const viewAddrAfter = await vaultCoreModule.viewContractAddrVar();
  console.log("viewContractAddrVar after:", viewAddrAfter);
  console.log("vaultRouter address:", await vaultRouter.getAddress());
  console.log("Match:", viewAddrAfter.toLowerCase() === (await vaultRouter.getAddress()).toLowerCase());
  
  if (viewAddrAfter === hre.ethers.ZeroAddress) {
    console.log("\nERROR: viewContractAddrVar is still zero address!");
  }
}

main().catch(console.error);
