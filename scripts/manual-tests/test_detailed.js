const hre = require("hardhat");

async function main() {
  const [vaultCore, user] = await hre.ethers.getSigners();
  
  const Registry = await hre.ethers.getContractFactory("MockRegistry");
  const registry = await Registry.deploy();
  
  const PriceOracle = await hre.ethers.getContractFactory("MockPriceOracle");
  const priceOracle = await PriceOracle.deploy();
  
  const ERC20 = await hre.ethers.getContractFactory("MockERC20");
  const settlementToken = await ERC20.deploy("Settlement", "ST", hre.ethers.parseEther("1000000"));
  
  const nowTs = Math.floor(Date.now() / 1000);
  await priceOracle.connect(vaultCore).setPrice(await settlementToken.getAddress(), hre.ethers.parseEther("1"), nowTs, 18);
  const debtAsset = hre.ethers.Wallet.createRandom().address;
  await priceOracle.connect(vaultCore).setPrice(debtAsset, hre.ethers.parseEther("1"), nowTs, 18);
  
  const LendingEngine = await hre.ethers.getContractFactory("VaultLendingEngine");
  const lending = await LendingEngine.deploy();
  await lending.initialize(await priceOracle.getAddress(), await settlementToken.getAddress(), await registry.getAddress());
  
  const CM = await hre.ethers.getContractFactory("MockCollateralManager");
  const cm = await CM.deploy();
  
  const VaultRouter = await hre.ethers.getContractFactory("MockVaultRouter");
  const vaultRouter = await VaultRouter.deploy();
  
  const HealthView = await hre.ethers.getContractFactory("MockHealthView");
  const healthView = await HealthView.deploy();
  
  const LRM = await hre.ethers.getContractFactory("MockLiquidationRiskManager");
  const lrm = await LRM.deploy();
  
  const VaultCoreView = await hre.ethers.getContractFactory("MockVaultCoreView");
  const vaultCoreModule = await VaultCoreView.deploy();
  
  await vaultCoreModule.setViewContractAddr(await vaultRouter.getAddress());
  await vaultCoreModule.setLendingEngine(await lending.getAddress());
  
  const KEY_VAULT_CORE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("VAULT_CORE"));
  const KEY_CM = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("COLLATERAL_MANAGER"));
  const KEY_HEALTH_VIEW = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("HEALTH_VIEW"));
  const KEY_LIQUIDATION_RISK_MANAGER = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("LIQUIDATION_RISK_MANAGER"));
  
  await registry.setModule(KEY_VAULT_CORE, await vaultCoreModule.getAddress());
  await registry.setModule(KEY_CM, await cm.getAddress());
  await registry.setModule(KEY_HEALTH_VIEW, await healthView.getAddress());
  await registry.setModule(KEY_LIQUIDATION_RISK_MANAGER, await lrm.getAddress());
  
  await cm.depositCollateral(user.address, debtAsset, 200);
  
  console.log("All modules registered. Testing borrow...");
  
  try {
    const tx = await vaultCoreModule.borrow(user.address, debtAsset, 10, 0, 0);
    console.log("Borrow succeeded! Tx:", tx.hash);
    const receipt = await tx.wait();
    console.log("Gas used:", receipt.gasUsed.toString());
  } catch (e) {
    console.log("Borrow failed:");
    console.log("Error message:", e.message);
    if (e.reason) console.log("Reason:", e.reason);
    if (e.data) console.log("Data:", e.data);
    if (e.error) console.log("Error object:", JSON.stringify(e.error, null, 2));
  }
}

main().catch(console.error);
