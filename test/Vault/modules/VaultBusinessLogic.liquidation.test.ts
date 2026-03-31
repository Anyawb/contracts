import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

describe("VaultBusinessLogic - liquidation entry is deprecated", function () {
  const KEY_ACCESS_CONTROL = ethers.id("ACCESS_CONTROL_MANAGER");
  const KEY_CM = ethers.id("COLLATERAL_MANAGER");
  const KEY_LE = ethers.id("LENDING_ENGINE");
  const KEY_LIQUIDATION_RISK_MANAGER = ethers.id("LIQUIDATION_RISK_MANAGER");
  const KEY_POSITION_VIEW = ethers.id("POSITION_VIEW");
  const KEY_ORDER_ENGINE = ethers.id("ORDER_ENGINE");
  const KEY_LIQUIDATION_MANAGER = ethers.id("LIQUIDATION_MANAGER");
  const ACTION_LIQUIDATE = ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATE"));

  async function deployFixture() {
    const registry = await (await ethers.getContractFactory("MockRegistry")).deploy();
    const settlementToken = await (await ethers.getContractFactory("MockERC20")).deploy(
      "Settlement Token",
      "SET",
      18,
      ethers.parseUnits("1000000", 18)
    );

    const VBL = await ethers.getContractFactory("VaultBusinessLogic");
    const vbl = await upgrades.deployProxy(VBL, [await registry.getAddress(), await settlementToken.getAddress()], {
      kind: "uups",
      initializer: "initialize",
      unsafeAllow: ["constructor"],
    });

    return { vbl };
  }

  async function deploySettlementFixture() {
    const [owner, keeper, borrower] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory("MockRegistry")).deploy();
    const acm = await (await ethers.getContractFactory("MockAccessControlManager")).deploy();
    const cm = await (await ethers.getContractFactory("MockCollateralManager")).deploy();
    const le = await (await ethers.getContractFactory("MockLendingEngineBasic")).deploy();
    const risk = await (await ethers.getContractFactory("MockLiquidationRiskManager")).deploy();
    const pvVal = await (await ethers.getContractFactory("MockPositionViewValuation")).deploy();
    const orderEngine = await (await ethers.getContractFactory("MockOrderEngineForSettlementManager")).deploy();
    const liquidationManager = await (await ethers.getContractFactory("MockLiquidationManager")).deploy();

    const SettlementManager = await ethers.getContractFactory("SettlementManager");
    const settlementManager = await upgrades.deployProxy(SettlementManager, [await registry.getAddress()], {
      kind: "uups",
      initializer: "initialize",
    });

    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(KEY_CM, await cm.getAddress());
    await registry.setModule(KEY_LE, await le.getAddress());
    await registry.setModule(KEY_LIQUIDATION_RISK_MANAGER, await risk.getAddress());
    await registry.setModule(KEY_POSITION_VIEW, await pvVal.getAddress());
    await registry.setModule(KEY_ORDER_ENGINE, await orderEngine.getAddress());
    await registry.setModule(KEY_LIQUIDATION_MANAGER, await liquidationManager.getAddress());

    await acm.grantRole(ACTION_LIQUIDATE, keeper.address);

    const debtAsset = ethers.Wallet.createRandom().address;
    await orderEngine.setOrder(0, {
      principal: 100n,
      rate: 0n,
      term: 30n,
      borrower: borrower.address,
      lender: owner.address,
      asset: debtAsset,
      startTimestamp: 1n,
      maturity: 1n,
      repaidAmount: 0n,
    });

    await cm.setUserCollateral(borrower.address, debtAsset, 100n);
    await le.setUserDebt(borrower.address, debtAsset, 50n);
    await risk.setLiquidatable(borrower.address, true);

    return { settlementManager, liquidationManager, keeper, borrower, debtAsset };
  }

  it("VBL.liquidate should revert and force using LiquidationManager", async function () {
    const { vbl } = await loadFixture(deployFixture);

    expect((vbl as any).liquidate).to.equal(undefined);
  });

  it("清算入口走 SettlementManager（SSOT）", async function () {
    const { settlementManager, liquidationManager, keeper, borrower, debtAsset } =
      await loadFixture(deploySettlementFixture);

    const tx = await settlementManager.connect(keeper).settleOrLiquidate(0);
    await expect(tx)
      .to.emit(liquidationManager, "MockLiquidationExecuted")
      .withArgs(keeper.address, borrower.address, debtAsset, debtAsset, anyValue, anyValue, anyValue, anyValue);
  });
});

