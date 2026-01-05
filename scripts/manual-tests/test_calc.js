const hre = require("hardhat");

async function main() {
  // Test the calculation that would happen
  const amount = 10n;
  const price = hre.ethers.parseEther("1"); // 1e18
  const decimals = 18n;
  
  // This is what calculateAssetValue should do:
  // calculatedValue = amountValue.mul(priceValue).div(priceMultiplier);
  // where priceMultiplier = 10^decimals
  
  const priceMultiplier = 10n ** decimals;
  console.log("Price multiplier:", priceMultiplier.toString());
  
  const calculatedValue = (amount * price) / priceMultiplier;
  console.log("Calculated value:", calculatedValue.toString());
  
  // Check if this could cause issues
  if (calculatedValue === 0n) {
    console.log("WARNING: Calculated value is 0, which might cause issues");
  }
  
  // Test with the actual values from the test
  const testAmount = 10n;
  const testPrice = hre.ethers.parseEther("1");
  const testDecimals = 18n;
  const testMultiplier = 10n ** testDecimals;
  const testValue = (testAmount * testPrice) / testMultiplier;
  console.log("Test calculation:", testValue.toString());
}

main().catch(console.error);
