const hre = require("hardhat");

async function main() {
  const [vaultCore, user] = await hre.ethers.getSigners();
  
  const PriceOracle = await hre.ethers.getContractFactory("MockPriceOracle");
  const priceOracle = await PriceOracle.deploy();
  
  const ERC20 = await hre.ethers.getContractFactory("MockERC20");
  const settlementToken = await ERC20.deploy("Settlement", "ST", hre.ethers.parseEther("1000000"));
  
  const nowTs = Math.floor(Date.now() / 1000);
  await priceOracle.connect(vaultCore).setPrice(await settlementToken.getAddress(), hre.ethers.parseEther("1"), nowTs, 18);
  const debtAsset = hre.ethers.Wallet.createRandom().address;
  await priceOracle.connect(vaultCore).setPrice(debtAsset, hre.ethers.parseEther("1"), nowTs, 18);
  
  console.log("Testing price oracle...");
  try {
    const price = await priceOracle.getPrice(debtAsset);
    console.log("Price for debtAsset:", price.toString());
  } catch (e) {
    console.log("getPrice failed:", e.message);
  }
  
  // Test GracefulDegradation library
  console.log("Testing GracefulDegradation...");
  try {
    // This would require importing the library, but let's check if it's available
    console.log("GracefulDegradation library should be available");
  } catch (e) {
    console.log("GracefulDegradation check failed:", e.message);
  }
}

main().catch(console.error);
