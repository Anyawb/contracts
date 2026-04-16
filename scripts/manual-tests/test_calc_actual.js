const hre = require("hardhat");

async function main() {
  // Test the exact values from the test
  const amount = 50n;
  const decimals = 6n;
  const price = hre.ethers.parseUnits("1", Number(decimals));
  
  // Calculate as Solidity would
  const priceMultiplier = 10n ** decimals;
  const numerator = amount * price;
  const calculatedValue = numerator / priceMultiplier;
  
  console.log("Amount:", amount.toString());
  console.log("Price:", price.toString());
  console.log("Decimals:", decimals.toString());
  console.log("Price multiplier:", priceMultiplier.toString());
  console.log("Numerator (amount * price):", numerator.toString());
  console.log("Calculated value:", calculatedValue.toString());
  
  // Check the require statements
  if (calculatedValue === 0n) {
    console.log("ERROR: calculatedValue is 0, would fail require!");
  } else {
    console.log("OK: calculatedValue > 0");
  }
  
  // Check overflow check
  const check1 = calculatedValue >= amount;
  const check2 = price >= priceMultiplier;
  console.log("calculatedValue >= amount:", check1, `(${calculatedValue} >= ${amount})`);
  console.log("price >= priceMultiplier:", check2, `(${price} >= ${priceMultiplier})`);
  console.log("Overflow check result:", check1 || check2);
  
  if (!(check1 || check2)) {
    console.log("ERROR: Overflow check would fail!");
  }
}

main().catch(console.error);
