const hre = require("hardhat");

async function main() {
  // Test edge cases where calculatedValue might be 0
  const testCases = [
    { amount: 1n, price: hre.ethers.parseUnits("1", 8), decimals: 8n },
    { amount: 10n, price: hre.ethers.parseUnits("1", 8), decimals: 8n },
    { amount: 50n, price: hre.ethers.parseUnits("1", 8), decimals: 8n },
    { amount: 1n, price: hre.ethers.parseUnits("0.1", 8), decimals: 8n }, // 0.1 * 10^8 = 1e7
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
