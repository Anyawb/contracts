const hre = require("hardhat");

async function main() {
  // Test edge cases where calculatedValue might be 0
  const decimals = 6n;
  const testCases = [
    { amount: 1n, price: hre.ethers.parseUnits("1", Number(decimals)), decimals },
    { amount: 10n, price: hre.ethers.parseUnits("1", Number(decimals)), decimals },
    { amount: 50n, price: hre.ethers.parseUnits("1", Number(decimals)), decimals },
    { amount: 1n, price: hre.ethers.parseUnits("0.1", Number(decimals)), decimals },
  ];
  
  for (const testCase of testCases) {
    const { amount, price, decimals } = testCase;
    const priceMultiplier = 10n ** decimals;
    const calculatedValue = (amount * price) / priceMultiplier;
    
    console.log(`Amount: ${amount}, Price: ${price}, Decimals: ${decimals}`);
    console.log(`Calculated value: ${calculatedValue}`);
    
    if (calculatedValue === 0n) {
      console.log("ERROR: Calculated value is 0, would fail require!");
    } else {
      console.log("OK: Calculated value is > 0");
    }
    console.log("---");
  }
}

main().catch(console.error);
