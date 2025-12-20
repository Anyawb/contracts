const hre = require("hardhat");

async function main() {
  const [vaultCore, user] = await hre.ethers.getSigners();
  
  const VaultView = await hre.ethers.getContractFactory("MockVaultView");
  const vaultView = await VaultView.deploy();
  
  const debtAsset = hre.ethers.Wallet.createRandom().address;
  
  console.log("Testing pushUserPositionUpdate directly...");
  try {
    const tx = await vaultView.pushUserPositionUpdate(user.address, debtAsset, 200, 10);
    console.log("pushUserPositionUpdate succeeded! Tx:", tx.hash);
    await tx.wait();
    
    const debt = await vaultView.getUserDebt(user.address, debtAsset);
    console.log("Debt after update:", debt.toString());
  } catch (e) {
    console.log("pushUserPositionUpdate failed:", e.message);
  }
  
  // Test viewContractAddrVar
  const VaultCoreView = await hre.ethers.getContractFactory("MockVaultCoreView");
  const vaultCoreModule = await VaultCoreView.deploy();
  await vaultCoreModule.setViewContractAddr(await vaultView.getAddress());
  
  const viewAddr = await vaultCoreModule.viewContractAddrVar();
  console.log("viewContractAddrVar returns:", viewAddr);
  console.log("Matches vaultView:", viewAddr.toLowerCase() === (await vaultView.getAddress()).toLowerCase());
}

main().catch(console.error);
