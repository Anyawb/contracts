const hre = require("hardhat");

async function main() {
  const [vaultCore, user] = await hre.ethers.getSigners();
  
  const VaultRouter = await hre.ethers.getContractFactory("MockVaultRouter");
  const vaultRouter = await VaultRouter.deploy();
  
  const debtAsset = hre.ethers.Wallet.createRandom().address;
  
  console.log("Testing pushUserPositionUpdate directly...");
  try {
    const tx = await vaultRouter.pushUserPositionUpdate(user.address, debtAsset, 200, 10);
    console.log("pushUserPositionUpdate succeeded! Tx:", tx.hash);
    await tx.wait();
    
    const debt = await vaultRouter.getUserDebt(user.address, debtAsset);
    console.log("Debt after update:", debt.toString());
  } catch (e) {
    console.log("pushUserPositionUpdate failed:", e.message);
  }
  
  // Test viewContractAddrVar
  const VaultCoreView = await hre.ethers.getContractFactory("MockVaultCoreView");
  const vaultCoreModule = await VaultCoreView.deploy();
  await vaultCoreModule.setViewContractAddr(await vaultRouter.getAddress());
  
  const viewAddr = await vaultCoreModule.viewContractAddrVar();
  console.log("viewContractAddrVar returns:", viewAddr);
  console.log("Matches vaultRouter:", viewAddr.toLowerCase() === (await vaultRouter.getAddress()).toLowerCase());
}

main().catch(console.error);
