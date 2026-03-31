import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

/**
 * Funds-Flow (SSOT) – Liquidation authority path
 *
 * Doc reference:
 * - docs/Usage-Guide/Funds-Flow-Architecture-Guide.md §6 (Liquidation)
 */

describe("Funds-Flow – Liquidation authority path", function () {
  const KEY_ACCESS_CONTROL = ethers.id("ACCESS_CONTROL_MANAGER");
  const KEY_CM = ethers.id("COLLATERAL_MANAGER");
  const KEY_LE = ethers.id("LENDING_ENGINE");
  const KEY_LIQUIDATION_RISK_MANAGER = ethers.id("LIQUIDATION_RISK_MANAGER");
  const KEY_POSITION_VIEW = ethers.id("POSITION_VIEW");
  const KEY_ORDER_ENGINE = ethers.id("ORDER_ENGINE");
  const KEY_LIQUIDATION_MANAGER = ethers.id("LIQUIDATION_MANAGER");

  const ACTION_LIQUIDATE = ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATE"));

  async function deployFixture() {
    const [owner, keeper, borrower] = await ethers.getSigners();

    const RegistryF = await ethers.getContractFactory("MockRegistry");
    const registry = await RegistryF.deploy();

    const ACMF = await ethers.getContractFactory("MockAccessControlManager");
    const acm = await ACMF.deploy();

    const CMF = await ethers.getContractFactory("MockCollateralManager");
    const cm = await CMF.deploy();

    const LEF = await ethers.getContractFactory("MockLendingEngineBasic");
    const le = await LEF.deploy();

    const RiskF = await ethers.getContractFactory("MockLiquidationRiskManager");
    const risk = await RiskF.deploy();

    const PVF = await ethers.getContractFactory("MockPositionViewValuation");
    const pv = await PVF.deploy();

    const OrderEngineF = await ethers.getContractFactory("MockOrderEngineForSettlementManager");
    const orderEngine = await OrderEngineF.deploy();

    const LiquidationManagerF = await ethers.getContractFactory("MockLiquidationManager");
    const liquidationManager = await LiquidationManagerF.deploy();

    const SettlementManagerF = await ethers.getContractFactory("SettlementManager");
    const settlementManager = await upgrades.deployProxy(
      SettlementManagerF,
      [registry.target],
      { kind: "uups", initializer: "initialize" }
    );

    await registry.setModule(KEY_ACCESS_CONTROL, acm.target);
    await registry.setModule(KEY_CM, cm.target);
    await registry.setModule(KEY_LE, le.target);
    await registry.setModule(KEY_LIQUIDATION_RISK_MANAGER, risk.target);
    await registry.setModule(KEY_POSITION_VIEW, pv.target);
    await registry.setModule(KEY_ORDER_ENGINE, orderEngine.target);
    await registry.setModule(KEY_LIQUIDATION_MANAGER, liquidationManager.target);

    await acm.grantRole(ACTION_LIQUIDATE, keeper.address);

    return { owner, keeper, borrower, registry, acm, cm, le, risk, pv, orderEngine, liquidationManager, settlementManager };
  }

  it("settleOrLiquidate routes to LiquidationManager and preserves keeper as liquidator", async function () {
    const { keeper, borrower, cm, le, risk, orderEngine, liquidationManager, settlementManager } =
      await loadFixture(deployFixture);

    const collateralAsset = ethers.Wallet.createRandom().address;
    const debtAsset = ethers.Wallet.createRandom().address;

    const currentBlock = await ethers.provider.getBlockNumber();
    const maturity = BigInt(currentBlock + 100);

    await orderEngine.setOrder(0, {
      principal: 40n,
      rate: 0n,
      term: 1n,
      borrower: borrower.address,
      lender: ethers.ZeroAddress,
      asset: debtAsset,
      startTimestamp: 1n,
      maturity,
      repaidAmount: 0n,
    });

    await le.setUserDebt(borrower.address, debtAsset, 40n);
    await cm.setUserCollateral(borrower.address, collateralAsset, 100n);
    await risk.setLiquidatable(borrower.address, true);

    await expect(settlementManager.connect(keeper).settleOrLiquidate(0))
      .to.emit(liquidationManager, "MockLiquidationExecuted")
      .withArgs(keeper.address, borrower.address, collateralAsset, debtAsset, 40n, 40n, 2n, anyValue);
  });

  it("reverts when caller lacks ACTION_LIQUIDATE", async function () {
    const { borrower, cm, le, risk, orderEngine, settlementManager, acm, owner } =
      await loadFixture(deployFixture);

    const collateralAsset = ethers.Wallet.createRandom().address;
    const debtAsset = ethers.Wallet.createRandom().address;

    await orderEngine.setOrder(1, {
      principal: 10n,
      rate: 0n,
      term: 1n,
      borrower: borrower.address,
      lender: ethers.ZeroAddress,
      asset: debtAsset,
      startTimestamp: 1n,
      maturity: 1n,
      repaidAmount: 0n,
    });

    await le.setUserDebt(borrower.address, debtAsset, 10n);
    await cm.setUserCollateral(borrower.address, collateralAsset, 20n);
    await risk.setLiquidatable(borrower.address, true);

    await acm.revokeRole(ACTION_LIQUIDATE, owner.address);

    await expect(settlementManager.connect(owner).settleOrLiquidate(1))
      .to.be.revertedWithCustomError(acm, "MissingRole");
  });
});
