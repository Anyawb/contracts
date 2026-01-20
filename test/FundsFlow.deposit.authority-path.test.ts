import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Funds-Flow (SSOT) – Deposit authority path
 *
 * Doc reference:
 * - docs/Usage-Guide/Funds-Flow-Architecture-Guide.md §1.1 (Deposit)
 *
 * Assertions (chain facts):
 * - User calls VaultCore.deposit(asset, amount)
 * - VaultCore routes via VaultRouter.processUserOperation(ACTION_DEPOSIT, ...)
 * - VaultRouter routes to CollateralManager.depositCollateral(user, asset, amount)
 * - Funds are pulled into CollateralManager (spender must be CollateralManager)
 * - CollateralManager ledger updates + emits DepositProcessed and DataPushed(DEPOSIT_PROCESSED, payload)
 * - User MUST NOT be able to call VaultRouter.processUserOperation directly
 * - User MUST NOT be able to call CollateralManager.depositCollateral directly
 */
describe("Funds-Flow – Deposit authority path", function () {
  const KEY_VAULT_CORE = ethers.id("VAULT_CORE");
  const KEY_CM = ethers.id("COLLATERAL_MANAGER");
  const KEY_LE = ethers.id("LENDING_ENGINE");
  const KEY_POSITION_VIEW = ethers.id("POSITION_VIEW");

  const DATA_TYPE_DEPOSIT_PROCESSED = ethers.keccak256(ethers.toUtf8Bytes("DEPOSIT_PROCESSED"));
  const ACTION_DEPOSIT = ethers.keccak256(ethers.toUtf8Bytes("DEPOSIT"));

  async function deployFixture() {
    const [deployer, user] = await ethers.getSigners();

    // Minimal registry (test-only; no access control)
    const MockRegistry = await ethers.getContractFactory("MockRegistry");
    const registry = await MockRegistry.deploy();

    // Collateral asset (also used as settlement token for router init; irrelevant for deposit path)
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const collateralToken = await MockERC20.deploy("Mock USDC", "USDC", ethers.parseUnits("1000000", 18));

    // Give user balance
    await (await collateralToken.transfer(user.address, ethers.parseUnits("10000", 18))).wait();

    // AssetWhitelist mock
    const MockAssetWhitelist = await ethers.getContractFactory("MockAssetWhitelist");
    const assetWhitelist = await MockAssetWhitelist.deploy();
    await (await assetWhitelist.setAssetAllowed(await collateralToken.getAddress(), true)).wait();

    // PriceOracle mock (router requires an address; deposit path doesn’t use it)
    const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
    const priceOracle = await MockPriceOracle.deploy();

    // PositionView mock (CollateralManager requires it for nextVersion)
    const MockPositionView = await ethers.getContractFactory("MockPositionView");
    const positionView = await MockPositionView.deploy();

    // Dummy LendingEngineBasic (VaultRouter caches CM+LE)
    const MockLendingEngineBasic = await ethers.getContractFactory("MockLendingEngineBasic");
    const lendingEngineBasic = await MockLendingEngineBasic.deploy();

    // Deploy VaultRouter (UUPS proxy)
    const VaultRouter = await ethers.getContractFactory("VaultRouter");
    const vaultRouter = await upgrades.deployProxy(
      VaultRouter,
      [
        await registry.getAddress(),
        await assetWhitelist.getAddress(),
        await priceOracle.getAddress(),
        await collateralToken.getAddress(), // settlement token placeholder
        deployer.address, // initialOwner (UUPS)
      ],
      { kind: "uups", initializer: "initialize" }
    );

    // Deploy VaultCore (UUPS proxy; needs view address = VaultRouter)
    const VaultCore = await ethers.getContractFactory("VaultCore");
    const vaultCore = await upgrades.deployProxy(
      VaultCore,
      [await registry.getAddress(), await vaultRouter.getAddress()],
      { kind: "uups", initializer: "initialize" }
    );

    // Deploy CollateralManager (UUPS proxy; legacy overloaded initializer => specify)
    const CollateralManager = await ethers.getContractFactory("CollateralManager");
    const collateralManager = await upgrades.deployProxy(
      CollateralManager,
      [await registry.getAddress()],
      { kind: "uups", initializer: "initialize(address)" }
    );

    // Register modules (minimal set for deposit)
    await (await registry.setModule(KEY_VAULT_CORE, await vaultCore.getAddress())).wait();
    await (await registry.setModule(KEY_CM, await collateralManager.getAddress())).wait();
    await (await registry.setModule(KEY_LE, await lendingEngineBasic.getAddress())).wait();
    await (await registry.setModule(KEY_POSITION_VIEW, await positionView.getAddress())).wait();

    return {
      deployer,
      user,
      registry,
      collateralToken,
      assetWhitelist,
      priceOracle,
      positionView,
      lendingEngineBasic,
      vaultRouter,
      vaultCore,
      collateralManager,
    };
  }

  it("routes VaultCore.deposit -> VaultRouter -> CollateralManager, updates ledger, emits events", async function () {
    const { user, collateralToken, vaultCore, vaultRouter, collateralManager } = await loadFixture(deployFixture);

    const amount = ethers.parseUnits("123", 18);
    const asset = await collateralToken.getAddress();

    // Spender MUST be CollateralManager (not VaultCore/VaultRouter)
    await (await collateralToken.connect(user).approve(await collateralManager.getAddress(), amount)).wait();

    const userBalBefore = await collateralToken.balanceOf(user.address);
    const cmBalBefore = await collateralToken.balanceOf(await collateralManager.getAddress());

    const tx = await vaultCore.connect(user).deposit(asset, amount);

    // Emitted by CollateralManager
    await expect(tx)
      .to.emit(collateralManager, "DepositProcessed")
      .withArgs(user.address, asset, amount, anyValue);

    // Emitted by DataPushLibrary (from CollateralManager address)
    await expect(tx).to.emit(collateralManager, "DataPushed").withArgs(DATA_TYPE_DEPOSIT_PROCESSED, anyValue);

    // Funds moved into CollateralManager
    const userBalAfter = await collateralToken.balanceOf(user.address);
    const cmBalAfter = await collateralToken.balanceOf(await collateralManager.getAddress());
    expect(userBalAfter).to.equal(userBalBefore - amount);
    expect(cmBalAfter).to.equal(cmBalBefore + amount);

    // Ledger updated in CollateralManager
    const ledger = await collateralManager.getCollateral(user.address, asset);
    expect(ledger).to.equal(amount);
  });

  it("rejects user calling VaultRouter.processUserOperation directly (onlyVaultCore)", async function () {
    const { user, collateralToken, vaultRouter } = await loadFixture(deployFixture);
    const asset = await collateralToken.getAddress();
    const amount = 1n;

    await expect(
      vaultRouter.connect(user).processUserOperation(user.address, ACTION_DEPOSIT, asset, amount, 0)
    ).to.be.revertedWithCustomError(vaultRouter, "VaultRouter__UnauthorizedAccess");
  });

  it("rejects user calling CollateralManager.depositCollateral directly (onlyVaultRouterOrCore)", async function () {
    const { user, collateralToken, collateralManager } = await loadFixture(deployFixture);
    const asset = await collateralToken.getAddress();
    const amount = 1n;

    await expect(collateralManager.connect(user).depositCollateral(user.address, asset, amount))
      .to.be.revertedWithCustomError(collateralManager, "CollateralManager__UnauthorizedAccess");
  });

  it("reverts deposit when spender is misconfigured (approve VaultCore instead of CollateralManager)", async function () {
    const { user, collateralToken, vaultCore, collateralManager } = await loadFixture(deployFixture);
    const asset = await collateralToken.getAddress();
    const amount = 10n;

    // Wrong spender: VaultCore (should be CollateralManager)
    await (await collateralToken.connect(user).approve(await vaultCore.getAddress(), amount)).wait();

    await expect(vaultCore.connect(user).deposit(asset, amount)).to.be.reverted;

    // Ledger must not change
    const ledger = await collateralManager.getCollateral(user.address, asset);
    expect(ledger).to.equal(0n);
  });
});

