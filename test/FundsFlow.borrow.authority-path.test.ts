import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Funds-Flow (SSOT) – Borrow ledger write (borrowFor)
 *
 * Doc reference:
 * - docs/Usage-Guide/Funds-Flow-Architecture-Guide.md §3 (Match → Borrow Disbursement)
 */

describe("Funds-Flow – Borrow ledger write", function () {
  const KEY_LE = ethers.id("LENDING_ENGINE");
  const KEY_VAULT_BUSINESS_LOGIC = ethers.id("VAULT_BUSINESS_LOGIC");
  const KEY_ORDER_ENGINE = ethers.id("ORDER_ENGINE");
  const KEY_SETTLEMENT_MANAGER = ethers.id("SETTLEMENT_MANAGER");
  const KEY_LIQUIDATION_MANAGER = ethers.id("LIQUIDATION_MANAGER");
  const KEY_CM = ethers.id("COLLATERAL_MANAGER");

  async function deployFixture() {
    const [owner, other, orderEngine, settlementManager, liquidationManager, collateralManager] = await ethers.getSigners();

    const RegistryF = await ethers.getContractFactory("MockRegistry");
    const registry = await RegistryF.deploy();

    const VaultRouterF = await ethers.getContractFactory("MockVaultRouter");
    const vaultRouter = await VaultRouterF.deploy();

    const VaultCoreF = await ethers.getContractFactory("VaultCore");
    const vaultCore = await upgrades.deployProxy(
      VaultCoreF,
      [registry.target, await vaultRouter.getAddress()],
      { kind: "uups", initializer: "initialize" }
    );

    const LEF = await ethers.getContractFactory("MockLendingEngineBasic");
    const le = await LEF.deploy();

    await registry.setModule(KEY_LE, le.target);
    await registry.setModule(KEY_VAULT_BUSINESS_LOGIC, owner.address);

    // Register other core modules to prove they can no longer call borrowFor directly.
    await registry.setModule(KEY_ORDER_ENGINE, orderEngine.address);
    await registry.setModule(KEY_SETTLEMENT_MANAGER, settlementManager.address);
    await registry.setModule(KEY_LIQUIDATION_MANAGER, liquidationManager.address);
    await registry.setModule(KEY_CM, collateralManager.address);

    return { owner, other, orderEngine, settlementManager, liquidationManager, collateralManager, vaultCore, le };
  }

  it("borrowFor can only be called by business modules and writes debt ledger", async function () {
    const {
      owner,
      other,
      orderEngine,
      settlementManager,
      liquidationManager,
      collateralManager,
      vaultCore,
      le,
    } = await loadFixture(deployFixture);

    const asset = ethers.Wallet.createRandom().address;

    await expect(vaultCore.connect(other).borrowFor(other.address, asset, 1, 30))
      .to.be.revertedWithCustomError(vaultCore, "VaultCore__UnauthorizedModule");

    await expect(vaultCore.connect(orderEngine).borrowFor(other.address, asset, 1, 30))
      .to.be.revertedWithCustomError(vaultCore, "VaultCore__UnauthorizedModule");

    await expect(vaultCore.connect(settlementManager).borrowFor(other.address, asset, 1, 30))
      .to.be.revertedWithCustomError(vaultCore, "VaultCore__UnauthorizedModule");

    await expect(vaultCore.connect(liquidationManager).borrowFor(other.address, asset, 1, 30))
      .to.be.revertedWithCustomError(vaultCore, "VaultCore__UnauthorizedModule");

    await expect(vaultCore.connect(collateralManager).borrowFor(other.address, asset, 1, 30))
      .to.be.revertedWithCustomError(vaultCore, "VaultCore__UnauthorizedModule");

    await vaultCore.connect(owner).borrowFor(other.address, asset, 100, 30);

    expect(await le.getDebt(other.address, asset)).to.equal(100n);
  });
});
