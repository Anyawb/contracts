const hre = require("hardhat");

async function main() {
  const [vaultCore, user] = await hre.ethers.getSigners();
  
  const Registry = await hre.ethers.getContractFactory("MockRegistry");
  const registry = await Registry.deploy();
  
  const VaultCoreView = await hre.ethers.getContractFactory("MockVaultCoreView");
  const vaultCoreModule = await VaultCoreView.deploy();
  
  const KEY_VAULT_CORE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("VAULT_CORE"));
  await registry.setModule(KEY_VAULT_CORE, await vaultCoreModule.getAddress());
  
  const registered = await registry.getModule(KEY_VAULT_CORE);
  console.log("Registered address:", registered);
  console.log("VaultCoreModule address:", await vaultCoreModule.getAddress());
  console.log("Match:", registered.toLowerCase() === (await vaultCoreModule.getAddress()).toLowerCase());
  
  try {
    const result = await registry.getModuleOrRevert(KEY_VAULT_CORE);
    console.log("getModuleOrRevert result:", result);
  } catch (e) {
    console.log("getModuleOrRevert failed:", e.message);
  }
}

main().catch(console.error);
