import { expect } from "chai";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const KEY_LE = ethers.id("LENDING_ENGINE");
const KEY_CM = ethers.id("COLLATERAL_MANAGER");
const KEY_VAULT_CORE = ethers.id("VAULT_CORE");

describe("LiquidationDebtManager - 缓存推送强制执行", function () {
  async function deployFixture() {
    // This module's access control bootstrap grants admin + liquidator roles to the same `initialAccessControl` address.
    // For this focused cache-push test we use a single privileged signer.
    const [admin, user] = await ethers.getSigners();
    const liquidator = admin;

    const Collateral = await ethers.getContractFactory("MockCollateralManager");
    const collateral = await Collateral.deploy();
    const Lending = await ethers.getContractFactory("MockLendingEngineBasic");
    const lending = await Lending.deploy();
    const VaultCore = await ethers.getContractFactory("MockVaultCoreView");
    const vaultCore = await VaultCore.deploy();
    const RevertingView = await ethers.getContractFactory("RevertingVaultView");
    const revertingView = await RevertingView.deploy();

    // `LiquidationDebtManager` is abstract; harness makes it deployable for tests.
    const LDM = await ethers.getContractFactory("LiquidationDebtManagerHarness");
    const ldm = await upgrades.deployProxy(LDM, {
      kind: "uups",
      initializer: false, // manual init to avoid double-initialize guard
      unsafeAllow: ["constructor", "missing-initializer"],
    });
    await ldm.initialize(admin.address, admin.address); // registryAddr, accessControlOwner/keeper

    // 配置模块缓存
    await ldm.connect(admin).updateModule(KEY_LE, await lending.getAddress());
    await ldm.connect(admin).updateModule(KEY_CM, await collateral.getAddress());

    // 设置账本初始状态
    const asset = ethers.Wallet.createRandom().address;
    await collateral.depositCollateral(user.address, asset, 100n);
    // Use `borrow` instead of `setUserDebt` so MockLendingEngineBasic internal totals stay consistent
    await lending.borrow(user.address, asset, 80n, 0n, 0);

    return { admin, liquidator, user, asset, collateral, lending, ldm, vaultCore, revertingView };
  }

  it("view 地址缺失时应直接回滚", async function () {
    const { ldm, liquidator, user, asset } = await loadFixture(deployFixture);

    await expect(
      ldm.connect(liquidator).reduceDebt(user.address, asset, 10n, liquidator.address)
    ).to.emit(ldm, "CacheUpdateFailed")
      .withArgs(user.address, asset, ethers.ZeroAddress, 100n, 80n, anyValue);
  });

  it("推送到 View 失败时应回滚（不再静默）", async function () {
    const { admin, ldm, liquidator, user, asset, vaultCore, revertingView } = await loadFixture(deployFixture);

    await vaultCore.setViewContractAddr(await revertingView.getAddress());
    await ldm.connect(admin).updateModule(KEY_VAULT_CORE, await vaultCore.getAddress());

    await expect(
      ldm.connect(liquidator).reduceDebt(user.address, asset, 10n, liquidator.address)
    ).to.emit(ldm, "CacheUpdateFailed")
      .withArgs(user.address, asset, await revertingView.getAddress(), 100n, 80n, anyValue);
  });
});

