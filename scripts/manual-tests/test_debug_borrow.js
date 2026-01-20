const hre = require("hardhat");

async function main() {
  // Test the exact calculation that would happen in borrow
  const amount = 50n;
  const price = hre.ethers.parseUnits("1", 8); // 1e8
  const decimals = 8n;
  
  // This is what calculateAssetValue does:
  const priceMultiplier = 10n ** decimals;
  const calculatedValue = (amount * price) / priceMultiplier;
  
  console.log("Test calculation:");
  console.log("Amount:", amount.toString());
  console.log("Price:", price.toString());
  console.log("Decimals:", decimals.toString());
  console.log("Price multiplier:", priceMultiplier.toString());
  console.log("Calculated value:", calculatedValue.toString());
  
  // Check if calculatedValue > 0
  if (calculatedValue === 0n) {
    console.log("ERROR: calculatedValue is 0, would fail require(calculatedValue > 0)");
  } else {
    console.log("OK: calculatedValue > 0");
  }
  
  // Check overflow check
  const check1 = calculatedValue >= amount;
  const check2 = price >= priceMultiplier;
  const overflowCheck = check1 || check2;
  console.log("Overflow check:", overflowCheck);
  
  if (!overflowCheck) {
    console.log("ERROR: Overflow check would fail!");
  }
}

main().catch(console.error);
