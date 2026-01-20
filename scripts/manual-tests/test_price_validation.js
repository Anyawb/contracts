const hre = require("hardhat");

async function main() {
  // Test price validation
  const price = hre.ethers.parseEther("1"); // 1e18
  const DEFAULT_MAX_PRICE_MULTIPLIER = 15000n; // 150%
  
  // maxReasonablePrice is likely calculated as settlementTokenPrice * maxPriceMultiplier / 10000
  // If settlementTokenPrice is 1e18, then maxReasonablePrice = 1e18 * 15000 / 10000 = 1.5e18
  
  const settlementTokenPrice = hre.ethers.parseEther("1");
  const maxReasonablePrice = (settlementTokenPrice * DEFAULT_MAX_PRICE_MULTIPLIER) / 10000n;
  
  console.log("Settlement token price:", settlementTokenPrice.toString());
  console.log("Max reasonable price:", maxReasonablePrice.toString());
  console.log("Test price:", price.toString());
  console.log("Price <= maxReasonablePrice:", price <= maxReasonablePrice);
  
  if (price > maxReasonablePrice) {
    console.log("ERROR: Price validation would fail!");
  }
}

main().catch(console.error);
