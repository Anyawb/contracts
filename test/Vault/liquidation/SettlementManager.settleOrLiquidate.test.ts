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
    const oracle = await (await ethers.getContractFactory("MockPriceOracle")).deploy();
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
    await registry.setModule(ModuleKeys.KEY_SETTLEMENT_MANAGER, await settlementManager.getAddress());
    await registry.setModule(ModuleKeys.KEY_CM, await cm.getAddress());
    await registry.setModule(ModuleKeys.KEY_LE, await le.getAddress());
    await registry.setModule(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER, await risk.getAddress());
    await registry.setModule(ModuleKeys.KEY_POSITION_VIEW, await pv.getAddress());
    await registry.setModule(ModuleKeys.KEY_PRICE_ORACLE, await oracle.getAddress());
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
      oracle,
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
    const { settlementManager, orderEngine, le, cm, acm, risk, borrower, keeper, liquidationManager, oracle } =
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
    await oracle.setPrice(collateralAsset, ethers.parseUnits("1", 18), currentBlock, 18);

    await expect(settlementManager.connect(keeper).settleOrLiquidate(2n))
      .to.emit(liquidationManager, "MockLiquidationExecuted")
      .withArgs(keeper.address, borrower.address, collateralAsset, debtAsset, 40n, 40n, anyValue, anyValue);

    expect(await orderEngine.getOrderStatusForView(2n)).to.equal(3n);
  });

  it("records an explicit shortfall ledger and with-shortfall order status when collateral cannot cover the debt", async function () {
    const { settlementManager, orderEngine, le, cm, acm, risk, oracle, borrower, keeper, liquidationManager } =
      await loadFixture(deployFixture);

    const debtAsset = ethers.Wallet.createRandom().address;
    const collateralAsset = ethers.Wallet.createRandom().address;
    const currentBlock = await ethers.provider.getBlockNumber();
    const maturityPast = BigInt(currentBlock > 0 ? currentBlock - 1 : 0);

    await seedOrderAndLedger({
      orderId: 200n,
      borrower: borrower.address,
      debtAsset,
      maturity: maturityPast,
      debtAmount: 40n,
      collateralAsset,
      collateralAmount: 10n,
      orderEngine,
      le,
      cm,
    });
    await oracle.setPrice(collateralAsset, ethers.parseUnits("1", 18), currentBlock, 18);

    await risk.setLiquidatable(borrower.address, true);
    await acm.grantRole(ACTION_LIQUIDATE, keeper.address);

    await expect(settlementManager.connect(keeper).settleOrLiquidate(200n))
      .to.emit(liquidationManager, "MockLiquidationExecuted")
      .withArgs(keeper.address, borrower.address, collateralAsset, debtAsset, 10n, 10n, anyValue, anyValue);

    const ledger = await settlementManager.getShortfallLedger(200n);
    expect(ledger.status).to.equal(1n);
    expect(ledger.pricingMode).to.equal(0n);
    expect(ledger.coveredDebt).to.equal(10n);
    expect(ledger.remainingDebt).to.equal(30n);
    expect(ledger.shortfallAmount).to.equal(30n);
    expect(await settlementManager.hasActiveShortfall(200n)).to.equal(true);
    expect(await orderEngine.getOrderStatusForView(200n)).to.equal(5n);
  });

  it("compensates missing terminal order state when shortfall sync runs after store module is restored", async function () {
    const { settlementManager, orderEngine, le, cm, acm, risk, oracle, borrower, keeper, owner, registry } =
      await loadFixture(deployFixture);

    const orderId = 206n;
    const debtAsset = ethers.Wallet.createRandom().address;
    const collateralAsset = ethers.Wallet.createRandom().address;
    const currentBlock = await ethers.provider.getBlockNumber();
    const maturityPast = BigInt(currentBlock > 0 ? currentBlock - 1 : 0);

    await seedOrderAndLedger({
      orderId,
      borrower: borrower.address,
      debtAsset,
      maturity: maturityPast,
      debtAmount: 40n,
      collateralAsset,
      collateralAmount: 10n,
      orderEngine,
      le,
      cm,
    });
    await oracle.setPrice(collateralAsset, ethers.parseUnits("1", 18), currentBlock, 18);
    await risk.setLiquidatable(borrower.address, true);
    await acm.grantRole(ACTION_LIQUIDATE, keeper.address);

    await settlementManager.connect(keeper).settleOrLiquidate(orderId);

    const OrderStateStoreV2 = await ethers.getContractFactory("OrderStateStoreV2");
    const orderStateStore = await upgrades.deployProxy(OrderStateStoreV2, [await registry.getAddress()], {
      kind: "uups",
    });
    await registry.setModule(ethers.id("ORDER_STATE_STORE"), await orderStateStore.getAddress());

    await settlementManager.connect(owner).setShortfallStatus(orderId, 2, ethers.ZeroHash);

    expect(await orderStateStore.hasOrderState(1n, orderId)).to.equal(true);
    const state = await orderStateStore.getOrderState(1n, orderId);
    // DEFAULTED + MATURITY_DEFAULT + RECOVERY_PENDING + SEIZED_AND_DISTRIBUTED
    expect(state.lifecycle).to.equal(4n);
    expect(state.closeReason).to.equal(3n);
    expect(state.shortfallStatus).to.equal(2n);
    expect(state.collateralDisposition).to.equal(4n);
  });

  it("P0 legacy_shortfall_force_reduce_mismatch: only covered debt can be reduced, uncovered debt must remain explicit", async function () {
    const { settlementManager, orderEngine, le, cm, acm, risk, oracle, borrower, keeper } =
      await loadFixture(deployFixture);

    const debtAsset = ethers.Wallet.createRandom().address;
    const collateralAsset = ethers.Wallet.createRandom().address;
    const currentBlock = await ethers.provider.getBlockNumber();
    const maturityPast = BigInt(currentBlock > 0 ? currentBlock - 1 : 0);

    await seedOrderAndLedger({
      orderId: 202n,
      borrower: borrower.address,
      debtAsset,
      maturity: maturityPast,
      debtAmount: 40n,
      collateralAsset,
      collateralAmount: 10n,
      orderEngine,
      le,
      cm,
    });
    await oracle.setPrice(collateralAsset, ethers.parseUnits("1", 18), currentBlock, 18);

    await risk.setLiquidatable(borrower.address, true);
    await acm.grantRole(ACTION_LIQUIDATE, keeper.address);

    await settlementManager.connect(keeper).settleOrLiquidate(202n);

    const ledger = await settlementManager.getShortfallLedger(202n);
    expect(ledger.coveredDebt).to.equal(10n);
    expect(ledger.remainingDebt).to.equal(30n);
    expect(ledger.shortfallAmount).to.equal(30n);

    // Regression guard: force-reducing full debt to zero would hide bad debt.
    // In this mocked fixture, debt ledger reduction is decoupled, but it must never be silently zeroed.
    expect(await le.getDebt(borrower.address, debtAsset)).to.not.equal(0n);
    expect(await orderEngine.getOrderStatusForView(202n)).to.equal(5n);
  });

  it("auto-applies guarantee default recovery against opened shortfall when ERGM returns forfeited amount", async function () {
    const { settlementManager, orderEngine, le, cm, acm, risk, oracle, borrower, keeper, liquidationManager, registry } =
      await loadFixture(deployFixture);

    const debtAsset = ethers.Wallet.createRandom().address;
    const collateralAsset = ethers.Wallet.createRandom().address;
    const currentBlock = await ethers.provider.getBlockNumber();
    const maturityPast = BigInt(currentBlock > 0 ? currentBlock - 1 : 0);

    const mockErgm = await (await ethers.getContractFactory("MockEarlyRepaymentGuaranteeManager")).deploy();
    await mockErgm.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_EARLY_REPAYMENT_GUARANTEE, await mockErgm.getAddress());

    await seedOrderAndLedger({
      orderId: 201n,
      borrower: borrower.address,
      debtAsset,
      maturity: maturityPast,
      debtAmount: 40n,
      collateralAsset,
      collateralAmount: 10n,
      orderEngine,
      le,
      cm,
    });
    await oracle.setPrice(collateralAsset, ethers.parseUnits("1", 18), currentBlock, 18);
    await mockErgm.setGuaranteeEnabled(debtAsset, true);
    await mockErgm.setDefaultRecovery(borrower.address, debtAsset, 12n, true);

    await risk.setLiquidatable(borrower.address, true);
    await acm.grantRole(ACTION_LIQUIDATE, keeper.address);

    await expect(settlementManager.connect(keeper).settleOrLiquidate(201n))
      .to.emit(liquidationManager, "MockLiquidationExecuted")
      .withArgs(keeper.address, borrower.address, collateralAsset, debtAsset, 10n, 10n, anyValue, anyValue);

    const ledger = await settlementManager.getShortfallLedger(201n);
    expect(ledger.status).to.equal(2n);
    expect(ledger.recoverySource).to.equal(1n);
    expect(ledger.coveredDebt).to.equal(10n);
    expect(ledger.recoveredAmount).to.equal(12n);
    expect(ledger.remainingDebt).to.equal(18n);
    expect(ledger.shortfallAmount).to.equal(18n);
  });

  it("allows configured recovery reporter to apply automated shortfall recovery", async function () {
    const { settlementManager, orderEngine, le, cm, acm, risk, oracle, borrower, keeper, reserveRecipient, owner } =
      await loadFixture(deployFixture);

    const debtAsset = ethers.Wallet.createRandom().address;
    const collateralAsset = ethers.Wallet.createRandom().address;
    const currentBlock = await ethers.provider.getBlockNumber();
    const maturityPast = BigInt(currentBlock > 0 ? currentBlock - 1 : 0);

    await seedOrderAndLedger({
      orderId: 202n,
      borrower: borrower.address,
      debtAsset,
      maturity: maturityPast,
      debtAmount: 40n,
      collateralAsset,
      collateralAmount: 10n,
      orderEngine,
      le,
      cm,
    });
    await oracle.setPrice(collateralAsset, ethers.parseUnits("1", 18), currentBlock, 18);

    await risk.setLiquidatable(borrower.address, true);
    await acm.grantRole(ACTION_LIQUIDATE, keeper.address);
    await settlementManager.connect(keeper).settleOrLiquidate(202n);

    await expect(
      settlementManager
        .connect(reserveRecipient)
        .applyShortfallRecovery(202n, 3, 5n, ethers.keccak256(ethers.toUtf8Bytes("offchain-1")))
    ).to.be.revertedWithCustomError(settlementManager, "SettlementManager__UnauthorizedShortfallRecoveryReporter");

    await settlementManager.connect(owner).setShortfallRecoveryReporter(
      reserveRecipient.address,
      3,
      true
    );

    await settlementManager
      .connect(reserveRecipient)
      .applyShortfallRecovery(202n, 3, 5n, ethers.keccak256(ethers.toUtf8Bytes("offchain-2")));

    const ledger = await settlementManager.getShortfallLedger(202n);
    expect(ledger.recoverySource).to.equal(3n);
    expect(ledger.recoveredAmount).to.equal(5n);
    expect(ledger.remainingDebt).to.equal(25n);
    expect(ledger.shortfallAmount).to.equal(25n);
  });

  it("requires evidenceHash for insurance/offchain shortfall recovery sources", async function () {
    const { settlementManager, orderEngine, le, cm, acm, risk, oracle, borrower, keeper, owner } =
      await loadFixture(deployFixture);

    const debtAsset = ethers.Wallet.createRandom().address;
    const collateralAsset = ethers.Wallet.createRandom().address;
    const currentBlock = await ethers.provider.getBlockNumber();
    const maturityPast = BigInt(currentBlock > 0 ? currentBlock - 1 : 0);

    await seedOrderAndLedger({
      orderId: 205n,
      borrower: borrower.address,
      debtAsset,
      maturity: maturityPast,
      debtAmount: 40n,
      collateralAsset,
      collateralAmount: 10n,
      orderEngine,
      le,
      cm,
    });
    await oracle.setPrice(collateralAsset, ethers.parseUnits("1", 18), currentBlock, 18);

    await risk.setLiquidatable(borrower.address, true);
    await acm.grantRole(ACTION_LIQUIDATE, keeper.address);
    await settlementManager.connect(keeper).settleOrLiquidate(205n);

    await expect(
      settlementManager.connect(owner).applyShortfallRecovery(205n, 2, 1n, ethers.ZeroHash),
    ).to.be.revertedWithCustomError(settlementManager, "SettlementManager__RecoveryEvidenceHashRequired");

    await expect(
      settlementManager.connect(owner).applyShortfallRecovery(205n, 3, 1n, ethers.ZeroHash),
    ).to.be.revertedWithCustomError(settlementManager, "SettlementManager__RecoveryEvidenceHashRequired");
  });

  it("requires non-zero evidenceHash for governance write-off and blocks backward pending transitions", async function () {
    const { settlementManager, orderEngine, le, cm, acm, risk, oracle, borrower, keeper, owner } =
      await loadFixture(deployFixture);

    const debtAsset = ethers.Wallet.createRandom().address;
    const collateralAsset = ethers.Wallet.createRandom().address;
    const currentBlock = await ethers.provider.getBlockNumber();
    const maturityPast = BigInt(currentBlock > 0 ? currentBlock - 1 : 0);

    await seedOrderAndLedger({
      orderId: 203n,
      borrower: borrower.address,
      debtAsset,
      maturity: maturityPast,
      debtAmount: 40n,
      collateralAsset,
      collateralAmount: 10n,
      orderEngine,
      le,
      cm,
    });
    await oracle.setPrice(collateralAsset, ethers.parseUnits("1", 18), currentBlock, 18);

    await risk.setLiquidatable(borrower.address, true);
    await acm.grantRole(ACTION_LIQUIDATE, keeper.address);
    await settlementManager.connect(keeper).settleOrLiquidate(203n);

    await expect(
      settlementManager.connect(owner).setShortfallStatus(203n, 6, ethers.ZeroHash),
    ).to.be.revertedWithCustomError(settlementManager, "SettlementManager__EvidenceHashRequired");

    const writeOffEvidence = ethers.keccak256(ethers.toUtf8Bytes("gov-write-off-203"));
    await settlementManager
      .connect(owner)
      .setShortfallStatus(203n, 6, writeOffEvidence);

    const ledger = await settlementManager.getShortfallLedger(203n);
    expect(ledger.status).to.equal(6n);
    expect(ledger.recoverySource).to.equal(5n);
    expect(ledger.remainingDebt).to.equal(0n);
    expect(ledger.shortfallAmount).to.equal(0n);
    expect(ledger.evidenceHash).to.equal(writeOffEvidence);

    await expect(
      settlementManager.connect(owner).setShortfallStatus(203n, 2, writeOffEvidence),
    ).to.be.revertedWithCustomError(settlementManager, "SettlementManager__InvalidShortfallStatusTransition");
  });

  it("rejects GOVERNANCE_WRITE_OFF as a shortfall recovery source on recovery endpoint", async function () {
    const { settlementManager, orderEngine, le, cm, acm, risk, oracle, borrower, keeper, reserveRecipient, owner } =
      await loadFixture(deployFixture);

    const debtAsset = ethers.Wallet.createRandom().address;
    const collateralAsset = ethers.Wallet.createRandom().address;
    const currentBlock = await ethers.provider.getBlockNumber();
    const maturityPast = BigInt(currentBlock > 0 ? currentBlock - 1 : 0);

    await seedOrderAndLedger({
      orderId: 204n,
      borrower: borrower.address,
      debtAsset,
      maturity: maturityPast,
      debtAmount: 40n,
      collateralAsset,
      collateralAmount: 10n,
      orderEngine,
      le,
      cm,
    });
    await oracle.setPrice(collateralAsset, ethers.parseUnits("1", 18), currentBlock, 18);

    await risk.setLiquidatable(borrower.address, true);
    await acm.grantRole(ACTION_LIQUIDATE, keeper.address);
    await settlementManager.connect(keeper).settleOrLiquidate(204n);

    await settlementManager.connect(owner).setShortfallRecoveryReporter(
      reserveRecipient.address,
      5,
      true,
    );

    await expect(
      settlementManager
        .connect(reserveRecipient)
        .applyShortfallRecovery(204n, 5, 1n, ethers.keccak256(ethers.toUtf8Bytes("invalid-writeoff-recovery"))),
    ).to.be.revertedWithCustomError(settlementManager, "SettlementManager__InvalidShortfallRecoverySource");
  });

  it("risk path liquidates before maturity", async function () {
    const { settlementManager, orderEngine, le, cm, acm, risk, borrower, keeper, liquidationManager, oracle } =
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
    await oracle.setPrice(collateralAsset, ethers.parseUnits("1", 18), currentBlock, 18);

    await expect(settlementManager.connect(keeper).settleOrLiquidate(3n))
      .to.emit(liquidationManager, "MockLiquidationExecuted")
      .withArgs(keeper.address, borrower.address, collateralAsset, debtAsset, 25n, 25n, anyValue, anyValue);

    expect(await orderEngine.getOrderStatusForView(3n)).to.equal(2n);
  });

  it("reverts when borrower tries to self-liquidate as keeper", async function () {
    const { settlementManager, orderEngine, le, cm, acm, risk, borrower } = await loadFixture(deployFixture);

    const debtAsset = ethers.Wallet.createRandom().address;
    const collateralAsset = ethers.Wallet.createRandom().address;
    const currentBlock = await ethers.provider.getBlockNumber();
    const maturityPast = BigInt(currentBlock > 0 ? currentBlock - 1 : 0);

    await seedOrderAndLedger({
      orderId: 36n,
      borrower: borrower.address,
      debtAsset,
      maturity: maturityPast,
      debtAmount: 25n,
      collateralAsset,
      collateralAmount: 25n,
      orderEngine,
      le,
      cm,
    });

    await risk.setLiquidatable(borrower.address, true);
    await acm.grantRole(ACTION_LIQUIDATE, borrower.address);

    await expect(settlementManager.connect(borrower).settleOrLiquidate(36n))
      .to.be.revertedWithCustomError(settlementManager, "SettlementManager__BorrowerCannotSelfLiquidate");
  });

  it("reverts when strict collateral valuation is unavailable", async function () {
    const { settlementManager, orderEngine, le, cm, acm, risk, borrower, keeper, oracle } =
      await loadFixture(deployFixture);

    const debtAsset = ethers.Wallet.createRandom().address;
    const collateralAssetSmall = ethers.Wallet.createRandom().address;
    const collateralAssetLarge = ethers.Wallet.createRandom().address;
    const currentBlock = await ethers.provider.getBlockNumber();
    const maturityPast = BigInt(currentBlock > 0 ? currentBlock - 1 : 0);

    await oracle.setShouldFail(true);

    await seedOrderAndLedger({
      orderId: 33n,
      borrower: borrower.address,
      debtAsset,
      maturity: maturityPast,
      debtAmount: 40n,
      orderEngine,
      le,
      cm,
    });
    await cm.setUserCollateral(borrower.address, collateralAssetSmall, 20n);
    await cm.setUserCollateral(borrower.address, collateralAssetLarge, 100n);

    await risk.setLiquidatable(borrower.address, true);
    await acm.grantRole(ACTION_LIQUIDATE, keeper.address);

    await expect(settlementManager.connect(keeper).settleOrLiquidate(33n))
      .to.be.revertedWithCustomError(oracle, "MockFailure");
  });

  it("reverts when strict debt valuation is unavailable", async function () {
    const { settlementManager, orderEngine, cm, acm, risk, borrower, keeper, liquidationManager, registry } =
      await loadFixture(deployFixture);

    const debtAsset = ethers.Wallet.createRandom().address;
    const collateralAsset = ethers.Wallet.createRandom().address;
    const currentBlock = await ethers.provider.getBlockNumber();
    const maturityPast = BigInt(currentBlock > 0 ? currentBlock - 1 : 0);

    const revertingDebtEngine = await (await ethers.getContractFactory("RevertingDebtValuationLendingEngine")).deploy();
    await revertingDebtEngine.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_LE, await revertingDebtEngine.getAddress());

    await orderEngine.setOrder(34n, {
      principal: 40n,
      rate: 0n,
      term: 1n,
      borrower: borrower.address,
      lender: ethers.ZeroAddress,
      asset: debtAsset,
      startTimestamp: 1n,
      maturity: maturityPast,
      repaidAmount: 0n,
    });
    await revertingDebtEngine.setUserDebt(borrower.address, debtAsset, 40n);
    await cm.setUserCollateral(borrower.address, collateralAsset, 100n);

    await risk.setLiquidatable(borrower.address, true);
    await acm.grantRole(ACTION_LIQUIDATE, keeper.address);

    await expect(settlementManager.connect(keeper).settleOrLiquidate(34n))
      .to.be.revertedWith("revert-debtValue");
  });

  it("prefers higher strict-oracle valuation collateral for sizing", async function () {
    const { settlementManager, orderEngine, le, cm, acm, risk, borrower, keeper, liquidationManager, oracle } =
      await loadFixture(deployFixture);

    const debtAsset = ethers.Wallet.createRandom().address;
    const unvaluedCollateral = ethers.Wallet.createRandom().address;
    const valuedCollateral = ethers.Wallet.createRandom().address;
    const currentBlock = await ethers.provider.getBlockNumber();
    const maturityPast = BigInt(currentBlock > 0 ? currentBlock - 1 : 0);

    await seedOrderAndLedger({
      orderId: 35n,
      borrower: borrower.address,
      debtAsset,
      maturity: maturityPast,
      debtAmount: 40n,
      orderEngine,
      le,
      cm,
    });
    await cm.setUserCollateral(borrower.address, unvaluedCollateral, 1n);
    await cm.setUserCollateral(borrower.address, valuedCollateral, 5n);

    await oracle.setPrice(unvaluedCollateral, ethers.parseUnits("1", 18), currentBlock, 18);
    await oracle.setPrice(valuedCollateral, ethers.parseUnits("10", 18), currentBlock, 18);

    await risk.setLiquidatable(borrower.address, true);
    await acm.grantRole(ACTION_LIQUIDATE, keeper.address);

    await expect(settlementManager.connect(keeper).settleOrLiquidate(35n))
      .to.emit(liquidationManager, "MockLiquidationExecuted")
      .withArgs(keeper.address, borrower.address, valuedCollateral, debtAsset, 4n, 40n, anyValue, anyValue);
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
      registry,
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
      oracle,
    } = await loadFixture(deployFixture);

    const LiquidatorViewFactory = await ethers.getContractFactory("LiquidatorView");
    const liquidatorView = await upgrades.deployProxy(
      LiquidatorViewFactory,
      [await registry.getAddress(), ethers.ZeroAddress],
      { kind: "uups", initializer: "initialize" }
    );
    await registry.setModule(ModuleKeys.KEY_LIQUIDATION_VIEW, await liquidatorView.getAddress());

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
    await oracle.setPrice(await collateralToken.getAddress(), ethers.parseUnits("1", 18), currentBlock, 18);

    await collateralToken.mint(await cm.getAddress(), collateralAmount);
    await (liquidationManager as any).setRevertSettlementPath(true);
    await risk.setLiquidatable(borrower.address, false);
    await acm.grantRole(ACTION_LIQUIDATE, keeper.address);

    const shares = await payoutManager.calculateShares(debtAmount);
    const expectedPlatformToTreasury = shares.platformShare * 9n / 10n;
    const expectedPlatformToEco = shares.platformShare - expectedPlatformToTreasury;

    const tx = await settlementManager.connect(keeper).settleOrLiquidate(orderId);

    await expect(tx)
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

    const receipt = await tx.wait();
    const DATA_PUSH_TOPIC0 = ethers.id("DataPushed(bytes32,bytes)");
    const TYPE_LIQUIDATION_UPDATE = ethers.id("LIQUIDATION_UPDATE").toLowerCase();
    const TYPE_LIQUIDATION_PAYOUT = ethers.id("LIQUIDATION_PAYOUT").toLowerCase();
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const tracked = receipt!.logs.filter(
      (log) =>
        log.address === liquidatorView.target &&
        log.topics?.[0] === DATA_PUSH_TOPIC0 &&
        (log.topics[1]?.toLowerCase() === TYPE_LIQUIDATION_UPDATE ||
          log.topics[1]?.toLowerCase() === TYPE_LIQUIDATION_PAYOUT)
    );

    const updateLogs = tracked.filter((log) => log.topics[1]!.toLowerCase() === TYPE_LIQUIDATION_UPDATE);
    const payoutLogs = tracked.filter((log) => log.topics[1]!.toLowerCase() === TYPE_LIQUIDATION_PAYOUT);
    expect(updateLogs).to.have.length(1);
    expect(payoutLogs).to.have.length(1);

    const updatePayload: string = abiCoder.decode(["bytes"], updateLogs[0].data)[0];
    const [uUser, uCollateralAsset, uDebtAsset, uCollateralAmount, uDebtAmount, uLiquidator, uBonus] = abiCoder.decode(
      ["address", "address", "address", "uint256", "uint256", "address", "uint256", "uint256"],
      updatePayload,
    );
    expect(uUser).to.equal(borrower.address);
    expect(uCollateralAsset).to.equal(await collateralToken.getAddress());
    expect(uDebtAsset).to.equal(await collateralToken.getAddress());
    expect(uCollateralAmount).to.equal(debtAmount);
    expect(uDebtAmount).to.equal(debtAmount);
    expect(uLiquidator).to.equal(keeper.address);
    expect(uBonus).to.equal(0n);

    const payoutPayload: string = abiCoder.decode(["bytes"], payoutLogs[0].data)[0];
    const [pUser, pCollateralAsset, pPlatform, pReserve, pLender, pLiquidator, pPlatformShare, pReserveShare, pLenderShare, pLiquidatorShare] = abiCoder.decode(
      ["address", "address", "address", "address", "address", "address", "uint256", "uint256", "uint256", "uint256", "uint256"],
      payoutPayload,
    );
    expect(pUser).to.equal(borrower.address);
    expect(pCollateralAsset).to.equal(await collateralToken.getAddress());
    expect(pPlatform).to.equal(treasury.address);
    expect(pReserve).to.equal(reserveRecipient.address);
    expect(pLender).to.equal(lenderRecipient.address);
    expect(pLiquidator).to.equal(keeper.address);
    expect(pPlatformShare).to.equal(shares.platformShare);
    expect(pReserveShare).to.equal(shares.reserveShare);
    expect(pLenderShare).to.equal(shares.lenderShare);
    expect(pLiquidatorShare).to.equal(shares.liquidatorShare);

    expect(await collateralToken.balanceOf(await feeRouter.getAddress())).to.equal(0n);
    expect(await collateralToken.balanceOf(treasury.address)).to.equal(expectedPlatformToTreasury);
    expect(await collateralToken.balanceOf(ecoVault.address)).to.equal(expectedPlatformToEco);
    expect(await collateralToken.balanceOf(reserveRecipient.address)).to.equal(shares.reserveShare);
    expect(await collateralToken.balanceOf(lenderRecipient.address)).to.equal(shares.lenderShare);
    expect(await collateralToken.balanceOf(keeper.address)).to.equal(shares.liquidatorShare);
    expect(await le.getDebt(borrower.address, await collateralToken.getAddress())).to.equal(0n);
    expect(await cm.getCollateral(borrower.address, await collateralToken.getAddress())).to.equal(collateralAmount - debtAmount);
    expect(await orderEngine.getOrderStatusForView(orderId)).to.equal(3n);
  });

  it("fallback path emits CacheUpdateFailed when liquidation view is missing", async function () {
    const {
      settlementManager,
      orderEngine,
      registry,
      le,
      cm,
      acm,
      risk,
      borrower,
      keeper,
      liquidationManager,
      collateralToken,
      oracle,
    } = await loadFixture(deployFixture);

    const orderId = 7n;
    const debtAmount = 40n;
    const collateralAmount = 100n;
    const currentBlock = await ethers.provider.getBlockNumber();
    const maturityPast = BigInt(currentBlock > 0 ? currentBlock - 1 : 0);

    await registry.setModule(ModuleKeys.KEY_LIQUIDATION_VIEW, ethers.ZeroAddress);
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
    await oracle.setPrice(await collateralToken.getAddress(), ethers.parseUnits("1", 18), currentBlock, 18);

    await collateralToken.mint(await cm.getAddress(), collateralAmount);
    await (liquidationManager as any).setRevertSettlementPath(true);
    await risk.setLiquidatable(borrower.address, false);
    await acm.grantRole(ACTION_LIQUIDATE, keeper.address);

    await expect(settlementManager.connect(keeper).settleOrLiquidate(orderId))
      .to.emit(settlementManager, "CacheUpdateFailed")
      .withArgs(
        borrower.address,
        await collateralToken.getAddress(),
        ethers.ZeroAddress,
        debtAmount,
        debtAmount,
        ethers.toUtf8Bytes("view unavailable"),
      );
  });

  it("fallback path emits CacheUpdateFailed when liquidation view reverts", async function () {
    const {
      settlementManager,
      orderEngine,
      registry,
      le,
      cm,
      acm,
      risk,
      borrower,
      keeper,
      liquidationManager,
      collateralToken,
      oracle,
    } = await loadFixture(deployFixture);

    const orderId = 8n;
    const debtAmount = 40n;
    const collateralAmount = 100n;
    const currentBlock = await ethers.provider.getBlockNumber();
    const maturityPast = BigInt(currentBlock > 0 ? currentBlock - 1 : 0);

    const revertingView = await (await ethers.getContractFactory("RevertingLiquidationEventsView")).deploy();
    await revertingView.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_LIQUIDATION_VIEW, await revertingView.getAddress());

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
    await oracle.setPrice(await collateralToken.getAddress(), ethers.parseUnits("1", 18), currentBlock, 18);

    await collateralToken.mint(await cm.getAddress(), collateralAmount);
    await (liquidationManager as any).setRevertSettlementPath(true);
    await risk.setLiquidatable(borrower.address, false);
    await acm.grantRole(ACTION_LIQUIDATE, keeper.address);

    const tx = await settlementManager.connect(keeper).settleOrLiquidate(orderId);
    const receipt = await tx.wait();
    const cacheUpdateFailedTopic = settlementManager.interface.getEvent("CacheUpdateFailed")!.topicHash;
    const failedLogs = receipt!.logs.filter(
      (log) => log.address === settlementManager.target && log.topics?.[0] === cacheUpdateFailedTopic,
    );

    expect(failedLogs).to.have.length(2);
  });
});
