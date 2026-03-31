import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

import { ModuleKeys } from "../../../frontend-config/moduleKeys";

describe("SettlementManager - settleOrLiquidate (SSOT)", function () {
  const ACTION_LIQUIDATE = ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATE"));
  const ACTION_DEPOSIT = ethers.keccak256(ethers.toUtf8Bytes("DEPOSIT"));
  const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes("SET_PARAMETER"));

  async function deployFixture() {
    const [owner, keeper, borrower, treasury, ecoVault, reserveRecipient, lenderRecipient] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory("MockRegistry")).deploy();
    const acm = await (await ethers.getContractFactory("MockAccessControlManager")).deploy();
    const cm = await (await ethers.getContractFactory("MockCollateralManager")).deploy();
    const le = await (await ethers.getContractFactory("MockLendingEngineBasic")).deploy();
    const risk = await (await ethers.getContractFactory("MockLiquidationRiskManager")).deploy();
    const pv = await (await ethers.getContractFactory("MockPositionViewValuation")).deploy();
    const orderEngine = await (await ethers.getContractFactory("MockOrderEngineForSettlementManager")).deploy();
    const liquidationManager = await (await ethers.getContractFactory("MockLiquidationManager")).deploy();
    const collateralToken = await (await ethers.getContractFactory("MockERC20")).deploy(
      "Collateral",
      "COL",
      18,
      ethers.parseUnits("1000000", 18)
    );

    const SettlementManager = await ethers.getContractFactory("SettlementManager");
    const settlementManager = await upgrades.deployProxy(SettlementManager, [await registry.getAddress()], {
      kind: "uups",
      initializer: "initialize",
    });

    const LiquidationPayoutManager = await ethers.getContractFactory("LiquidationPayoutManager");
    const payoutManager = await upgrades.deployProxy(
      LiquidationPayoutManager,
      [
        await registry.getAddress(),
        await acm.getAddress(),
        {
          platform: treasury.address,
          reserve: reserveRecipient.address,
          lenderCompensation: lenderRecipient.address,
        },
        {
          platformBps: 2500,
          reserveBps: 2500,
          lenderBps: 2500,
          liquidatorBps: 2500,
        },
      ],
      { kind: "uups", initializer: "initialize" }
    );

    const FeeRouter = await ethers.getContractFactory("FeeRouter");
    const feeRouter = await upgrades.deployProxy(
      FeeRouter,
      [await registry.getAddress(), treasury.address, ecoVault.address, 9, 1],
      { kind: "uups", initializer: "initialize" }
    );

    await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(ModuleKeys.KEY_CM, await cm.getAddress());
    await registry.setModule(ModuleKeys.KEY_LE, await le.getAddress());
    await registry.setModule(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER, await risk.getAddress());
    await registry.setModule(ModuleKeys.KEY_POSITION_VIEW, await pv.getAddress());
    await registry.setModule(ModuleKeys.KEY_ORDER_ENGINE, await orderEngine.getAddress());
    await registry.setModule(ModuleKeys.KEY_LIQUIDATION_MANAGER, await liquidationManager.getAddress());
    await registry.setModule(ModuleKeys.KEY_LIQUIDATION_PAYOUT_MANAGER, await payoutManager.getAddress());
    await registry.setModule(ModuleKeys.KEY_FR, await feeRouter.getAddress());

    await acm.grantRole(ACTION_SET_PARAMETER, owner.address);
    await acm.grantRole(ACTION_LIQUIDATE, settlementManager.target);
    await acm.grantRole(ACTION_DEPOSIT, settlementManager.target);
    await feeRouter.connect(owner).addSupportedToken(await collateralToken.getAddress());

    return {
      owner,
      keeper,
      borrower,
      treasury,
      ecoVault,
      reserveRecipient,
      lenderRecipient,
      registry,
      acm,
      cm,
      le,
      risk,
      pv,
      orderEngine,
      liquidationManager,
      settlementManager,
      payoutManager,
      feeRouter,
      collateralToken,
    };
  }

  async function seedOrderAndLedger(params: {
    orderId: bigint;
    borrower: string;
    debtAsset: string;
    maturity: bigint;
    debtAmount: bigint;
    collateralAsset?: string;
    collateralAmount?: bigint;
    orderEngine: any;
    le: any;
    cm: any;
  }) {
    const {
      orderId,
      borrower,
      debtAsset,
      maturity,
      debtAmount,
      collateralAsset,
      collateralAmount,
      orderEngine,
      le,
      cm,
    } = params;

    await orderEngine.setOrder(orderId, {
      principal: debtAmount,
      rate: 0n,
      term: 1n,
      borrower,
      lender: ethers.ZeroAddress,
      asset: debtAsset,
      startTimestamp: 1n,
      maturity,
      repaidAmount: 0n,
    });

    await le.setUserDebt(borrower, debtAsset, debtAmount);

    if (collateralAsset && collateralAmount && collateralAmount > 0n) {
      await cm.setUserCollateral(borrower, collateralAsset, collateralAmount);
    }
  }

  it("reverts when caller lacks ACTION_LIQUIDATE", async function () {
    const { settlementManager, orderEngine, le, cm, acm, risk, borrower, keeper } = await loadFixture(deployFixture);

    const debtAsset = ethers.Wallet.createRandom().address;
    const collateralAsset = ethers.Wallet.createRandom().address;
    const currentBlock = await ethers.provider.getBlockNumber();
    const maturityPast = BigInt(currentBlock > 0 ? currentBlock - 1 : 0);

    await seedOrderAndLedger({
      orderId: 0n,
      borrower: borrower.address,
      debtAsset,
      maturity: maturityPast,
      debtAmount: 10n,
      collateralAsset,
      collateralAmount: 50n,
      orderEngine,
      le,
      cm,
    });

    await risk.setLiquidatable(borrower.address, true);

    await expect(settlementManager.connect(keeper).settleOrLiquidate(0n)).to.be.revertedWithCustomError(acm, "MissingRole");
  });

  it("reverts when not overdue and not risk-liquidatable", async function () {
    const { settlementManager, orderEngine, le, cm, acm, risk, borrower, keeper } = await loadFixture(deployFixture);

    const debtAsset = ethers.Wallet.createRandom().address;
    const collateralAsset = ethers.Wallet.createRandom().address;
    const currentBlock = await ethers.provider.getBlockNumber();
    const maturityPast = BigInt(currentBlock > 0 ? currentBlock - 1 : 0);

    await seedOrderAndLedger({
      orderId: 1n,
      borrower: borrower.address,
      debtAsset,
      maturity: BigInt(currentBlock + 100),
      debtAmount: 10n,
      collateralAsset,
      collateralAmount: 50n,
      orderEngine,
      le,
      cm,
    });

    await risk.setLiquidatable(borrower.address, false);
    await acm.grantRole(ACTION_LIQUIDATE, keeper.address);

    await expect(settlementManager.connect(keeper).settleOrLiquidate(1n))
      .to.be.revertedWithCustomError(settlementManager, "SettlementManager__NotLiquidatable");
  });

  it("overdue path liquidates via LiquidationManager and preserves keeper as liquidator", async function () {
    const { settlementManager, orderEngine, le, cm, acm, risk, borrower, keeper, liquidationManager } =
      await loadFixture(deployFixture);

    const debtAsset = ethers.Wallet.createRandom().address;
    const collateralAsset = ethers.Wallet.createRandom().address;
    const currentBlock = await ethers.provider.getBlockNumber();
    const maturityPast = BigInt(currentBlock > 0 ? currentBlock - 1 : 0);

    await seedOrderAndLedger({
      orderId: 2n,
      borrower: borrower.address,
      debtAsset,
      maturity: maturityPast,
      debtAmount: 40n,
      collateralAsset,
      collateralAmount: 100n,
      orderEngine,
      le,
      cm,
    });

    await risk.setLiquidatable(borrower.address, false);
    await acm.grantRole(ACTION_LIQUIDATE, keeper.address);

    await expect(settlementManager.connect(keeper).settleOrLiquidate(2n))
      .to.emit(liquidationManager, "MockLiquidationExecuted")
      .withArgs(keeper.address, borrower.address, collateralAsset, debtAsset, 40n, 40n, anyValue, anyValue);
  });

  it("risk path liquidates before maturity", async function () {
    const { settlementManager, orderEngine, le, cm, acm, risk, borrower, keeper, liquidationManager } =
      await loadFixture(deployFixture);

    const debtAsset = ethers.Wallet.createRandom().address;
    const collateralAsset = ethers.Wallet.createRandom().address;
    const currentBlock = await ethers.provider.getBlockNumber();

    await seedOrderAndLedger({
      orderId: 3n,
      borrower: borrower.address,
      debtAsset,
      maturity: BigInt(currentBlock + 100),
      debtAmount: 25n,
      collateralAsset,
      collateralAmount: 25n,
      orderEngine,
      le,
      cm,
    });

    await risk.setLiquidatable(borrower.address, true);
    await acm.grantRole(ACTION_LIQUIDATE, keeper.address);

    await expect(settlementManager.connect(keeper).settleOrLiquidate(3n))
      .to.emit(liquidationManager, "MockLiquidationExecuted")
      .withArgs(keeper.address, borrower.address, collateralAsset, debtAsset, 25n, 25n, anyValue, anyValue);
  });

  it("reverts with NoCollateral when user has no collateral assets", async function () {
    const { settlementManager, orderEngine, le, cm, acm, risk, borrower, keeper } = await loadFixture(deployFixture);

    const debtAsset = ethers.Wallet.createRandom().address;
    const currentBlock = await ethers.provider.getBlockNumber();
    const maturityPast = BigInt(currentBlock > 0 ? currentBlock - 1 : 0);

    await seedOrderAndLedger({
      orderId: 4n,
      borrower: borrower.address,
      debtAsset,
      maturity: maturityPast,
      debtAmount: 10n,
      orderEngine,
      le,
      cm,
    });

    await risk.setLiquidatable(borrower.address, true);
    await acm.grantRole(ACTION_LIQUIDATE, keeper.address);

    await expect(settlementManager.connect(keeper).settleOrLiquidate(4n))
      .to.be.revertedWithCustomError(settlementManager, "SettlementManager__NoCollateral");
  });

  it("reverts with AmountIsZero when reducible debt is zero", async function () {
    const { settlementManager, orderEngine, le, cm, acm, risk, borrower, keeper } = await loadFixture(deployFixture);

    const debtAsset = ethers.Wallet.createRandom().address;
    const collateralAsset = ethers.Wallet.createRandom().address;
    const currentBlock = await ethers.provider.getBlockNumber();
    const maturityPast = BigInt(currentBlock > 0 ? currentBlock - 1 : 0);

    await seedOrderAndLedger({
      orderId: 5n,
      borrower: borrower.address,
      debtAsset,
      maturity: maturityPast,
      debtAmount: 0n,
      collateralAsset,
      collateralAmount: 50n,
      orderEngine,
      le,
      cm,
    });

    await risk.setLiquidatable(borrower.address, true);
    await acm.grantRole(ACTION_LIQUIDATE, keeper.address);

    await expect(settlementManager.connect(keeper).settleOrLiquidate(5n))
      .to.be.revertedWithCustomError(settlementManager, "AmountIsZero");
  });

  it("fallback path keeps liquidation platform fee on FeeRouter route and emits fallback observability", async function () {
    const {
      settlementManager,
      orderEngine,
      le,
      cm,
      acm,
      risk,
      borrower,
      keeper,
      liquidationManager,
      payoutManager,
      feeRouter,
      collateralToken,
      treasury,
      ecoVault,
      reserveRecipient,
      lenderRecipient,
    } = await loadFixture(deployFixture);

    const orderId = 6n;
    const debtAmount = 40n;
    const collateralAmount = 100n;
    const currentBlock = await ethers.provider.getBlockNumber();
    const maturityPast = BigInt(currentBlock > 0 ? currentBlock - 1 : 0);

    await seedOrderAndLedger({
      orderId,
      borrower: borrower.address,
      debtAsset: await collateralToken.getAddress(),
      maturity: maturityPast,
      debtAmount,
      collateralAsset: await collateralToken.getAddress(),
      collateralAmount,
      orderEngine,
      le,
      cm,
    });

    await collateralToken.mint(await cm.getAddress(), collateralAmount);
    await (liquidationManager as any).setRevertSettlementPath(true);
    await risk.setLiquidatable(borrower.address, false);
    await acm.grantRole(ACTION_LIQUIDATE, keeper.address);

    const shares = await payoutManager.calculateShares(debtAmount);
    const expectedPlatformToTreasury = shares.platformShare * 9n / 10n;
    const expectedPlatformToEco = shares.platformShare - expectedPlatformToTreasury;

    await expect(settlementManager.connect(keeper).settleOrLiquidate(orderId))
      .to.emit(settlementManager, "LiquidationManagerFallbackActivated")
      .withArgs(orderId, borrower.address, await collateralToken.getAddress(), await collateralToken.getAddress(), keeper.address, anyValue, anyValue)
      .and.to.emit(settlementManager, "FallbackPayoutExecuted")
      .withArgs(
        borrower.address,
        await collateralToken.getAddress(),
        treasury.address,
        reserveRecipient.address,
        lenderRecipient.address,
        keeper.address,
        shares.platformShare,
        shares.reserveShare,
        shares.lenderShare,
        shares.liquidatorShare,
      );

    expect(await collateralToken.balanceOf(await feeRouter.getAddress())).to.equal(0n);
    expect(await collateralToken.balanceOf(treasury.address)).to.equal(expectedPlatformToTreasury);
    expect(await collateralToken.balanceOf(ecoVault.address)).to.equal(expectedPlatformToEco);
    expect(await collateralToken.balanceOf(reserveRecipient.address)).to.equal(shares.reserveShare);
    expect(await collateralToken.balanceOf(lenderRecipient.address)).to.equal(shares.lenderShare);
    expect(await collateralToken.balanceOf(keeper.address)).to.equal(shares.liquidatorShare);
    expect(await le.getDebt(borrower.address, await collateralToken.getAddress())).to.equal(0n);
    expect(await cm.getCollateral(borrower.address, await collateralToken.getAddress())).to.equal(collateralAmount - debtAmount);
  });
});
