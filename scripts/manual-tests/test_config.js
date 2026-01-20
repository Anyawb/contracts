const hre = require("hardhat");

async function main() {
  // Test the config values that might cause issues
  console.log("Testing GracefulDegradation config...");
  
  // The issue might be in price validation
  // Let's check what happens with a small amount and normal price
  const amount = 10n;
  const price = hre.ethers.parseEther("1"); // 1e18
  const decimals = 18n;
  
  // Check if price validation might fail
  // maxReasonablePrice is likely a very large number, so this should pass
  // But let's check the actual calculation
  
  const calculatedValue = (amount * price) / (10n ** decimals);
  console.log("Calculated value:", calculatedValue.toString());
  
  // The issue might be that calculatedValue is too small
  // Let's check if there's a minimum value requirement
  if (calculatedValue === 0n) {
    console.log("ERROR: Calculated value is 0!");
  } else if (calculatedValue < 1n) {
    console.log("WARNING: Calculated value is less than 1!");
  }
  
  // Test with a larger amount
  const largeAmount = hre.ethers.parseEther("1");
  const largeCalculatedValue = (largeAmount * price) / (10n ** decimals);
  console.log("Large amount calculated value:", largeCalculatedValue.toString());
}

main().catch(console.error);
