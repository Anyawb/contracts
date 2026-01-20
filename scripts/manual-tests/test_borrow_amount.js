const hre = require("hardhat");

async function main() {
  // Test with amount 50 and 8 decimals
  const amount = 50n;
  const price = hre.ethers.parseUnits("1", 8); // 1e8
  const decimals = 8n;
  
  const priceMultiplier = 10n ** decimals;
  const calculatedValue = (amount * price) / priceMultiplier;
  
  console.log("Amount:", amount.toString());
  console.log("Price:", price.toString());
  console.log("Decimals:", decimals.toString());
  console.log("Price multiplier:", priceMultiplier.toString());
  console.log("Calculated value:", calculatedValue.toString());
  
  if (calculatedValue === 0n) {
    console.log("ERROR: Calculated value is 0, would fail require!");
  } else {
    console.log("OK: Calculated value is > 0");
  }
  
  // Check the overflow check
  const check1 = calculatedValue >= amount;
  const check2 = price >= priceMultiplier;
  const overflowCheck = check1 || check2;
  console.log("Overflow check result:", overflowCheck);
}

main().catch(console.error);
