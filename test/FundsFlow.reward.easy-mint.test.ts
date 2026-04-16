import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Funds-Flow (SSOT) – Reward EasyToken mint on repay (OrderEngine → RewardManager → EasyEmissionController)
 *
 * Doc reference:
 * - docs/Usage-Guide/Funds-Flow-Architecture-Guide.md §4, §7
 * - docs/Usage-Guide/Reward-System-Usage-Guide.md
 */

describe("Funds-Flow – Reward EasyToken mint", function () {
  const KEY_ORDER_ENGINE = ethers.id("ORDER_ENGINE");
  const KEY_RM = ethers.id("REWARD_MANAGER");
  const KEY_REWARD_MANAGER_CORE = ethers.id("REWARD_MANAGER_CORE");
  const KEY_REWARD_ACCRUAL_MANAGER = ethers.id("REWARD_ACCRUAL_MANAGER");
  const KEY_GUARANTEE_FUND = ethers.id("GUARANTEE_FUND_MANAGER");
  const KEY_EASY_EMISSION_CONTROLLER = ethers.id("EASY_EMISSION_CONTROLLER");
  const KEY_EASY_EMISSION_CONFIG = ethers.id("EASY_EMISSION_CONFIG");
  const KEY_EASY_TOKEN = ethers.id("EASY_TOKEN");
  const KEY_LOAN_FLOW_VIEW = ethers.id("LOAN_FLOW_VIEW");
  const KEY_PRICE_ORACLE = ethers.id("PRICE_ORACLE");
  const KEY_REWARD_VIEW = ethers.id("REWARD_VIEW");

  const DATA_TYPE_EASY_MINTED = ethers.keccak256(ethers.toUtf8Bytes("EASY_MINTED"));

  const DATA_PUSH_IFACE = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
  const DATA_PUSH_TOPIC0 = ethers.id("DataPushed(bytes32,bytes)").toLowerCase();

  function getDataPushTypes(receipt: any, emitter?: string): string[] {
    return receipt.logs
      .filter((log: any) => {
        if ((log.topics?.[0] || "").toLowerCase() !== DATA_PUSH_TOPIC0) return false;
        if (!emitter) return true;
        return log.address.toLowerCase() === emitter.toLowerCase();
      })
      .map((log: any) => DATA_PUSH_IFACE.parseLog(log))
      .filter((parsed: any) => parsed !== null)
      .map((parsed: any) => parsed.args.dataTypeHash.toLowerCase());
  }

  function expectedShares(amountBaseUnits: bigint) {
    const netUsd8 = (amountBaseUnits * 100_000_000n * 9970n) / 10_000n / 10n ** 18n;
    const mintPer1000Usd = 10n * 10n ** 18n;
    const expectedMint = (netUsd8 * mintPer1000Usd) / (1000n * 100_000_000n);
    const expectedBorrowerShare = expectedMint / 2n;
    const expectedLenderShare = expectedMint - expectedBorrowerShare;
    return { expectedMint, expectedBorrowerShare, expectedLenderShare };
  }

  async function deployFixture() {
    const [admin, orderEngine, borrower, lender, guaranteeFund] = await ethers.getSigners();

    const RegistryF = await ethers.getContractFactory("MockRegistry");
    const registry = await RegistryF.deploy();

    const RewardManagerCoreF = await ethers.getContractFactory("RewardManagerCore");
    const rewardManagerCore = await upgrades.deployProxy(
      RewardManagerCoreF,
      [registry.target],
      { kind: "uups", initializer: "initialize" }
    );

    const RewardAccrualManagerF = await ethers.getContractFactory("RewardAccrualManager");
    const rewardAccrualManager = await upgrades.deployProxy(
      RewardAccrualManagerF,
      [registry.target],
      { kind: "uups", initializer: "initialize" }
    );

    const RewardManagerF = await ethers.getContractFactory("RewardManager");
    const rewardManager = await upgrades.deployProxy(
      RewardManagerF,
      [registry.target],
      { kind: "uups", initializer: "initialize" }
    );

    const EasyEmissionControllerF = await ethers.getContractFactory("EasyEmissionController");
    const easyEmissionController = await upgrades.deployProxy(
      EasyEmissionControllerF,
      [registry.target],
      { kind: "uups", initializer: "initialize" }
    );

    const EasyEmissionConfigF = await ethers.getContractFactory("EasyEmissionConfig");
    const easyEmissionConfig = await upgrades.deployProxy(
      EasyEmissionConfigF,
      [registry.target],
      { kind: "uups", initializer: "initialize" }
    );

    const EasyTokenF = await ethers.getContractFactory("EasyToken");
    const easyToken = await upgrades.deployProxy(
      EasyTokenF,
      [admin.address],
      { kind: "uups", initializer: "initialize" }
    );

    const LoanFlowViewF = await ethers.getContractFactory("LoanFlowView");
    const loanFlowView = await upgrades.deployProxy(
      LoanFlowViewF,
      [registry.target],
      { kind: "uups", initializer: "initialize" }
    );

    const RewardViewF = await ethers.getContractFactory("RewardView");
    const rewardView = await upgrades.deployProxy(
      RewardViewF,
      [registry.target],
      { kind: "uups", initializer: "initialize" }
    );

    const PriceOracleF = await ethers.getContractFactory("MockPriceOracle");
    const priceOracle = await PriceOracleF.deploy();

    const AssetTokenF = await ethers.getContractFactory("MockERC20");
    const asset = await AssetTokenF.deploy("Mock USDC", "USDC", 18, ethers.parseUnits("1000000", 18));

    await registry.setModule(KEY_ORDER_ENGINE, orderEngine.address);
    await registry.setModule(KEY_RM, rewardManager.target);
    await registry.setModule(KEY_REWARD_MANAGER_CORE, rewardManagerCore.target);
    await registry.setModule(KEY_REWARD_ACCRUAL_MANAGER, rewardAccrualManager.target);
    await registry.setModule(KEY_GUARANTEE_FUND, guaranteeFund.address);
    await registry.setModule(KEY_EASY_EMISSION_CONTROLLER, easyEmissionController.target);
    await registry.setModule(KEY_EASY_EMISSION_CONFIG, easyEmissionConfig.target);
    await registry.setModule(KEY_EASY_TOKEN, easyToken.target);
    await registry.setModule(KEY_LOAN_FLOW_VIEW, loanFlowView.target);
    await registry.setModule(KEY_PRICE_ORACLE, priceOracle.target);
    await registry.setModule(KEY_REWARD_VIEW, rewardView.target);

    await easyToken.connect(admin).setSoleMinter(easyEmissionController.target);
    await easyToken.connect(admin).grantRole(await easyToken.BURNER_ROLE(), rewardAccrualManager.target);

    const currentBlock = await ethers.provider.getBlockNumber();
    await priceOracle.setPrice(asset.target, ethers.parseUnits("1", 18), currentBlock, 18);

    return {
      admin,
      orderEngine,
      borrower,
      lender,
      guaranteeFund,
      registry,
      rewardManager,
      easyEmissionController,
      rewardAccrualManager,
      easyToken,
      rewardView,
      asset,
    };
  }

  it("repay outcome triggers EasyMinted + RewardView DataPushed", async function () {
    const { orderEngine, borrower, lender, rewardManager, easyToken, rewardView, asset } =
      await loadFixture(deployFixture);

    const orderId = 1n;
    const amountBaseUnits = ethers.parseUnits("1100", 18);
    const maturity = 1000n;
    const outcomeRepayOnTimeFull = 1;

    const borrowerBalBefore = await easyToken.balanceOf(borrower.address);
    const lenderBalBefore = await easyToken.balanceOf(lender.address);

    const tx = await rewardManager
      .connect(orderEngine)
      .onLoanEventByOrderWithLender(
        borrower.address,
        lender.address,
        asset.target,
        orderId,
        amountBaseUnits,
        maturity,
        outcomeRepayOnTimeFull
      );

    const receipt = await tx.wait();

    const { expectedBorrowerShare, expectedLenderShare } = expectedShares(amountBaseUnits);

    const borrowerBalAfter = await easyToken.balanceOf(borrower.address);
    const lenderBalAfter = await easyToken.balanceOf(lender.address);

    expect(borrowerBalAfter - borrowerBalBefore).to.equal(expectedBorrowerShare);
    expect(lenderBalAfter - lenderBalBefore).to.equal(expectedLenderShare);

    await expect(tx)
      .to.emit(easyToken, "EasyMinted")
      .withArgs(borrower.address, expectedBorrowerShare)
      .and.to.emit(easyToken, "EasyMinted")
      .withArgs(lender.address, expectedLenderShare);

    const dataTypes = getDataPushTypes(receipt, rewardView.target.toString());
    expect(dataTypes).to.include(DATA_TYPE_EASY_MINTED.toLowerCase());
  });

  it("early and late full repay outcomes also trigger Easy mint", async function () {
    const { orderEngine, borrower, lender, rewardManager, easyToken, asset } = await loadFixture(deployFixture);

    const amountBaseUnits = ethers.parseUnits("1100", 18);
    const maturity = 1000n;
    const { expectedBorrowerShare, expectedLenderShare } = expectedShares(amountBaseUnits);

    for (const [orderId, outcome] of [[2n, 2], [3n, 3]] as const) {
      const borrowerBalBefore = await easyToken.balanceOf(borrower.address);
      const lenderBalBefore = await easyToken.balanceOf(lender.address);

      await rewardManager
        .connect(orderEngine)
        .onLoanEventByOrderWithLender(
          borrower.address,
          lender.address,
          asset.target,
          orderId,
          amountBaseUnits,
          maturity,
          outcome
        );

      const borrowerBalAfter = await easyToken.balanceOf(borrower.address);
      const lenderBalAfter = await easyToken.balanceOf(lender.address);

      expect(borrowerBalAfter - borrowerBalBefore).to.equal(expectedBorrowerShare);
      expect(lenderBalAfter - lenderBalBefore).to.equal(expectedLenderShare);
    }
  });

  it("offsets pending penalty debt before minting Easy for both borrower and lender", async function () {
    const { orderEngine, borrower, lender, guaranteeFund, rewardManager, rewardAccrualManager, easyToken, asset } =
      await loadFixture(deployFixture);

    const orderId = 11n;
    const amountBaseUnits = ethers.parseUnits("1100", 18);
    const maturity = 1000n;
    const outcomeRepayOnTimeFull = 1;
    const { expectedBorrowerShare, expectedLenderShare } = expectedShares(amountBaseUnits);
    const borrowerPenalty = expectedBorrowerShare / 3n;
    const lenderPenalty = expectedLenderShare / 4n;

    await rewardAccrualManager.connect(guaranteeFund).applyPenaltyByGfm(borrower.address, borrowerPenalty);
    await rewardAccrualManager.connect(guaranteeFund).applyPenaltyByGfm(lender.address, lenderPenalty);

    await rewardManager
      .connect(orderEngine)
      .onLoanEventByOrderWithLender(
        borrower.address,
        lender.address,
        asset.target,
        orderId,
        amountBaseUnits,
        maturity,
        outcomeRepayOnTimeFull
      );

    expect(await easyToken.balanceOf(borrower.address)).to.equal(expectedBorrowerShare - borrowerPenalty);
    expect(await easyToken.balanceOf(lender.address)).to.equal(expectedLenderShare - lenderPenalty);
    expect(await rewardAccrualManager.getPenaltyDebt(borrower.address)).to.equal(0n);
    expect(await rewardAccrualManager.getPenaltyDebt(lender.address)).to.equal(0n);
  });
});
