const hre = require("hardhat");

async function main() {
  const [vaultCore, user] = await hre.ethers.getSigners();
  
  // Minimal setup
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
  
  // Test if we can call getDebt (view function with onlyValidRegistry)
  console.log("Testing getDebt (view function)...");
  try {
    const debt = await lending.getDebt(user.address, debtAsset);
    console.log("getDebt result:", debt.toString());
  } catch (e) {
    console.log("getDebt failed:", e.message);
  }
  
  // Test if we can call getTotalDebtByAsset
  console.log("\nTesting getTotalDebtByAsset...");
  try {
    const total = await lending.getTotalDebtByAsset(debtAsset);
    console.log("getTotalDebtByAsset result:", total.toString());
  } catch (e) {
    console.log("getTotalDebtByAsset failed:", e.message);
  }
}

main().catch(console.error);
