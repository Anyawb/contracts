const hre = require("hardhat");

async function main() {
  const [vaultCore] = await hre.ethers.getSigners();
  
  const VaultView = await hre.ethers.getContractFactory("MockVaultView");
  const vaultView = await VaultView.deploy();
  
  const VaultCoreView = await hre.ethers.getContractFactory("MockVaultCoreView");
  const vaultCoreModule = await VaultCoreView.deploy();
  
  console.log("Before setting viewContractAddr:");
  const viewAddrBefore = await vaultCoreModule.viewContractAddrVar();
  console.log("viewContractAddrVar before:", viewAddrBefore);
  
  await vaultCoreModule.setViewContractAddr(await vaultView.getAddress());
  
  console.log("\nAfter setting viewContractAddr:");
  const viewAddrAfter = await vaultCoreModule.viewContractAddrVar();
  console.log("viewContractAddrVar after:", viewAddrAfter);
  console.log("vaultView address:", await vaultView.getAddress());
  console.log("Match:", viewAddrAfter.toLowerCase() === (await vaultView.getAddress()).toLowerCase());
  
  if (viewAddrAfter === hre.ethers.ZeroAddress) {
    console.log("\nERROR: viewContractAddrVar is still zero address!");
  }
}

main().catch(console.error);
