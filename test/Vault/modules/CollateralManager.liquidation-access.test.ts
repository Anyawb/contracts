import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const KEY_VAULT_CORE = ethers.id("VAULT_CORE");
const KEY_LE = ethers.id("LENDING_ENGINE");
const KEY_LIQUIDATION_MANAGER = ethers.id("LIQUIDATION_MANAGER");

describe("CollateralManager - liquidation caller access", function () {
  async function deployFixture() {
    const [deployer, liquidationManager, user] = await ethers.getSigners();

    const MockRegistry = await ethers.getContractFactory("MockRegistry");
    const registry = await MockRegistry.deploy();

    const MockVaultCore = await ethers.getContractFactory("MockVaultCoreView");
    const vaultCore = await MockVaultCore.deploy();

    const MockVaultView = await ethers.getContractFactory("MockVaultView");
    const vaultView = await MockVaultView.deploy();
    await vaultCore.setViewContractAddr(await vaultView.getAddress());

    const MockLendingEngine = await ethers.getContractFactory("MockLendingEngineBasic");
    const lendingEngine = await MockLendingEngine.deploy();

    // Wire registry modules for CM dependencies
    await registry.setModule(KEY_VAULT_CORE, await vaultCore.getAddress());
    await registry.setModule(KEY_LE, await lendingEngine.getAddress());
    await registry.setModule(KEY_LIQUIDATION_MANAGER, liquidationManager.address);

    const CollateralManager = await ethers.getContractFactory("CollateralManager");
    const collateralManager = await CollateralManager.deploy();
    await collateralManager.initialize(await registry.getAddress());

    // Seed user collateral through VaultView caller
    const asset = ethers.Wallet.createRandom().address;
    await ethers.provider.send("hardhat_setBalance", [vaultView.address, "0x3635C9ADC5DEA00000"]); // 1000 ETH
    const viewSigner = await ethers.getImpersonatedSigner(vaultView.address);
    await collateralManager.connect(viewSigner).depositCollateral(user.address, asset, 100n);

    return { collateralManager, liquidationManager, user, asset };
  }

  it("allows LiquidationManager to withdraw collateral for seizure", async function () {
    const { collateralManager, liquidationManager, user, asset } = await loadFixture(deployFixture);

    await collateralManager.connect(liquidationManager).withdrawCollateral(user.address, asset, 40n);

    expect(await collateralManager.getCollateral(user.address, asset)).to.equal(60n);
  });
});





