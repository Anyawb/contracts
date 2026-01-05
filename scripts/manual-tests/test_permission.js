const hre = require("hardhat");

async function main() {
  const [vaultCore, user] = await hre.ethers.getSigners();
  
  const Registry = await hre.ethers.getContractFactory("MockRegistry");
  const registry = await Registry.deploy();
  
  const PriceOracle = await hre.ethers.getContractFactory("MockPriceOracle");
  const priceOracle = await PriceOracle.deploy();
  
  const ERC20 = await hre.ethers.getContractFactory("MockERC20");
  const settlementToken = await ERC20.deploy("Settlement", "ST", hre.ethers.parseEther("1000000"));
  
  const nowTs = Math.floor(Date.now() / 1000);
  await priceOracle.connect(vaultCore).setPrice(await settlementToken.getAddress(), hre.ethers.parseEther("1"), nowTs, 18);
  const debtAsset = hre.ethers.Wallet.createRandom().address;
  await priceOracle.connect(vaultCore).setPrice(debtAsset, hre.ethers.parseEther("1"), nowTs, 18);
  
  const LendingEngine = await hre.ethers.getContractFactory("VaultLendingEngine");
  const lending = await LendingEngine.deploy();
  await lending.initialize(await priceOracle.getAddress(), await settlementToken.getAddress(), await registry.getAddress());
  
  const VaultCoreView = await hre.ethers.getContractFactory("MockVaultCoreView");
  const vaultCoreModule = await VaultCoreView.deploy();
  
  const KEY_VAULT_CORE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("VAULT_CORE"));
  await registry.setModule(KEY_VAULT_CORE, await vaultCoreModule.getAddress());
  
  await vaultCoreModule.setLendingEngine(await lending.getAddress());
  
  console.log("Testing module lookup...");
  const registeredAddr = await registry.getModule(KEY_VAULT_CORE);
  console.log("Registered VaultCore:", registeredAddr);
  console.log("VaultCoreModule address:", await vaultCoreModule.getAddress());
  console.log("Match:", registeredAddr.toLowerCase() === (await vaultCoreModule.getAddress()).toLowerCase());
  
  console.log("\nTesting direct call from user (should fail)...");
  try {
    const tx = await lending.connect(user).borrow(user.address, debtAsset, 10, 0, 0);
    console.log("ERROR: Should have failed but succeeded!");
    await tx.wait();
  } catch (e) {
    console.log("Failed as expected");
    console.log("Error message:", e.message);
    if (e.data) {
      console.log("Error data:", e.data);
      // Try to decode
      try {
        const iface = new hre.ethers.Interface([
          "error VaultLendingEngine__OnlyVaultCore()",
          "error ZeroAddress()"
        ]);
        const decoded = iface.parseError(e.data);
        console.log("Decoded error:", decoded.name);
      } catch (decodeErr) {
        console.log("Could not decode as custom error, might be string error");
      }
    }
  }
  
  console.log("\nTesting call through MockVaultCoreView (should succeed)...");
  try {
    const tx = await vaultCoreModule.borrow(user.address, debtAsset, 10, 0, 0);
    console.log("SUCCESS! Borrow worked through MockVaultCoreView");
    const receipt = await tx.wait();
    console.log("Gas used:", receipt.gasUsed.toString());
  } catch (e) {
    console.log("FAILED through MockVaultCoreView:");
    console.log("Error message:", e.message);
    if (e.data) {
      console.log("Error data:", e.data);
    }
    if (e.reason) {
      console.log("Reason:", e.reason);
    }
  }
}

main().catch(console.error);
