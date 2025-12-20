const hre = require("hardhat");

async function main() {
  const [vaultCore] = await hre.ethers.getSigners();
  
  const PriceOracle = await hre.ethers.getContractFactory("MockPriceOracle");
  const priceOracle = await PriceOracle.deploy();
  
  const ERC20 = await hre.ethers.getContractFactory("MockERC20");
  const settlementToken = await ERC20.deploy("Settlement", "ST", hre.ethers.parseEther("1000000"));
  
  const nowTs = Math.floor(Date.now() / 1000);
  await priceOracle.connect(vaultCore).setPrice(await settlementToken.getAddress(), hre.ethers.parseEther("1"), nowTs, 18);
  const debtAsset = hre.ethers.Wallet.createRandom().address;
  await priceOracle.connect(vaultCore).setPrice(debtAsset, hre.ethers.parseEther("1"), nowTs, 18);
  
  console.log("Testing IPriceOracle interface...");
  try {
    const IPriceOracle = await hre.ethers.getContractAt("IPriceOracle", await priceOracle.getAddress());
    const [price, timestamp, decimals] = await IPriceOracle.getPrice(debtAsset);
    console.log("IPriceOracle.getPrice result:", price.toString(), timestamp.toString(), decimals.toString());
  } catch (e) {
    console.log("IPriceOracle.getPrice failed:", e.message);
  }
  
  console.log("Testing IPriceOracleAdapter interface...");
  try {
    const IPriceOracleAdapter = await hre.ethers.getContractAt("IPriceOracleAdapter", await priceOracle.getAddress());
    const [price, timestamp, decimals] = await IPriceOracleAdapter.getPrice(debtAsset);
    console.log("IPriceOracleAdapter.getPrice result:", price.toString(), timestamp.toString(), decimals.toString());
  } catch (e) {
    console.log("IPriceOracleAdapter.getPrice failed:", e.message);
    console.log("This is the problem! MockPriceOracle doesn't implement IPriceOracleAdapter");
  }
}

main().catch(console.error);
