const hre = require("hardhat");

async function main() {
  // Test fallback strategy calculation
  const amount = 50n;
  const conservativeRatio = 5000n; // 50% (5000 basis points)
  const BASIS_POINT_DIVISOR = 10000n;
  
  const fallbackValue = (amount * conservativeRatio) / BASIS_POINT_DIVISOR;
  
  console.log("Amount:", amount.toString());
  console.log("Conservative ratio:", conservativeRatio.toString());
  console.log("Fallback value:", fallbackValue.toString());
  
  if (fallbackValue === 0n) {
    console.log("ERROR: Fallback value is 0, might cause issues!");
  } else {
    console.log("OK: Fallback value is > 0");
  }
}

main().catch(console.error);
