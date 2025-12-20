const hre = require("hardhat");

async function main() {
  const [vaultCore, user] = await hre.ethers.getSigners();
  
  const CM = await hre.ethers.getContractFactory("MockCollateralManager");
  const cm = await CM.deploy();
  
  const debtAsset = hre.ethers.Wallet.createRandom().address;
  
  console.log("Testing depositCollateral...");
  try {
    const tx = await cm.depositCollateral(user.address, debtAsset, 200);
    console.log("depositCollateral succeeded! Tx:", tx.hash);
    await tx.wait();
  } catch (e) {
    console.log("depositCollateral failed:", e.message);
  }
  
  console.log("Testing getCollateral...");
  try {
    const collateral = await cm.getCollateral(user.address, debtAsset);
    console.log("getCollateral result:", collateral.toString());
  } catch (e) {
    console.log("getCollateral failed:", e.message);
  }
  
  console.log("Testing getUserTotalCollateralValue...");
  try {
    const total = await cm.getUserTotalCollateralValue(user.address);
    console.log("getUserTotalCollateralValue result:", total.toString());
  } catch (e) {
    console.log("getUserTotalCollateralValue failed:", e.message);
  }
}

main().catch(console.error);
