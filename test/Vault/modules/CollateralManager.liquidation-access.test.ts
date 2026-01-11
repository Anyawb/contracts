import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const KEY_VAULT_CORE = ethers.id("VAULT_CORE");
const KEY_LE = ethers.id("LENDING_ENGINE");
const KEY_LIQUIDATION_MANAGER = ethers.id("LIQUIDATION_MANAGER");
const KEY_PRICE_ORACLE = ethers.id("PRICE_ORACLE");
const KEY_POSITION_VIEW = ethers.id("POSITION_VIEW");

describe("CollateralManager - liquidation caller access", function () {
  async function deployFixture() {
    const [deployer, liquidationManager, user] = await ethers.getSigners();

    const MockRegistry = await ethers.getContractFactory("MockRegistry");
    const registry = await MockRegistry.deploy();

    const MockVaultCore = await ethers.getContractFactory("MockVaultCoreView");
    const vaultCore = await MockVaultCore.deploy();

    const MockVaultRouter = await ethers.getContractFactory("MockVaultRouter");
    const vaultRouter = await MockVaultRouter.deploy();
    await vaultCore.setViewContractAddr(await vaultRouter.getAddress());

    const MockLendingEngine = await ethers.getContractFactory("MockLendingEngineBasic");
    const lendingEngine = await MockLendingEngine.deploy();

    const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
    const priceOracle = await MockPriceOracle.deploy();

    // PositionView is required for CM versioning helper (_getNextVersion)
    const MockPositionView = await ethers.getContractFactory("MockPositionView");
    const positionView = await MockPositionView.deploy();
    await positionView.waitForDeployment();

    // Wire registry modules for CM dependencies
    await registry.setModule(KEY_VAULT_CORE, await vaultCore.getAddress());
    await registry.setModule(KEY_LE, await lendingEngine.getAddress());
    await registry.setModule(KEY_LIQUIDATION_MANAGER, liquidationManager.address);
    await registry.setModule(KEY_PRICE_ORACLE, await priceOracle.getAddress());
    await registry.setModule(KEY_POSITION_VIEW, await positionView.getAddress());

    const CollateralManager = await ethers.getContractFactory("CollateralManager");
    const cmImpl = await CollateralManager.deploy();
    await cmImpl.waitForDeployment();
    const Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const initData = cmImpl.interface.encodeFunctionData("initialize(address)", [await registry.getAddress()]);
    const proxy = await Proxy.deploy(cmImpl.target, initData);
    await proxy.waitForDeployment();
    const collateralManager = CollateralManager.attach(proxy.target);

    // Seed user collateral using a real ERC20 token (CM pulls from user via transferFrom)
    const Token = await ethers.getContractFactory("MockERC20");
    const token = await Token.deploy("Test Token", "TST", ethers.parseUnits("1000000", 18));
    await token.waitForDeployment();
    const asset = await token.getAddress();
    await token.mint(user.address, 1000n);
    await token.connect(user).approve(await collateralManager.getAddress(), 1000n);

    // deposit must be called by VaultRouter or VaultCore; impersonate VaultRouter
    await ethers.provider.send("hardhat_setBalance", [await vaultRouter.getAddress(), "0x3635C9ADC5DEA00000"]); // 1000 ETH
    await ethers.provider.send("hardhat_impersonateAccount", [await vaultRouter.getAddress()]);
    const viewSigner = await ethers.getSigner(await vaultRouter.getAddress());
    await collateralManager.connect(viewSigner).depositCollateral(user.address, asset, 100n);
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [await vaultRouter.getAddress()]);

    return { collateralManager, liquidationManager, user, asset };
  }

  it("allows LiquidationManager to withdraw collateral for seizure", async function () {
    const { collateralManager, liquidationManager, user, asset } = await loadFixture(deployFixture);

    // Liquidation path uses withdrawCollateralTo(receiver!=user) (LiquidationManager allowed)
    await collateralManager.connect(liquidationManager).withdrawCollateralTo(user.address, asset, 40n, liquidationManager.address);

    expect(await collateralManager.getCollateral(user.address, asset)).to.equal(60n);
  });
});





