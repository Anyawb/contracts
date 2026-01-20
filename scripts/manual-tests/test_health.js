const hre = require("hardhat");

async function main() {
  const [vaultCore, user] = await hre.ethers.getSigners();
  
  const LRM = await hre.ethers.getContractFactory("MockLiquidationRiskManager");
  const lrm = await LRM.deploy();
  
  const HealthView = await hre.ethers.getContractFactory("MockHealthView");
  const healthView = await HealthView.deploy();
  
  const CM = await hre.ethers.getContractFactory("MockCollateralManager");
  const cm = await CM.deploy();
  
  console.log("Testing getMinHealthFactor...");
  try {
    const minHF = await lrm.getMinHealthFactor();
    console.log("getMinHealthFactor result:", minHF.toString());
  } catch (e) {
    console.log("getMinHealthFactor failed:", e.message);
  }
  
  console.log("Testing getUserTotalCollateralValue...");
  try {
    await cm.depositCollateral(user.address, hre.ethers.Wallet.createRandom().address, 200);
    const total = await cm.getUserTotalCollateralValue(user.address);
    console.log("getUserTotalCollateralValue result:", total.toString());
  } catch (e) {
    console.log("getUserTotalCollateralValue failed:", e.message);
  }
  
  console.log("Testing pushRiskStatus...");
  try {
    const tx = await healthView.pushRiskStatus(user.address, 15000, 11000, false, Math.floor(Date.now() / 1000));
    console.log("pushRiskStatus succeeded! Tx:", tx.hash);
    await tx.wait();
    
    const hf = await healthView.getUserHealthFactor(user.address);
    console.log("Health factor after update:", hf.toString());
  } catch (e) {
    console.log("pushRiskStatus failed:", e.message);
  }
}

main().catch(console.error);
