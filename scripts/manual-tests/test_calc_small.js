const hre = require("hardhat");

async function main() {
  // Test with small amount and 8 decimals
  const amount = 10n;
  const price = hre.ethers.parseUnits("1", 8); // 1e8
  const decimals = 8n;
  
  const priceMultiplier = 10n ** decimals;
  const calculatedValue = (amount * price) / priceMultiplier;
  
  console.log("Amount:", amount.toString());
  console.log("Price:", price.toString());
  console.log("Decimals:", decimals.toString());
  console.log("Price multiplier:", priceMultiplier.toString());
  console.log("Calculated value:", calculatedValue.toString());
  
  // Check the overflow check
  const check1 = calculatedValue >= amount;
  const check2 = price >= priceMultiplier;
  const overflowCheck = check1 || check2;
  console.log("Overflow check (calculatedValue >= amount):", check1);
  console.log("Overflow check (price >= priceMultiplier):", check2);
  console.log("Overflow check result:", overflowCheck);
  
  if (calculatedValue === 0n) {
    console.log("ERROR: Calculated value is 0, would fail require!");
  }
  
  if (!overflowCheck) {
    console.log("ERROR: Overflow check would fail!");
  }
}

main().catch(console.error);
