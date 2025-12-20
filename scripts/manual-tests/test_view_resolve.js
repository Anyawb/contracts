const hre = require("hardhat");

async function main() {
  const [vaultCore, user] = await hre.ethers.getSigners();
  
  const Registry = await hre.ethers.getContractFactory("MockRegistry");
  const registry = await Registry.deploy();
  
  const VaultView = await hre.ethers.getContractFactory("MockVaultView");
  const vaultView = await VaultView.deploy();
  
  const VaultCoreView = await hre.ethers.getContractFactory("MockVaultCoreView");
  const vaultCoreModule = await VaultCoreView.deploy();
  
  await vaultCoreModule.setViewContractAddr(await vaultView.getAddress());
  
  const KEY_VAULT_CORE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("VAULT_CORE"));
  await registry.setModule(KEY_VAULT_CORE, await vaultCoreModule.getAddress());
  
  console.log("Testing viewContractAddrVar...");
  try {
    const viewAddr = await vaultCoreModule.viewContractAddrVar();
    console.log("viewContractAddrVar returns:", viewAddr);
    console.log("Matches vaultView:", viewAddr.toLowerCase() === (await vaultView.getAddress()).toLowerCase());
    
    if (viewAddr === hre.ethers.ZeroAddress) {
      console.log("ERROR: viewContractAddrVar returns zero address!");
    }
  } catch (e) {
    console.log("viewContractAddrVar failed:", e.message);
  }
  
  // Test if we can call pushUserPositionUpdate directly
  console.log("\nTesting pushUserPositionUpdate directly...");
  try {
    const debtAsset = hre.ethers.Wallet.createRandom().address;
    const tx = await vaultView.pushUserPositionUpdate(user.address, debtAsset, 200, 10);
    console.log("pushUserPositionUpdate succeeded! Tx:", tx.hash);
    await tx.wait();
  } catch (e) {
    console.log("pushUserPositionUpdate failed:", e.message);
  }
}

main().catch(console.error);
