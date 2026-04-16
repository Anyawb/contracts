import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import { ModuleKeys } from "../frontend-config/moduleKeys";

/**
 * Funds-Flow (SSOT) – Liquidation authority path
 *
 * Doc reference:
 * - docs/Usage-Guide/Funds-Flow-Architecture-Guide.md §6 (Liquidation)
 */

describe("Funds-Flow – Liquidation authority path", function () {
  const ACTION_LIQUIDATE = ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATE"));
  const ACTION_DEPOSIT = ethers.keccak256(ethers.toUtf8Bytes("DEPOSIT"));
  const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes("SET_PARAMETER"));
  const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes("ACTION_ADMIN"));
  const DATA_PUSH_TOPIC0 = ethers.id("DataPushed(bytes32,bytes)");
  const TYPE_LIQUIDATION_UPDATE = ethers.id("LIQUIDATION_UPDATE").toLowerCase();
  const TYPE_LIQUIDATION_PAYOUT = ethers.id("LIQUIDATION_PAYOUT").toLowerCase();

  async function assertRequiredModulesRegistered(registry: any): Promise<void> {
    const requiredModuleKeys = [
      ModuleKeys.KEY_ACCESS_CONTROL,
      ModuleKeys.KEY_SETTLEMENT_MANAGER,
      ModuleKeys.KEY_CM,
      ModuleKeys.KEY_LE,
      ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER,
      ModuleKeys.KEY_PRICE_ORACLE,
      ModuleKeys.KEY_POSITION_VIEW,
      ModuleKeys.KEY_ORDER_ENGINE,
      ModuleKeys.KEY_LIQUIDATION_MANAGER,
      ModuleKeys.KEY_LIQUIDATION_PAYOUT_MANAGER,
      ModuleKeys.KEY_LIQUIDATION_VIEW,
      ModuleKeys.KEY_FR,
    ];

    for (const key of requiredModuleKeys) {
      const moduleAddr = await registry.getModuleOrRevert(key);
      expect(moduleAddr).to.not.equal(ethers.ZeroAddress);
    }
  }

  type DecodedPushes = {
    update: {
      user: string;
      collateralAsset: string;
      debtAsset: string;
      collateralAmount: bigint;
      debtAmount: bigint;
      liquidator: string;
      bonus: bigint;
      blockNumber: bigint;
    };
    payout: {
      user: string;
      collateralAsset: string;
      platform: string;
      reserve: string;
      lender: string;
      liquidator: string;
      platformShare: bigint;
      reserveShare: bigint;
      lenderShare: bigint;
      liquidatorShare: bigint;
      blockNumber: bigint;
    };
  };

  async function deployFixture() {
    const [owner, keeper, borrower, treasury, ecoVault, reserveRecipient, lenderRecipient] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory("MockRegistry")).deploy();
    const acm = await (await ethers.getContractFactory("MockAccessControlManager")).deploy();
    const cm = await (await ethers.getContractFactory("MockCollateralManager")).deploy();
    const le = await (await ethers.getContractFactory("MockLendingEngineBasic")).deploy();
    const risk = await (await ethers.getContractFactory("MockLiquidationRiskManager")).deploy();
    const oracle = await (await ethers.getContractFactory("MockPriceOracle")).deploy();
    const pv = await (await ethers.getContractFactory("MockPositionViewValuation")).deploy();
    const orderEngine = await (await ethers.getContractFactory("MockOrderEngineForSettlementManager")).deploy();
    const collateralToken = await (await ethers.getContractFactory("MockERC20")).deploy(
      "Collateral",
      "COL",
      18,
      ethers.parseUnits("1000000", 18)
    );

    const SettlementManagerF = await ethers.getContractFactory("SettlementManager");
    const settlementManager = await upgrades.deployProxy(
      SettlementManagerF,
      [await registry.getAddress()],
      { kind: "uups", initializer: "initialize" }
    );

    const LiquidationPayoutManagerF = await ethers.getContractFactory("LiquidationPayoutManager");
    const payoutManager = await upgrades.deployProxy(
      LiquidationPayoutManagerF,
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

    const FeeRouterF = await ethers.getContractFactory("FeeRouter");
    const feeRouter = await upgrades.deployProxy(
      FeeRouterF,
      [await registry.getAddress(), treasury.address, ecoVault.address, 9, 1],
      { kind: "uups", initializer: "initialize" }
    );

    const LiquidatorViewF = await ethers.getContractFactory("LiquidatorView");
    const liquidatorView = await upgrades.deployProxy(
      LiquidatorViewF,
      [await registry.getAddress(), ethers.ZeroAddress],
      { kind: "uups", initializer: "initialize" }
    );

    const LiquidationManagerF = await ethers.getContractFactory("LiquidationManager");
    const liquidationManager = await upgrades.deployProxy(
      LiquidationManagerF,
      [await registry.getAddress()],
      { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] }
    );

    await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(ModuleKeys.KEY_SETTLEMENT_MANAGER, await settlementManager.getAddress());
    await registry.setModule(ModuleKeys.KEY_CM, await cm.getAddress());
    await registry.setModule(ModuleKeys.KEY_LE, await le.getAddress());
    await registry.setModule(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER, await risk.getAddress());
    await registry.setModule(ModuleKeys.KEY_PRICE_ORACLE, await oracle.getAddress());
    await registry.setModule(ModuleKeys.KEY_POSITION_VIEW, await pv.getAddress());
    await registry.setModule(ModuleKeys.KEY_ORDER_ENGINE, await orderEngine.getAddress());
    await registry.setModule(ModuleKeys.KEY_LIQUIDATION_MANAGER, await liquidationManager.getAddress());
    await registry.setModule(ModuleKeys.KEY_LIQUIDATION_PAYOUT_MANAGER, await payoutManager.getAddress());
    await registry.setModule(ModuleKeys.KEY_LIQUIDATION_VIEW, await liquidatorView.getAddress());
    await registry.setModule(ModuleKeys.KEY_FR, await feeRouter.getAddress());

    await assertRequiredModulesRegistered(registry);

    await acm.grantRole(ACTION_LIQUIDATE, keeper.address);
    await acm.grantRole(ACTION_LIQUIDATE, await settlementManager.getAddress());
    await acm.grantRole(ACTION_LIQUIDATE, await liquidationManager.getAddress());
    await acm.grantRole(ACTION_DEPOSIT, await settlementManager.getAddress());
    await acm.grantRole(ACTION_DEPOSIT, await liquidationManager.getAddress());
    await acm.grantRole(ACTION_SET_PARAMETER, owner.address);
    await acm.grantRole(ACTION_ADMIN, owner.address);
    await feeRouter.connect(owner).addSupportedToken(await collateralToken.getAddress());

    await oracle
      .connect(owner)
      .setPrice(await collateralToken.getAddress(), ethers.parseUnits("1", 18), await ethers.provider.getBlockNumber(), 18);

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
      oracle,
      pv,
      orderEngine,
      liquidationManager,
      settlementManager,
      payoutManager,
      feeRouter,
      liquidatorView,
      collateralToken,
    };
  }

  async function seedOrderAndLedger(params: {
    orderId: bigint;
    borrower: string;
    debtAsset: string;
    maturity: bigint;
    debtAmount: bigint;
    collateralAsset: string;
    collateralAmount: bigint;
    orderEngine: any;
    le: any;
    cm: any;
    collateralToken: any;
  }) {
    await params.orderEngine.setOrder(params.orderId, {
      principal: params.debtAmount,
      rate: 0n,
      term: 1n,
      borrower: params.borrower,
      lender: ethers.ZeroAddress,
      asset: params.debtAsset,
      startTimestamp: 1n,
      maturity: params.maturity,
      repaidAmount: 0n,
    });

    await params.le.setUserDebt(params.borrower, params.debtAsset, params.debtAmount);
    await params.cm.setUserCollateral(params.borrower, params.collateralAsset, params.collateralAmount);
    await params.collateralToken.mint(await params.cm.getAddress(), params.collateralAmount);
  }

  function decodeTrackedPushes(receipt: any, liquidatorViewAddress: string): DecodedPushes {
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const trackedLogs = receipt.logs.filter(
      (log: any) =>
        log.address.toLowerCase() === liquidatorViewAddress.toLowerCase() &&
        log.topics?.[0] === DATA_PUSH_TOPIC0 &&
        (log.topics[1]?.toLowerCase() === TYPE_LIQUIDATION_UPDATE || log.topics[1]?.toLowerCase() === TYPE_LIQUIDATION_PAYOUT)
    );

    const updateLogs = trackedLogs.filter((log: any) => log.topics[1]!.toLowerCase() === TYPE_LIQUIDATION_UPDATE);
    const payoutLogs = trackedLogs.filter((log: any) => log.topics[1]!.toLowerCase() === TYPE_LIQUIDATION_PAYOUT);

    expect(updateLogs).to.have.length(1);
    expect(payoutLogs).to.have.length(1);

    const updatePayload: string = abiCoder.decode(["bytes"], updateLogs[0].data)[0];
    const payoutPayload: string = abiCoder.decode(["bytes"], payoutLogs[0].data)[0];

    const [uUser, uCollateralAsset, uDebtAsset, uCollateralAmount, uDebtAmount, uLiquidator, uBonus, uBlockNumber] = abiCoder.decode(
      ["address", "address", "address", "uint256", "uint256", "address", "uint256", "uint256"],
      updatePayload
    );
    const [pUser, pCollateralAsset, pPlatform, pReserve, pLender, pLiquidator, pPlatformShare, pReserveShare, pLenderShare, pLiquidatorShare, pBlockNumber] = abiCoder.decode(
      ["address", "address", "address", "address", "address", "address", "uint256", "uint256", "uint256", "uint256", "uint256"],
      payoutPayload
    );

    return {
      update: {
        user: uUser,
        collateralAsset: uCollateralAsset,
        debtAsset: uDebtAsset,
        collateralAmount: BigInt(uCollateralAmount),
        debtAmount: BigInt(uDebtAmount),
        liquidator: uLiquidator,
        bonus: BigInt(uBonus),
        blockNumber: BigInt(uBlockNumber),
      },
      payout: {
        user: pUser,
        collateralAsset: pCollateralAsset,
        platform: pPlatform,
        reserve: pReserve,
        lender: pLender,
        liquidator: pLiquidator,
        platformShare: BigInt(pPlatformShare),
        reserveShare: BigInt(pReserveShare),
        lenderShare: BigInt(pLenderShare),
        liquidatorShare: BigInt(pLiquidatorShare),
        blockNumber: BigInt(pBlockNumber),
      },
    };
  }

  async function executeLiquidationPath(useFallback: boolean) {
    const fixture = await loadFixture(deployFixture);
    const {
      owner,
      keeper,
      borrower,
      cm,
      le,
      risk,
      orderEngine,
      liquidationManager,
      settlementManager,
      liquidatorView,
      collateralToken,
      treasury,
      reserveRecipient,
      lenderRecipient,
    } = fixture;

    const orderId = useFallback ? 1n : 0n;
    const debtAmount = 40n;
    const collateralAmount = 100n;
    const collateralAsset = await collateralToken.getAddress();
    const debtAsset = await collateralToken.getAddress();

    const currentBlock = await ethers.provider.getBlockNumber();
    const maturity = BigInt(currentBlock > 0 ? currentBlock - 1 : 0);

    await seedOrderAndLedger({
      orderId,
      borrower: borrower.address,
      debtAsset,
      maturity,
      debtAmount,
      collateralAsset,
      collateralAmount,
      orderEngine,
      le,
      cm,
      collateralToken,
    });
    await risk.setLiquidatable(borrower.address, false);

    if (useFallback) {
      await liquidationManager.connect(owner).pause();
    }

    const tx = await settlementManager.connect(keeper).settleOrLiquidate(orderId);
    const receipt = await tx.wait();
    const pushes = decodeTrackedPushes(receipt!, await liquidatorView.getAddress());

    if (useFallback) {
      await expect(tx).to.emit(settlementManager, "LiquidationManagerFallbackActivated");
    } else {
      await expect(tx).to.emit(liquidationManager, "PayoutExecuted");
    }

    expect(await le.getDebt(borrower.address, debtAsset)).to.equal(0n);
    expect(await cm.getCollateral(borrower.address, collateralAsset)).to.equal(collateralAmount - debtAmount);
    expect(await collateralToken.balanceOf(treasury.address)).to.equal(9n);
    expect(await collateralToken.balanceOf(reserveRecipient.address)).to.equal(10n);
    expect(await collateralToken.balanceOf(lenderRecipient.address)).to.equal(10n);
    expect(await collateralToken.balanceOf(keeper.address)).to.equal(10n);

    const terminalStatus = await orderEngine.getOrderStatusForView(orderId);

    return { fixture, pushes, orderId, terminalStatus };
  }

  it("keeps LiquidatorView payloads aligned between LiquidationManager main path and SettlementManager fallback path", async function () {
    const mainPath = await executeLiquidationPath(false);
    const fallbackPath = await executeLiquidationPath(true);

    expect(mainPath.terminalStatus).to.equal(3n);
    expect(fallbackPath.terminalStatus).to.equal(3n);

    expect(mainPath.pushes.update.user).to.equal(fallbackPath.pushes.update.user);
    expect(mainPath.pushes.update.collateralAsset).to.equal(fallbackPath.pushes.update.collateralAsset);
    expect(mainPath.pushes.update.debtAsset).to.equal(fallbackPath.pushes.update.debtAsset);
    expect(mainPath.pushes.update.collateralAmount).to.equal(fallbackPath.pushes.update.collateralAmount);
    expect(mainPath.pushes.update.debtAmount).to.equal(fallbackPath.pushes.update.debtAmount);
    expect(mainPath.pushes.update.liquidator).to.equal(fallbackPath.pushes.update.liquidator);
    expect(mainPath.pushes.update.bonus).to.equal(fallbackPath.pushes.update.bonus);

    expect(mainPath.pushes.payout.user).to.equal(fallbackPath.pushes.payout.user);
    expect(mainPath.pushes.payout.collateralAsset).to.equal(fallbackPath.pushes.payout.collateralAsset);
    expect(mainPath.pushes.payout.platform).to.equal(fallbackPath.pushes.payout.platform);
    expect(mainPath.pushes.payout.reserve).to.equal(fallbackPath.pushes.payout.reserve);
    expect(mainPath.pushes.payout.lender).to.equal(fallbackPath.pushes.payout.lender);
    expect(mainPath.pushes.payout.liquidator).to.equal(fallbackPath.pushes.payout.liquidator);
    expect(mainPath.pushes.payout.platformShare).to.equal(fallbackPath.pushes.payout.platformShare);
    expect(mainPath.pushes.payout.reserveShare).to.equal(fallbackPath.pushes.payout.reserveShare);
    expect(mainPath.pushes.payout.lenderShare).to.equal(fallbackPath.pushes.payout.lenderShare);
    expect(mainPath.pushes.payout.liquidatorShare).to.equal(fallbackPath.pushes.payout.liquidatorShare);
  });

  it("reverts when caller lacks ACTION_LIQUIDATE", async function () {
    const { borrower, cm, le, risk, orderEngine, settlementManager, acm, owner, collateralToken } =
      await loadFixture(deployFixture);

    const collateralAsset = await collateralToken.getAddress();
    const debtAsset = await collateralToken.getAddress();

    await seedOrderAndLedger({
      orderId: 2n,
      borrower: borrower.address,
      debtAsset,
      maturity: 1n,
      debtAmount: 10n,
      collateralAsset,
      collateralAmount: 20n,
      orderEngine,
      le,
      cm,
      collateralToken,
    });

    await risk.setLiquidatable(borrower.address, true);

    await acm.revokeRole(ACTION_LIQUIDATE, owner.address);

    await expect(settlementManager.connect(owner).settleOrLiquidate(2n))
      .to.be.revertedWithCustomError(acm, "MissingRole");
  });
});
