const hre = require("hardhat");

async function main() {
  // Test fallback strategy with amount = 50
  const amount = 50n;
  const conservativeRatio = 5000n; // 50% (5000 basis points)
  const BASIS_POINT_DIVISOR = 10000n;
  
  // If asset is not settlement token, fallback uses conservative ratio
  const fallbackValue = (amount * conservativeRatio) / BASIS_POINT_DIVISOR;
  
  console.log("Amount:", amount.toString());
  console.log("Conservative ratio:", conservativeRatio.toString());
  console.log("Fallback value:", fallbackValue.toString());
  
  if (fallbackValue === 0n) {
    console.log("ERROR: Fallback value is 0!");
  } else {
    console.log("OK: Fallback value > 0");
  }
  
  // But wait, if asset IS settlement token, fallback uses amount directly
  console.log("\nIf asset is settlement token:");
  console.log("Fallback value (face value):", amount.toString());
}

main().catch(console.error);
