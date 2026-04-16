import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("Funds-Flow – Blocks-only authority path", function () {
  const KEY_ACCESS_CONTROL = ethers.id("ACCESS_CONTROL_MANAGER");
  const KEY_ASSET_WHITELIST = ethers.id("ASSET_WHITELIST");
  const KEY_LE = ethers.id("LENDING_ENGINE");
  const KEY_VAULT_CORE = ethers.id("VAULT_CORE");
  const KEY_LENDER_POOL_VAULT = ethers.id("LENDER_POOL_VAULT");
  const KEY_VAULT_BUSINESS_LOGIC = ethers.id("VAULT_BUSINESS_LOGIC");
  const KEY_BLOCKS_ONLY_COORDINATOR = ethers.id("BLOCKS_ONLY_COORDINATOR");
  const KEY_CM = ethers.id("COLLATERAL_MANAGER");
  const KEY_POSITION_VIEW = ethers.id("POSITION_VIEW");
  const KEY_LIQUIDATION_MANAGER = ethers.id("LIQUIDATION_MANAGER");
  const KEY_LIQUIDATION_PAYOUT_MANAGER = ethers.id(
    "LIQUIDATION_PAYOUT_MANAGER",
  );
  const KEY_EASY_TOKEN = ethers.id("EASY_TOKEN");
  const KEY_EASY_EMISSION_CONFIG = ethers.id("EASY_EMISSION_CONFIG");
  const KEY_EASY_EMISSION_CONTROLLER = ethers.id("EASY_EMISSION_CONTROLLER");
  const KEY_REWARD_ACCRUAL_MANAGER = ethers.id("REWARD_ACCRUAL_MANAGER");
  const KEY_REWARD_MANAGER_CORE = ethers.id("REWARD_MANAGER_CORE");
  const KEY_GUARANTEE_FUND = ethers.id("GUARANTEE_FUND_MANAGER");
  const KEY_LOAN_FLOW_VIEW = ethers.id("LOAN_FLOW_VIEW");
  const KEY_PRICE_ORACLE = ethers.id("PRICE_ORACLE");

  const ACTION_LIQUIDATE = ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATE"));

  const BORROW_INTENT_TYPES = {
    BorrowIntentBlocks: [
      { name: "borrower", type: "address" },
      { name: "collateralAsset", type: "address" },
      { name: "collateralAmount", type: "uint256" },
      { name: "borrowAsset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "termBlocks", type: "uint256" },
      { name: "rateBps", type: "uint256" },
      { name: "expireAt", type: "uint256" },
      { name: "salt", type: "bytes32" },
    ],
  } as const;

  const LEND_INTENT_TYPES = {
    LendIntentBlocks: [
      { name: "lenderSigner", type: "address" },
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "minTermBlocks", type: "uint256" },
      { name: "maxTermBlocks", type: "uint256" },
      { name: "minRateBps", type: "uint256" },
      { name: "expireAt", type: "uint256" },
      { name: "salt", type: "bytes32" },
    ],
  } as const;

  const DATA_TYPE_RESERVE_CONSUMED = ethers.keccak256(
    ethers.toUtf8Bytes("RESERVE_CONSUMED"),
  );
  const DATA_TYPE_BLOCKS_ONLY_MATCH_FINALIZED = ethers.keccak256(
    ethers.toUtf8Bytes("BLOCKS_ONLY_MATCH_FINALIZED"),
  );
  const DATA_TYPE_BLOCKS_ONLY_REPAID = ethers.keccak256(
    ethers.toUtf8Bytes("BLOCKS_ONLY_REPAID"),
  );
  const DATA_TYPE_BLOCKS_ONLY_SETTLED = ethers.keccak256(
    ethers.toUtf8Bytes("BLOCKS_ONLY_SETTLED"),
  );
  const DATA_TYPE_BLOCKS_ONLY_DELIVERED = ethers.keccak256(
    ethers.toUtf8Bytes("BLOCKS_ONLY_DELIVERED"),
  );
  const DATA_TYPE_BLOCKS_ONLY_TRADE_CLOSED = ethers.keccak256(
    ethers.toUtf8Bytes("BLOCKS_ONLY_TRADE_CLOSED"),
  );
  const DATA_PUSH_IFACE = new ethers.Interface([
    "event DataPushed(bytes32 indexed dataTypeHash, bytes payload)",
  ]);
  const DATA_PUSH_TOPIC0 = ethers.id("DataPushed(bytes32,bytes)").toLowerCase();
  const LIQUIDATION_SHORTFALL_OPENED_TOPIC0 = ethers
    .id(
      "LiquidationShortfallOpened(uint256,address,address,uint8,uint8,uint256,uint256,uint256,uint256,uint256,bytes32)",
    )
    .toLowerCase();

  function getDataPushTypes(receipt: any): string[] {
    return receipt.logs
      .filter(
        (log: any) =>
          (log.topics?.[0] || "").toLowerCase() === DATA_PUSH_TOPIC0,
      )
      .map((log: any) =>
        DATA_PUSH_IFACE.parseLog(log).args.dataTypeHash.toLowerCase(),
      );
  }

  async function buildBlocksMatchData(params: {
    vbl: any;
    borrower: any;
    lender: any;
    token: any;
    principal: bigint;
    termBlocks: bigint;
    rateBps: bigint;
    collateralAsset?: string;
    collateralAmount?: bigint;
  }) {
    const {
      vbl,
      borrower,
      lender,
      token,
      principal,
      termBlocks,
      rateBps,
      collateralAsset,
      collateralAmount,
    } = params;
    const network = await ethers.provider.getNetwork();
    const domain = {
      name: "RwaLending",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await vbl.getAddress(),
    };

    const currentBlock = await ethers.provider.getBlockNumber();
    const expireAt = BigInt(currentBlock + 10_000);

    const borrowIntent = {
      borrower: borrower.address,
      collateralAsset: collateralAsset ?? (await token.getAddress()),
      collateralAmount: collateralAmount ?? 1n,
      borrowAsset: await token.getAddress(),
      amount: principal,
      termBlocks,
      rateBps,
      expireAt,
      salt: ethers.keccak256(
        ethers.toUtf8Bytes(`borrow-blocks-${borrower.address}-${principal}`),
      ),
    };

    const lendIntent = {
      lenderSigner: lender.address,
      asset: await token.getAddress(),
      amount: principal,
      minTermBlocks: termBlocks,
      maxTermBlocks: termBlocks,
      minRateBps: 0n,
      expireAt,
      salt: ethers.keccak256(
        ethers.toUtf8Bytes(`lend-blocks-${lender.address}-${principal}`),
      ),
    };

    const lendIntentHash = ethers.TypedDataEncoder.hashStruct(
      "LendIntentBlocks",
      LEND_INTENT_TYPES,
      lendIntent,
    );

    const sigBorrower = await borrower.signTypedData(
      domain,
      BORROW_INTENT_TYPES,
      borrowIntent,
    );
    const sigLender = await lender.signTypedData(
      domain,
      LEND_INTENT_TYPES,
      lendIntent,
    );

    return { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender };
  }

  async function deployFixture() {
    const [owner, lender, borrower, guaranteeFund] = await ethers.getSigners();

    const RegistryF = await ethers.getContractFactory("MockRegistry");
    const registry = await RegistryF.deploy();

    const ACMF = await ethers.getContractFactory("MockAccessControlManager");
    const acm = await ACMF.deploy();

    const AssetWhitelistF =
      await ethers.getContractFactory("MockAssetWhitelist");
    const assetWhitelist = await AssetWhitelistF.deploy();

    const CMF = await ethers.getContractFactory("MockCollateralManager");
    const cm = await CMF.deploy();

    const TokenF = await ethers.getContractFactory("MockERC20");
    const token = await TokenF.deploy(
      "Mock USDC",
      "USDC",
      18,
      ethers.parseUnits("1000000", 18),
    );
    const collateralToken = await TokenF.deploy(
      "Mock WETH",
      "WETH",
      18,
      ethers.parseUnits("1000000", 18),
    );

    const LEF = await ethers.getContractFactory("MockLendingEngineBasic");
    const le = await LEF.deploy();

    const PVF = await ethers.getContractFactory("MockPositionViewValuation");
    const pv = await PVF.deploy();

    const VaultRouterF = await ethers.getContractFactory("MockVaultRouter");
    const vaultRouter = await VaultRouterF.deploy();

    const VaultCoreF = await ethers.getContractFactory("VaultCore");
    const vaultCore = await upgrades.deployProxy(
      VaultCoreF,
      [registry.target, await vaultRouter.getAddress()],
      { kind: "uups", initializer: "initialize" },
    );

    const LenderPoolVaultF = await ethers.getContractFactory("LenderPoolVault");
    const lenderPoolVault = await upgrades.deployProxy(
      LenderPoolVaultF,
      [registry.target],
      { kind: "uups", initializer: "initialize" },
    );

    const VBLF = await ethers.getContractFactory("VaultBusinessLogic");
    const vbl = await upgrades.deployProxy(
      VBLF,
      [registry.target, token.target],
      { kind: "uups", initializer: "initialize" },
    );

    const BlocksOnlyCoordinatorF = await ethers.getContractFactory(
      "BlocksOnlyCoordinator",
    );
    const coordinator = await upgrades.deployProxy(
      BlocksOnlyCoordinatorF,
      [registry.target],
      { kind: "uups", initializer: "initialize" },
    );

    const LiquidationManagerF =
      await ethers.getContractFactory("LiquidationManager");
    const liquidationManager = await upgrades.deployProxy(
      LiquidationManagerF,
      [registry.target],
      { kind: "uups", initializer: "initialize" },
    );

    const LiquidationPayoutManagerF = await ethers.getContractFactory(
      "LiquidationPayoutManager",
    );
    const liquidationPayoutManager = await upgrades.deployProxy(
      LiquidationPayoutManagerF,
      [
        registry.target,
        acm.target,
        {
          platform: owner.address,
          reserve: owner.address,
          lenderCompensation: lenderPoolVault.target,
        },
        {
          platformBps: 0,
          reserveBps: 0,
          lenderBps: 10000,
          liquidatorBps: 0,
        },
      ],
      { kind: "uups", initializer: "initialize" },
    );

    const EasyTokenF = await ethers.getContractFactory("EasyToken");
    const easyToken = await upgrades.deployProxy(EasyTokenF, [owner.address], {
      kind: "uups",
      initializer: "initialize",
    });

    const EasyEmissionConfigF = await ethers.getContractFactory(
      "EasyEmissionConfig",
    );
    const easyEmissionConfig = await upgrades.deployProxy(
      EasyEmissionConfigF,
      [registry.target],
      { kind: "uups", initializer: "initialize" },
    );

    const EasyEmissionControllerF = await ethers.getContractFactory(
      "EasyEmissionController",
    );
    const easyEmissionController = await upgrades.deployProxy(
      EasyEmissionControllerF,
      [registry.target],
      { kind: "uups", initializer: "initialize" },
    );

    const LoanFlowViewF = await ethers.getContractFactory("MockLoanFlowView");
    const loanFlowView = await LoanFlowViewF.deploy();

    const RewardAccrualManagerF = await ethers.getContractFactory(
      "RewardAccrualManager",
    );
    const rewardAccrualManager = await upgrades.deployProxy(
      RewardAccrualManagerF,
      [registry.target],
      { kind: "uups", initializer: "initialize" },
    );

    const PriceOracleF = await ethers.getContractFactory("MockPriceOracle");
    const priceOracle = await PriceOracleF.deploy();

    await registry.setModule(KEY_ACCESS_CONTROL, acm.target);
    await registry.setModule(KEY_ASSET_WHITELIST, assetWhitelist.target);
    await registry.setModule(KEY_LE, le.target);
    await registry.setModule(KEY_VAULT_CORE, vaultCore.target);
    await registry.setModule(KEY_LENDER_POOL_VAULT, lenderPoolVault.target);
    await registry.setModule(KEY_VAULT_BUSINESS_LOGIC, vbl.target);
    await registry.setModule(KEY_BLOCKS_ONLY_COORDINATOR, coordinator.target);
    await registry.setModule(KEY_CM, cm.target);
    await registry.setModule(KEY_POSITION_VIEW, pv.target);
    await registry.setModule(
      KEY_LIQUIDATION_MANAGER,
      liquidationManager.target,
    );
    await registry.setModule(
      KEY_LIQUIDATION_PAYOUT_MANAGER,
      liquidationPayoutManager.target,
    );
    await registry.setModule(KEY_EASY_TOKEN, easyToken.target);
    await registry.setModule(
      KEY_EASY_EMISSION_CONFIG,
      easyEmissionConfig.target,
    );
    await registry.setModule(
      KEY_EASY_EMISSION_CONTROLLER,
      easyEmissionController.target,
    );
    await registry.setModule(
      KEY_REWARD_ACCRUAL_MANAGER,
      rewardAccrualManager.target,
    );
    await registry.setModule(KEY_REWARD_MANAGER_CORE, owner.address);
    await registry.setModule(KEY_GUARANTEE_FUND, guaranteeFund.address);
    await registry.setModule(KEY_LOAN_FLOW_VIEW, loanFlowView.target);
    await registry.setModule(KEY_PRICE_ORACLE, priceOracle.target);

    await assetWhitelist.setAssetAllowed(token.target, true);
    await assetWhitelist.setAssetAllowed(collateralToken.target, true);
    await easyToken.setSoleMinter(easyEmissionController.target);
    await easyToken.grantRole(
      await easyToken.BURNER_ROLE(),
      rewardAccrualManager.target,
    );
    await loanFlowView.setGlobalLoanFlow(0, 0, 0, 0, true, 0);
    await priceOracle.setPrice(token.target, ethers.parseUnits("1", 18), 1, 18);

    await acm.grantRole(ACTION_LIQUIDATE, owner.address);
    await acm.grantRole(ACTION_LIQUIDATE, coordinator.target);
    await acm.grantRole(ACTION_LIQUIDATE, liquidationManager.target);

    await token.transfer(lender.address, ethers.parseUnits("10000", 18));
    await token.transfer(borrower.address, ethers.parseUnits("100", 18));
    await collateralToken.transfer(
      owner.address,
      ethers.parseUnits("1000", 18),
    );
    await token.transfer(cm.target, ethers.parseUnits("1000", 18));
    await cm.setUserCollateral(
      borrower.address,
      token.target,
      ethers.parseUnits("1000", 18),
    );
    await token
      .connect(lender)
      .approve(vbl.target, ethers.parseUnits("100000", 18));

    return {
      owner,
      lender,
      borrower,
      registry,
      acm,
      assetWhitelist,
      token,
      collateralToken,
      le,
      vaultCore,
      lenderPoolVault,
      vbl,
      coordinator,
      pv,
      cm,
      liquidationManager,
      easyToken,
      easyEmissionController,
      rewardAccrualManager,
      guaranteeFund,
    };
  }

  it("finalizeMatchBlocks consumes reserve and creates a collateral-bound blocks-only order", async function () {
    const { lender, borrower, token, le, lenderPoolVault, vbl, coordinator } =
      await loadFixture(deployFixture);

    const principal = ethers.parseUnits("1000", 18);
    const termBlocks = 1n;
    const rateBps = 0n;

    const { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender } =
      await buildBlocksMatchData({
        vbl,
        borrower,
        lender,
        token,
        principal,
        termBlocks,
        rateBps,
      });

    await vbl
      .connect(lender)
      .reserveForLending(
        lender.address,
        token.target,
        principal,
        lendIntentHash,
      );

    const borrowerBalBefore = await token.balanceOf(borrower.address);
    const poolBalBefore = await token.balanceOf(lenderPoolVault.target);

    const tx = await vbl
      .connect(borrower)
      .finalizeMatchBlocks(borrowIntent, [lendIntent], sigBorrower, [
        sigLender,
      ]);
    const receipt = await tx.wait();

    const borrowerBalAfter = await token.balanceOf(borrower.address);
    const poolBalAfter = await token.balanceOf(lenderPoolVault.target);

    expect(borrowerBalAfter - borrowerBalBefore).to.equal(principal);
    expect(poolBalAfter).to.equal(poolBalBefore - principal);
    expect(await le.getDebt(borrower.address, token.target)).to.equal(0);

    const order = await coordinator.getBlocksOnlyOrder(0);
    expect(order.borrower).to.equal(borrower.address);
    expect(order.lender).to.equal(lenderPoolVault.target);
    expect(order.collateralAsset).to.equal(token.target);
    expect(order.collateralAmount).to.equal(1n);
    expect(order.asset).to.equal(token.target);
    expect(order.principal).to.equal(principal);
    expect(order.repaidPrincipal).to.equal(0);
    expect(order.termBlocks).to.equal(termBlocks);
    expect(order.rateBps).to.equal(0);
    expect(order.status).to.equal(1n);

    const dataTypes = getDataPushTypes(receipt);
    expect(dataTypes).to.include(DATA_TYPE_RESERVE_CONSUMED.toLowerCase());
    expect(dataTypes).to.include(
      DATA_TYPE_BLOCKS_ONLY_MATCH_FINALIZED.toLowerCase(),
    );
  });

  it("finalizeMatchBlocks stages bound collateral into coordinator custody so the borrower cannot withdraw it later", async function () {
    const { lender, borrower, token, collateralToken, vbl, coordinator, cm } =
      await loadFixture(deployFixture);

    const principal = ethers.parseUnits("220", 18);
    const collateralAmount = ethers.parseUnits("3", 18);

    await collateralToken.transfer(cm.target, collateralAmount);
    await cm.setUserCollateral(
      borrower.address,
      collateralToken.target,
      collateralAmount,
    );

    const { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender } =
      await buildBlocksMatchData({
        vbl,
        borrower,
        lender,
        token,
        principal,
        termBlocks: 1n,
        rateBps: 0n,
        collateralAsset: await collateralToken.getAddress(),
        collateralAmount,
      });

    await vbl
      .connect(lender)
      .reserveForLending(
        lender.address,
        token.target,
        principal,
        lendIntentHash,
      );

    await vbl
      .connect(borrower)
      .finalizeMatchBlocks(borrowIntent, [lendIntent], sigBorrower, [
        sigLender,
      ]);

    expect(
      await cm.getCollateral(borrower.address, collateralToken.target),
    ).to.equal(0n);
    expect(await collateralToken.balanceOf(coordinator.target)).to.equal(
      collateralAmount,
    );

    await expect(
      cm.withdrawCollateral(
        borrower.address,
        collateralToken.target,
        1n,
      ),
    ).to.be.revertedWith("Insufficient collateral");
  });

  it("finalizeMatchBlocks reverts when termBlocks is not the first-version fixed value", async function () {
    const { lender, borrower, token, vbl, coordinator } =
      await loadFixture(deployFixture);

    const principal = ethers.parseUnits("100", 18);
    const termBlocks = 2n;
    const rateBps = 0n;

    const { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender } =
      await buildBlocksMatchData({
        vbl,
        borrower,
        lender,
        token,
        principal,
        termBlocks,
        rateBps,
      });

    await vbl
      .connect(lender)
      .reserveForLending(
        lender.address,
        token.target,
        principal,
        lendIntentHash,
      );

    await expect(
      vbl
        .connect(borrower)
        .finalizeMatchBlocks(borrowIntent, [lendIntent], sigBorrower, [
          sigLender,
        ]),
    ).to.be.revertedWithCustomError(
      coordinator,
      "BlocksOnlyCoordinator__InvalidTermBlocks",
    );
  });

  it("repayBlocks keeps a debt-free order open until explicit matured settle", async function () {
    const {
      owner,
      lender,
      borrower,
      token,
      collateralToken,
      le,
      lenderPoolVault,
      vbl,
      coordinator,
      cm,
      pv,
    } = await loadFixture(deployFixture);

    const principal = ethers.parseUnits("250", 18);
    const collateralAmount = ethers.parseUnits("5", 18);

    await collateralToken.transfer(cm.target, collateralAmount);
    await cm.setUserCollateral(
      borrower.address,
      collateralToken.target,
      collateralAmount,
    );
    await pv.setAssetValue(collateralToken.target, principal);

    const { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender } =
      await buildBlocksMatchData({
        vbl,
        borrower,
        lender,
        token,
        principal,
        termBlocks: 1n,
        rateBps: 0n,
        collateralAsset: await collateralToken.getAddress(),
        collateralAmount,
      });

    await vbl
      .connect(lender)
      .reserveForLending(
        lender.address,
        token.target,
        principal,
        lendIntentHash,
      );
    await vbl
      .connect(borrower)
      .finalizeMatchBlocks(borrowIntent, [lendIntent], sigBorrower, [
        sigLender,
      ]);

    await token.connect(borrower).approve(coordinator.target, principal);
    const poolBalBeforeRepay = await token.balanceOf(lenderPoolVault.target);

    const repayTx = await coordinator
      .connect(borrower)
      .repayBlocks(0, principal);
    const repayReceipt = await repayTx.wait();

    expect(await token.balanceOf(lenderPoolVault.target)).to.equal(
      poolBalBeforeRepay + principal,
    );
    expect((await coordinator.getBlocksOnlyOrder(0)).status).to.equal(1n);
    expect(getDataPushTypes(repayReceipt)).to.include(
      DATA_TYPE_BLOCKS_ONLY_REPAID.toLowerCase(),
    );

    await ethers.provider.send("evm_mine", []);

    const borrowerCollateralBefore = await collateralToken.balanceOf(
      borrower.address,
    );
    const settleTx = await coordinator
      .connect(owner)
      .settleOrLiquidateBlocks(0);
    const settleReceipt = await settleTx.wait();

    expect(await collateralToken.balanceOf(borrower.address)).to.equal(
      borrowerCollateralBefore + collateralAmount,
    );
    expect(
      await cm.getCollateral(borrower.address, collateralToken.target),
    ).to.equal(0);

    const settledOrder = await coordinator.getBlocksOnlyOrder(0);
    expect(settledOrder.status).to.equal(3n);
    expect(settledOrder.closeBlock).to.be.gt(0);
    expect(getDataPushTypes(settleReceipt)).to.include(
      DATA_TYPE_BLOCKS_ONLY_SETTLED.toLowerCase(),
    );
  });

  it("P1 blocks_only_maturity_window_repay_vs_keeper_race: ordering permutations must stay single-close and coherent", async function () {
    const {
      owner,
      lender,
      borrower,
      token,
      collateralToken,
      vbl,
      coordinator,
      cm,
      pv,
      lenderPoolVault,
    } = await loadFixture(deployFixture);

    const collateralA = ethers.parseUnits("4", 18);
    const collateralB = ethers.parseUnits("5", 18);
    const principalA = collateralA;
    const principalB = collateralB;

    await collateralToken.transfer(cm.target, collateralA + collateralB);
    await cm.setUserCollateral(
      borrower.address,
      collateralToken.target,
      collateralA + collateralB,
    );
    await pv.setAssetValue(collateralToken.target, principalA + principalB);

    const matchA = await buildBlocksMatchData({
      vbl,
      borrower,
      lender,
      token,
      principal: principalA,
      termBlocks: 1n,
      rateBps: 0n,
      collateralAsset: await collateralToken.getAddress(),
      collateralAmount: collateralA,
    });
    await vbl
      .connect(lender)
      .reserveForLending(
        lender.address,
        token.target,
        principalA,
        matchA.lendIntentHash,
      );
    await vbl
      .connect(borrower)
      .finalizeMatchBlocks(matchA.borrowIntent, [matchA.lendIntent], matchA.sigBorrower, [
        matchA.sigLender,
      ]);

    const matchB = await buildBlocksMatchData({
      vbl,
      borrower,
      lender,
      token,
      principal: principalB,
      termBlocks: 1n,
      rateBps: 0n,
      collateralAsset: await collateralToken.getAddress(),
      collateralAmount: collateralB,
    });
    await vbl
      .connect(lender)
      .reserveForLending(
        lender.address,
        token.target,
        principalB,
        matchB.lendIntentHash,
      );
    await vbl
      .connect(borrower)
      .finalizeMatchBlocks(matchB.borrowIntent, [matchB.lendIntent], matchB.sigBorrower, [
        matchB.sigLender,
      ]);

    await ethers.provider.send("evm_mine", []);

    // Permutation A: borrower repays first, keeper settles second.
    await token.connect(borrower).approve(coordinator.target, principalA + principalB);
    const poolBalBeforeA = await token.balanceOf(lenderPoolVault.target);
    await coordinator.connect(borrower).repayBlocks(0, principalA);
    await coordinator.connect(owner).settleOrLiquidateBlocks(0);

    const orderA = await coordinator.getBlocksOnlyOrder(0);
    expect(orderA.status).to.equal(3n);
    expect(orderA.repaidPrincipal).to.equal(principalA);
    expect(orderA.closeBlock).to.be.gt(0);
    expect(await token.balanceOf(lenderPoolVault.target)).to.equal(
      poolBalBeforeA + principalA,
    );
    await expect(
      coordinator.connect(owner).settleOrLiquidateBlocks(0),
    ).to.be.revertedWithCustomError(
      coordinator,
      "BlocksOnlyCoordinator__OrderNotActive",
    );

    // Permutation B: keeper settles first, borrower repay must be blocked.
    await coordinator.connect(owner).settleOrLiquidateBlocks(1);
    const orderB = await coordinator.getBlocksOnlyOrder(1);
    expect(orderB.status).to.equal(3n);
    expect(orderB.repaidPrincipal).to.equal(principalB);
    expect(orderB.closeBlock).to.be.gt(0);
    await expect(
      coordinator.connect(borrower).repayBlocks(1, principalB),
    ).to.be.revertedWithCustomError(
      coordinator,
      "BlocksOnlyCoordinator__OrderNotActive",
    );
  });

  it("closeRepaidTradeBlocks closes a debt-free order immediately without waiting for maturity", async function () {
    const {
      owner,
      lender,
      borrower,
      token,
      collateralToken,
      lenderPoolVault,
      vbl,
      coordinator,
      cm,
      easyToken,
    } = await loadFixture(deployFixture);

    const principal = ethers.parseUnits("1000", 18);
    const collateralAmount = ethers.parseUnits("4", 18);

    await collateralToken.transfer(cm.target, collateralAmount);
    await cm.setUserCollateral(
      borrower.address,
      collateralToken.target,
      collateralAmount,
    );

    const { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender } =
      await buildBlocksMatchData({
        vbl,
        borrower,
        lender,
        token,
        principal,
        termBlocks: 1n,
        rateBps: 0n,
        collateralAsset: await collateralToken.getAddress(),
        collateralAmount,
      });

    await vbl
      .connect(lender)
      .reserveForLending(
        lender.address,
        token.target,
        principal,
        lendIntentHash,
      );
    await vbl
      .connect(borrower)
      .finalizeMatchBlocks(borrowIntent, [lendIntent], sigBorrower, [
        sigLender,
      ]);

    await token.connect(borrower).approve(coordinator.target, principal);
    await coordinator.connect(borrower).repayBlocks(0, principal);

    const borrowerCollateralBefore = await collateralToken.balanceOf(
      borrower.address,
    );
    const closeTx = await coordinator.connect(owner).closeRepaidTradeBlocks(0);
    const closeReceipt = await closeTx.wait();

    expect(await collateralToken.balanceOf(borrower.address)).to.equal(
      borrowerCollateralBefore + collateralAmount,
    );
    expect(
      await cm.getCollateral(borrower.address, collateralToken.target),
    ).to.equal(0);

    const closedOrder = await coordinator.getBlocksOnlyOrder(0);
    expect(closedOrder.status).to.equal(4n);
    expect(closedOrder.closeBlock).to.be.gt(0);
    expect(getDataPushTypes(closeReceipt)).to.include(
      DATA_TYPE_BLOCKS_ONLY_TRADE_CLOSED.toLowerCase(),
    );
    expect(await easyToken.balanceOf(borrower.address)).to.be.gt(0);
    expect(await easyToken.balanceOf(lenderPoolVault.target)).to.be.gt(0);
  });

  it("closeRepaidTradeBlocks rejects orders whose debt is still outstanding", async function () {
    const { owner, lender, borrower, token, vbl, coordinator } =
      await loadFixture(deployFixture);

    const principal = ethers.parseUnits("90", 18);
    const { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender } =
      await buildBlocksMatchData({
        vbl,
        borrower,
        lender,
        token,
        principal,
        termBlocks: 1n,
        rateBps: 0n,
      });

    await vbl
      .connect(lender)
      .reserveForLending(
        lender.address,
        token.target,
        principal,
        lendIntentHash,
      );
    await vbl
      .connect(borrower)
      .finalizeMatchBlocks(borrowIntent, [lendIntent], sigBorrower, [
        sigLender,
      ]);

    await expect(
      coordinator.connect(owner).closeRepaidTradeBlocks(0),
    ).to.be.revertedWithCustomError(
      coordinator,
      "BlocksOnlyCoordinator__TradeCloseRequiresZeroDebt",
    );
  });

  it("termBlocks=1 reaches maturity on the next transaction without legacy confirmation offset", async function () {
    const {
      owner,
      lender,
      borrower,
      token,
      collateralToken,
      lenderPoolVault,
      vbl,
      coordinator,
      assetWhitelist,
      cm,
    } = await loadFixture(deployFixture);

    const principal = ethers.parseUnits("125", 18);
    const collateralAmount = ethers.parseUnits("3", 18);

    await collateralToken.transfer(cm.target, collateralAmount);
    await cm.setUserCollateral(
      borrower.address,
      collateralToken.target,
      collateralAmount,
    );

    const { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender } =
      await buildBlocksMatchData({
        vbl,
        borrower,
        lender,
        token,
        principal,
        termBlocks: 1n,
        rateBps: 0n,
        collateralAsset: await collateralToken.getAddress(),
        collateralAmount,
      });

    await vbl
      .connect(lender)
      .reserveForLending(
        lender.address,
        token.target,
        principal,
        lendIntentHash,
      );
    await vbl
      .connect(borrower)
      .finalizeMatchBlocks(borrowIntent, [lendIntent], sigBorrower, [
        sigLender,
      ]);

    await token.connect(borrower).approve(coordinator.target, principal);
    const repayTx = await coordinator
      .connect(borrower)
      .repayBlocks(0, principal);
    await repayTx.wait();

    const settleTx = await coordinator
      .connect(owner)
      .settleOrLiquidateBlocks(0);
    await settleTx.wait();

    const settledOrder = await coordinator.getBlocksOnlyOrder(0);
    expect(settledOrder.status).to.equal(3n);
    expect(settledOrder.closeBlock).to.be.gt(0);
  });

  it("settleOrLiquidateBlocks remains callable after maturity without ACTION_LIQUIDATE on caller", async function () {
    const { owner, lender, borrower, token, vbl, coordinator, acm } =
      await loadFixture(deployFixture);

    const principal = ethers.parseUnits("180", 18);
    const { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender } =
      await buildBlocksMatchData({
        vbl,
        borrower,
        lender,
        token,
        principal,
        termBlocks: 1n,
        rateBps: 0n,
      });

    await vbl
      .connect(lender)
      .reserveForLending(
        lender.address,
        token.target,
        principal,
        lendIntentHash,
      );
    await vbl
      .connect(borrower)
      .finalizeMatchBlocks(borrowIntent, [lendIntent], sigBorrower, [
        sigLender,
      ]);

    await ethers.provider.send("evm_mine", []);
    await acm.revokeRole(ACTION_LIQUIDATE, owner.address);

    await expect(
      coordinator.connect(owner).settleOrLiquidateBlocks(0),
    ).to.not.be.reverted;

    const closedOrder = await coordinator.getBlocksOnlyOrder(0);
    expect(closedOrder.status).to.equal(3n);
    expect(closedOrder.closeBlock).to.be.gt(0n);
  });

  it("maturity with outstanding settlement delivers the bound collateral and marks final state", async function () {
    const {
      owner,
      lender,
      borrower,
      token,
      collateralToken,
      lenderPoolVault,
      vbl,
      coordinator,
      pv,
      cm,
      easyToken,
    } = await loadFixture(deployFixture);

    const principal = ethers.parseUnits("1000", 18);
    const collateralAmount = ethers.parseUnits("1000", 18);

    await collateralToken.transfer(cm.target, collateralAmount);
    await cm.setUserCollateral(
      borrower.address,
      collateralToken.target,
      collateralAmount,
    );
    await pv.setAssetValue(collateralToken.target, principal);
    await pv.setAssetValue(collateralToken.target, principal);

    const { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender } =
      await buildBlocksMatchData({
        vbl,
        borrower,
        lender,
        token,
        principal,
        termBlocks: 1n,
        rateBps: 0n,
        collateralAsset: await collateralToken.getAddress(),
        collateralAmount,
      });

    await vbl
      .connect(lender)
      .reserveForLending(
        lender.address,
        token.target,
        principal,
        lendIntentHash,
      );
    await vbl
      .connect(borrower)
      .finalizeMatchBlocks(borrowIntent, [lendIntent], sigBorrower, [
        sigLender,
      ]);

    await ethers.provider.send("evm_mine", []);

    const tx = await coordinator.connect(owner).settleOrLiquidateBlocks(0);
    const receipt = await tx.wait();

    expect(
      await cm.getCollateral(borrower.address, collateralToken.target),
    ).to.equal(0);
    expect(await collateralToken.balanceOf(lenderPoolVault.target)).to.equal(
      collateralAmount,
    );

    const order = await coordinator.getBlocksOnlyOrder(0);
    expect(order.status).to.equal(3n);
    expect(order.repaidPrincipal).to.equal(principal);
    expect(order.closeBlock).to.be.gt(0);
    expect(getDataPushTypes(receipt)).to.include(
      DATA_TYPE_BLOCKS_ONLY_DELIVERED.toLowerCase(),
    );
    expect(await easyToken.balanceOf(borrower.address)).to.be.gt(0);
    expect(await easyToken.balanceOf(lenderPoolVault.target)).to.be.gt(0);
  });

  it("maturity delivery never emits LiquidationShortfallOpened", async function () {
    const {
      owner,
      lender,
      borrower,
      token,
      collateralToken,
      vbl,
      coordinator,
      assetWhitelist,
      lenderPoolVault,
      cm,
    } = await loadFixture(deployFixture);

    const principal = 10n;
    const collateralAmount = 10n;

    await collateralToken.transfer(cm.target, collateralAmount);
    await cm.setUserCollateral(
      borrower.address,
      collateralToken.target,
      collateralAmount,
    );

    const { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender } =
      await buildBlocksMatchData({
        vbl,
        borrower,
        lender,
        token,
        principal,
        termBlocks: 1n,
        rateBps: 0n,
        collateralAsset: await collateralToken.getAddress(),
        collateralAmount,
      });

    await vbl
      .connect(lender)
      .reserveForLending(
        lender.address,
        token.target,
        principal,
        lendIntentHash,
      );
    await vbl
      .connect(borrower)
      .finalizeMatchBlocks(borrowIntent, [lendIntent], sigBorrower, [
        sigLender,
      ]);

    await ethers.provider.send("evm_mine", []);
    const tx = await coordinator.connect(owner).settleOrLiquidateBlocks(0);
    const receipt = await tx.wait();

    const order = await coordinator.getBlocksOnlyOrder(0);
    expect(order.status).to.equal(3n);
    expect(order.repaidPrincipal).to.equal(principal);
    const shortfallOpenedLogs = receipt.logs.filter(
      (log: any) =>
        String(log.topics?.[0] ?? "").toLowerCase() ===
        LIQUIDATION_SHORTFALL_OPENED_TOPIC0,
    );
    expect(shortfallOpenedLogs.length).to.equal(0);
  });

  it("P0 blocks_only_maturity_unpaid_close: keeps trade-like maturity delivery semantics without opening shortfall ledger", async function () {
    const {
      owner,
      lender,
      borrower,
      token,
      collateralToken,
      vbl,
      coordinator,
      cm,
      pv,
    } = await loadFixture(deployFixture);

    const principal = 40n;
    const collateralAmount = 10n;

    await collateralToken.transfer(cm.target, collateralAmount);
    await cm.setUserCollateral(
      borrower.address,
      collateralToken.target,
      collateralAmount,
    );
    await pv.setAssetValue(collateralToken.target, collateralAmount);

    const { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender } =
      await buildBlocksMatchData({
        vbl,
        borrower,
        lender,
        token,
        principal,
        termBlocks: 1n,
        rateBps: 0n,
        collateralAsset: await collateralToken.getAddress(),
        collateralAmount,
      });

    await vbl
      .connect(lender)
      .reserveForLending(
        lender.address,
        token.target,
        principal,
        lendIntentHash,
      );
    await vbl
      .connect(borrower)
      .finalizeMatchBlocks(borrowIntent, [lendIntent], sigBorrower, [
        sigLender,
      ]);

    await ethers.provider.send("evm_mine", []);
    await coordinator.connect(owner).settleOrLiquidateBlocks(0);

    const order = await coordinator.getBlocksOnlyOrder(0);
    expect(order.status).to.equal(3n);
  });

  it("locks principal-triggered EASY entry on maturity delivery close while offset can fully consume mint to zero", async function () {
    const {
      owner,
      lender,
      borrower,
      token,
      collateralToken,
      vbl,
      coordinator,
      cm,
      easyToken,
      lenderPoolVault,
      easyEmissionController,
      rewardAccrualManager,
      guaranteeFund,
    } = await loadFixture(deployFixture);

    const principal = 1200n * 10n ** 18n;
    const partialRepay = 400n * 10n ** 18n;
    const collateralAmount = 100n * 10n ** 18n;

    await collateralToken.transfer(cm.target, collateralAmount);
    await cm.setUserCollateral(
      borrower.address,
      collateralToken.target,
      collateralAmount,
    );

    const { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender } =
      await buildBlocksMatchData({
        vbl,
        borrower,
        lender,
        token,
        principal,
        termBlocks: 1n,
        rateBps: 0n,
        collateralAsset: await collateralToken.getAddress(),
        collateralAmount,
      });

    await vbl
      .connect(lender)
      .reserveForLending(
        lender.address,
        token.target,
        principal,
        lendIntentHash,
      );
    await vbl
      .connect(borrower)
      .finalizeMatchBlocks(borrowIntent, [lendIntent], sigBorrower, [
        sigLender,
      ]);

    // Create maturity shortfall with remainingDebt < 1000u, so this proves the entry is principal-based.
    await token.connect(borrower).approve(coordinator.target, partialRepay);
    await coordinator.connect(borrower).repayBlocks(0, partialRepay);

    const hugePenalty = 100_000n * 10n ** 18n;
    await rewardAccrualManager
      .connect(guaranteeFund)
      .applyPenaltyByGfm(borrower.address, hugePenalty);
    await rewardAccrualManager
      .connect(guaranteeFund)
      .applyPenaltyByGfm(lenderPoolVault.target, hugePenalty);

    const borrowerDebtBefore = await rewardAccrualManager.getPenaltyDebt(
      borrower.address,
    );
    const lenderDebtBefore = await rewardAccrualManager.getPenaltyDebt(
      lenderPoolVault.target,
    );

    expect(await easyToken.balanceOf(borrower.address)).to.equal(0n);
    expect(await easyToken.balanceOf(lenderPoolVault.target)).to.equal(0n);

    await ethers.provider.send("evm_mine", []);
    const tx = await coordinator.connect(owner).settleOrLiquidateBlocks(0);

    await expect(tx)
      .to.emit(easyEmissionController, "EasyMintSkipped")
      .withArgs(
        borrower.address,
        lenderPoolVault.target,
        0n,
        "offset-fully",
      );
    await expect(tx).to.not.emit(easyToken, "EasyMinted");

    const order = await coordinator.getBlocksOnlyOrder(0);
    expect(order.status).to.equal(3n);
    expect(order.principal - order.repaidPrincipal).to.equal(0n);

    expect(await easyToken.balanceOf(borrower.address)).to.equal(0n);
    expect(await easyToken.balanceOf(lenderPoolVault.target)).to.equal(0n);

    const borrowerDebtAfter = await rewardAccrualManager.getPenaltyDebt(
      borrower.address,
    );
    const lenderDebtAfter = await rewardAccrualManager.getPenaltyDebt(
      lenderPoolVault.target,
    );
    expect(borrowerDebtAfter).to.be.lt(borrowerDebtBefore);
    expect(lenderDebtAfter).to.be.lt(lenderDebtBefore);
  });

  it("delivers only the explicit order-bound collateral even when the borrower holds additional assets", async function () {
    const {
      owner,
      lender,
      borrower,
      token,
      collateralToken,
      vbl,
      coordinator,
      assetWhitelist,
      lenderPoolVault,
      cm,
    } = await loadFixture(deployFixture);

    const TokenF = await ethers.getContractFactory("MockERC20");
    const unvaluedCollateral = await TokenF.deploy(
      "Unvalued",
      "UNV",
      18,
      ethers.parseUnits("1000000", 18),
    );

    const principal = 40n;
    const unvaluedBalance = 100n;
    const valuedBalance = 5n;

    await collateralToken.transfer(cm.target, valuedBalance);
    await unvaluedCollateral.transfer(cm.target, unvaluedBalance);
    await assetWhitelist.setAssetAllowed(unvaluedCollateral.target, true);
    await cm.setUserCollateral(
      borrower.address,
      unvaluedCollateral.target,
      unvaluedBalance,
    );
    await cm.setUserCollateral(
      borrower.address,
      collateralToken.target,
      valuedBalance,
    );

    const { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender } =
      await buildBlocksMatchData({
        vbl,
        borrower,
        lender,
        token,
        principal,
        termBlocks: 1n,
        rateBps: 0n,
        collateralAsset: unvaluedCollateral.target,
        collateralAmount: unvaluedBalance,
      });

    await vbl
      .connect(lender)
      .reserveForLending(
        lender.address,
        token.target,
        principal,
        lendIntentHash,
      );
    await vbl
      .connect(borrower)
      .finalizeMatchBlocks(borrowIntent, [lendIntent], sigBorrower, [
        sigLender,
      ]);

    await ethers.provider.send("evm_mine", []);

    await coordinator.connect(owner).settleOrLiquidateBlocks(0);

    expect(await cm.getCollateral(borrower.address, collateralToken.target)).to.equal(valuedBalance);
    expect(await cm.getCollateral(borrower.address, unvaluedCollateral.target)).to.equal(0n);
    expect(await unvaluedCollateral.balanceOf(lenderPoolVault.target)).to.equal(unvaluedBalance);
  });
});
