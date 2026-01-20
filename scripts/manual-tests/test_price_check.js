const hre = require("hardhat");

async function main() {
  const price = hre.ethers.parseUnits("1", 8); // 1e8
  const DEFAULT_MAX_REASONABLE_PRICE = 1e12;
  
  console.log("Price:", price.toString());
  console.log("DEFAULT_MAX_REASONABLE_PRICE:", DEFAULT_MAX_REASONABLE_PRICE);
  console.log("Price <= DEFAULT_MAX_REASONABLE_PRICE:", price <= BigInt(DEFAULT_MAX_REASONABLE_PRICE));
  
  if (price > BigInt(DEFAULT_MAX_REASONABLE_PRICE)) {
    console.log("ERROR: Price validation would fail!");
  } else {
    console.log("OK: Price validation should pass");
  }
}

main().catch(console.error);
