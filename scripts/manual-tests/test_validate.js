const hre = require("hardhat");

async function main() {
  // Test validateDecimals logic
  const decimals = 18n;
  console.log("Testing decimals validation...");
  console.log("Decimals:", decimals.toString());
  console.log("Is valid (should be <= 18):", decimals <= 18n);
  
  // Test the actual calculation with small amount
  const amount = 10n;
  const price = hre.ethers.parseEther("1");
  const decimalsValue = 18n;
  const priceMultiplier = 10n ** decimalsValue;
  const calculatedValue = (amount * price) / priceMultiplier;
  
  console.log("Amount:", amount.toString());
  console.log("Price:", price.toString());
  console.log("Decimals:", decimalsValue.toString());
  console.log("Price multiplier:", priceMultiplier.toString());
  console.log("Calculated value:", calculatedValue.toString());
  
  // Check the overflow check
  const check1 = calculatedValue >= amount;
  const check2 = price >= priceMultiplier;
  const overflowCheck = check1 || check2;
  console.log("Overflow check (calculatedValue >= amount):", check1);
  console.log("Overflow check (price >= priceMultiplier):", check2);
  console.log("Overflow check result:", overflowCheck);
  
  if (!overflowCheck) {
    console.log("ERROR: Overflow check would fail!");
  }
}

main().catch(console.error);
