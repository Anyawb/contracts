const hre = require("hardhat");

async function main() {
  const [vaultCore, user] = await hre.ethers.getSigners();
  
  // Deploy all mocks
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
  
  const VaultCoreView = await hre.ethers.getContractFactory("MockVaultCoreView");
  const vaultCoreModule = await VaultCoreView.deploy();
  
  const VaultRouter = await hre.ethers.getContractFactory("MockVaultRouter");
  const vaultRouter = await VaultRouter.deploy();
  
  await vaultCoreModule.setViewContractAddr(await vaultRouter.getAddress());
  await vaultCoreModule.setLendingEngine(await lending.getAddress());
  
  const KEY_VAULT_CORE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("VAULT_CORE"));
  await registry.setModule(KEY_VAULT_CORE, await vaultCoreModule.getAddress());
  
  console.log("Setup complete. Testing borrow...");
  
  try {
    const tx = await vaultCoreModule.borrow(user.address, debtAsset, 10, 0, 0);
    console.log("Borrow succeeded! Tx:", tx.hash);
    await tx.wait();
  } catch (e) {
    console.log("Borrow failed:");
    console.log("Error message:", e.message);
    if (e.reason) console.log("Reason:", e.reason);
    if (e.data) console.log("Data:", e.data);
  }
}

main().catch(console.error);
