import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, mine } from "@nomicfoundation/hardhat-network-helpers";
import type { MockERC20 } from "../types/src/Mocks/MockERC20";
import type { LendingEngine } from "../types/src/core/LendingEngine.sol/LendingEngine";
import type { EasyToken } from "../types/src/Token/EasyToken";
import type { RewardAccrualManager } from "../types/src/Reward/RewardAccrualManager";
import type { RewardView } from "../types/src/Vault/view/modules/RewardView.sol/RewardView";

import { ModuleKeys } from "../frontend-config/moduleKeys";

describe("Funds-Flow – protocol Easy mint E2E", function () {
  const LendingEngineFQN = "src/core/LendingEngine.sol:LendingEngine";

  const ACTION_ORDER_CREATE = ethers.keccak256(ethers.toUtf8Bytes("ORDER_CREATE"));
  const ACTION_REPAY = ethers.keccak256(ethers.toUtf8Bytes("REPAY"));
  const ACTION_VIEW_SYSTEM_DATA = ethers.keccak256(ethers.toUtf8Bytes("VIEW_SYSTEM_DATA"));
  const ACTION_VIEW_USER_DATA = ethers.keccak256(ethers.toUtf8Bytes("VIEW_USER_DATA"));
  const ACTION_UPGRADE_MODULE = ethers.keccak256(ethers.toUtf8Bytes("UPGRADE_MODULE"));
  const ACTION_PAUSE_SYSTEM = ethers.keccak256(ethers.toUtf8Bytes("PAUSE_SYSTEM"));
  const ACTION_UNPAUSE_SYSTEM = ethers.keccak256(ethers.toUtf8Bytes("UNPAUSE_SYSTEM"));
  const ACTION_BORROW = ethers.keccak256(ethers.toUtf8Bytes("BORROW"));

  const DATA_TYPE_EASY_MINTED = ethers.keccak256(ethers.toUtf8Bytes("EASY_MINTED"));
  const DATA_PUSH_IFACE = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
  const DATA_PUSH_TOPIC0 = ethers.id("DataPushed(bytes32,bytes)").toLowerCase();

  const PRICE_USD8 = 10n ** 8n;
  const TERM_5D_BLOCKS = 36_000n;
  const ON_TIME_WINDOW_BLOCKS = 7_200n;
  const YEAR_BLOCKS = 2_628_000n;
  const RATE_BPS = 1_000n;
  const BORROW_FEE_BPS = 30n;
  const BPS_DENOM = 10_000n;
  const LATE_PENALTY_EASY = (10n ** 18n * 500n) / 10_000n;

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

  function calcInterest(principal: bigint, rateBps: bigint, termBlocks: bigint): bigint {
    return (principal * rateBps * termBlocks) / (YEAR_BLOCKS * BPS_DENOM);
  }

  function calcExpectedMintShares(principal: bigint) {
    const amountUsd8Gross = (principal * PRICE_USD8) / 10n ** 18n;
    const amountUsd8Net = (amountUsd8Gross * (BPS_DENOM - BORROW_FEE_BPS)) / BPS_DENOM;
    const totalMinted = (amountUsd8Net * 10n * 10n ** 18n) / (1000n * PRICE_USD8);
    const borrowerShare = totalMinted / 2n;
    const lenderShare = totalMinted - borrowerShare;
    return { totalMinted, borrowerShare, lenderShare };
  }

  async function deployFixture() {
    const [governance, borrower, guaranteeFund] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory("MockRegistry")).deploy();
    await registry.waitForDeployment();

    const acm = await (await ethers.getContractFactory("MockAccessControlManager")).deploy();
    await acm.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, await acm.getAddress());

    const pool = await (await ethers.getContractFactory("SimpleMock")).deploy();
    await pool.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_LENDER_POOL_VAULT, await pool.getAddress());

    const feeRouter = await (await ethers.getContractFactory("MockFeeRouter")).deploy();
    await feeRouter.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_FR, await feeRouter.getAddress());

    const vaultCore = await (await ethers.getContractFactory("MockVaultCore")).deploy();
    await vaultCore.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_VAULT_CORE, await vaultCore.getAddress());

    const RewardManagerCoreF = await ethers.getContractFactory("RewardManagerCore");
    const rewardManagerCore = await upgrades.deployProxy(RewardManagerCoreF, [registry.target], {
      kind: "uups",
      initializer: "initialize",
    });

    const RewardAccrualManagerF = await ethers.getContractFactory("RewardAccrualManager");
    const rewardAccrualManager = (await upgrades.deployProxy(RewardAccrualManagerF, [registry.target], {
      kind: "uups",
      initializer: "initialize",
    })) as RewardAccrualManager;

    const RewardManagerF = await ethers.getContractFactory("RewardManager");
    const rewardManager = await upgrades.deployProxy(RewardManagerF, [registry.target], {
      kind: "uups",
      initializer: "initialize",
    });

    const EasyEmissionControllerF = await ethers.getContractFactory("EasyEmissionController");
    const easyEmissionController = await upgrades.deployProxy(EasyEmissionControllerF, [registry.target], {
      kind: "uups",
      initializer: "initialize",
    });

    const EasyEmissionConfigF = await ethers.getContractFactory("EasyEmissionConfig");
    const easyEmissionConfig = await upgrades.deployProxy(EasyEmissionConfigF, [registry.target], {
      kind: "uups",
      initializer: "initialize",
    });

    const EasyTokenF = await ethers.getContractFactory("EasyToken");
    const easyToken = (await upgrades.deployProxy(EasyTokenF, [governance.address], {
      kind: "uups",
      initializer: "initialize",
    })) as EasyToken;

    const RewardViewF = await ethers.getContractFactory("RewardView");
    const rewardView = (await upgrades.deployProxy(RewardViewF, [registry.target], {
      kind: "uups",
      initializer: "initialize",
    })) as RewardView;

    const LoanFlowViewF = await ethers.getContractFactory("MockLoanFlowView");
    const loanFlowView = await LoanFlowViewF.deploy();
    await loanFlowView.waitForDeployment();

    const PriceOracleF = await ethers.getContractFactory("MockPriceOracle");
    const priceOracle = await PriceOracleF.deploy();
    await priceOracle.waitForDeployment();

    const LendingEngineF = await ethers.getContractFactory(LendingEngineFQN);
    const orderEngine = (await upgrades.deployProxy(LendingEngineF, [await registry.getAddress()], {
      kind: "uups",
      initializer: "initialize",
    })) as LendingEngine;
    await orderEngine.waitForDeployment();

    const LoanNFT = await ethers.getContractFactory("LoanNFT");
    const loanNFT = await upgrades.deployProxy(
      LoanNFT,
      ["Loan NFT", "LOAN", "https://example.invalid/token/", await registry.getAddress()],
      { kind: "uups", initializer: "initialize" }
    );
    await loanNFT.waitForDeployment();

    const token = (await (await ethers.getContractFactory("MockERC20")).deploy(
      "DebtToken",
      "DEBT",
      18,
      ethers.parseEther("1")
    )) as MockERC20;
    await token.waitForDeployment();

    await registry.setModule(ModuleKeys.KEY_ORDER_ENGINE, await orderEngine.getAddress());
    await registry.setModule(ModuleKeys.KEY_RM, await rewardManager.getAddress());
    await registry.setModule(ModuleKeys.KEY_REWARD_MANAGER_CORE, await rewardManagerCore.getAddress());
    await registry.setModule(ModuleKeys.KEY_REWARD_ACCRUAL_MANAGER, await rewardAccrualManager.getAddress());
    await registry.setModule(ModuleKeys.KEY_EASY_EMISSION_CONTROLLER, await easyEmissionController.getAddress());
    await registry.setModule(ModuleKeys.KEY_EASY_EMISSION_CONFIG, await easyEmissionConfig.getAddress());
    await registry.setModule(ModuleKeys.KEY_EASY_TOKEN, await easyToken.getAddress());
    await registry.setModule(ModuleKeys.KEY_REWARD_VIEW, await rewardView.getAddress());
    await registry.setModule(ModuleKeys.KEY_LOAN_FLOW_VIEW, await loanFlowView.getAddress());
    await registry.setModule(ModuleKeys.KEY_PRICE_ORACLE, await priceOracle.getAddress());
    await registry.setModule(ModuleKeys.KEY_LOAN_NFT, await loanNFT.getAddress());
    await registry.setModule(ModuleKeys.KEY_GUARANTEE_FUND, guaranteeFund.address);

    await easyToken.connect(governance).setSoleMinter(await easyEmissionController.getAddress());
    await easyToken.connect(governance).grantRole(await easyToken.BURNER_ROLE(), await rewardAccrualManager.getAddress());

    const currentBlock = await ethers.provider.getBlockNumber();
    await priceOracle.setPrice(await token.getAddress(), PRICE_USD8, currentBlock, 18);
    await loanFlowView.setGlobalLoanFlow(0n, 0n, 0n, 0n, true, BigInt(currentBlock));

    await acm.grantRole(ACTION_ORDER_CREATE, governance.address);
    await acm.grantRole(ACTION_REPAY, borrower.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, governance.address);
    await acm.grantRole(ACTION_VIEW_USER_DATA, governance.address);
    await acm.grantRole(ACTION_UPGRADE_MODULE, governance.address);
    await acm.grantRole(ACTION_PAUSE_SYSTEM, governance.address);
    await acm.grantRole(ACTION_UNPAUSE_SYSTEM, governance.address);
    await acm.grantRole(ACTION_BORROW, await orderEngine.getAddress());

    return {
      governance,
      borrower,
      guaranteeFund,
      registry,
      acm,
      pool,
      feeRouter,
      vaultCore,
      rewardManager,
      rewardManagerCore,
      rewardAccrualManager,
      easyEmissionController,
      easyToken,
      rewardView,
      loanFlowView,
      priceOracle,
      orderEngine,
      loanNFT,
      token,
    };
  }

  async function createProtocolOrder(fixture: Awaited<ReturnType<typeof deployFixture>>) {
    const { governance, borrower, pool, orderEngine, token } = fixture;

    const principal = ethers.parseEther("1100");
    const totalDue = principal + calcInterest(principal, RATE_BPS, TERM_5D_BLOCKS);

    await orderEngine.connect(governance).createLoanOrder({
      principal,
      rate: RATE_BPS,
      term: TERM_5D_BLOCKS,
      borrower: borrower.address,
      lender: await pool.getAddress(),
      asset: await token.getAddress(),
      startTimestamp: 0n,
      maturity: 0n,
      repaidAmount: 0n,
    });

    const orderId = 0n;
    const order = await orderEngine.connect(governance).getLoanOrderForView(orderId);
    return { orderId, principal, totalDue, order };
  }

  async function fundAndApproveBorrower(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    totalDue: bigint
  ) {
    const { borrower, orderEngine, token } = fixture;
    await token.mint(borrower.address, totalDue);
    await token.connect(borrower).approve(await orderEngine.getAddress(), totalDue);
  }

  it("on-time full repay mints Easy through the real LendingEngine -> RewardManager -> EasyEmissionController path", async function () {
    const fixture = await loadFixture(deployFixture);
    const { borrower, governance, pool, orderEngine, easyToken, rewardView } = fixture;
    const { orderId, principal, totalDue, order } = await createProtocolOrder(fixture);
    const { borrowerShare, lenderShare } = calcExpectedMintShares(principal);

    const currentBlock = BigInt(await ethers.provider.getBlockNumber());
    const targetBlock = order.maturity - ON_TIME_WINDOW_BLOCKS;
    if (targetBlock > currentBlock) {
      await mine(Number(targetBlock - currentBlock));
    }

    await fundAndApproveBorrower(fixture, totalDue);

    const tx = await orderEngine.connect(borrower).repay(orderId, totalDue);
    const receipt = await tx.wait();

    expect(await easyToken.balanceOf(borrower.address)).to.equal(borrowerShare);
    expect(await easyToken.balanceOf(await pool.getAddress())).to.equal(lenderShare);

    const [borrowerEasy] = await rewardView.connect(governance).getUserEasyEarnedWithMeta(borrower.address);
    const [poolEasy] = await rewardView.connect(governance).getUserEasyEarnedWithMeta(await pool.getAddress());
    const [, borrowerPenalty] = await rewardView.connect(borrower).getUserRewardSummaryWithMeta(borrower.address);

    expect(borrowerEasy).to.equal(borrowerShare);
    expect(poolEasy).to.equal(lenderShare);
    expect(borrowerPenalty).to.equal(0n);

    const dataTypes = getDataPushTypes(receipt, (await rewardView.getAddress()).toString());
    expect(dataTypes).to.include(DATA_TYPE_EASY_MINTED.toLowerCase());
  });

  it("early full repay still mints Easy on the real protocol path and does not create penalty debt", async function () {
    const fixture = await loadFixture(deployFixture);
    const { borrower, governance, pool, orderEngine, easyToken, rewardView } = fixture;
    const { orderId, principal, totalDue } = await createProtocolOrder(fixture);
    const { borrowerShare, lenderShare } = calcExpectedMintShares(principal);

    await fundAndApproveBorrower(fixture, totalDue);
    await orderEngine.connect(borrower).repay(orderId, totalDue);

    expect(await easyToken.balanceOf(borrower.address)).to.equal(borrowerShare);
    expect(await easyToken.balanceOf(await pool.getAddress())).to.equal(lenderShare);

    const [, borrowerPenalty] = await rewardView.connect(borrower).getUserRewardSummaryWithMeta(borrower.address);
    expect(borrowerPenalty).to.equal(0n);

    const [borrowerEasy] = await rewardView.connect(governance).getUserEasyEarnedWithMeta(borrower.address);
    const [poolEasy] = await rewardView.connect(governance).getUserEasyEarnedWithMeta(await pool.getAddress());
    expect(borrowerEasy).to.equal(borrowerShare);
    expect(poolEasy).to.equal(lenderShare);
  });

  it("late full repay applies RMCore late penalty first, then offsets it from Easy mint on the real protocol path", async function () {
    const fixture = await loadFixture(deployFixture);
    const { borrower, governance, pool, orderEngine, easyToken, rewardView, rewardAccrualManager } = fixture;
    const { orderId, principal, totalDue, order } = await createProtocolOrder(fixture);
    const { borrowerShare, lenderShare } = calcExpectedMintShares(principal);

    const currentBlock = BigInt(await ethers.provider.getBlockNumber());
    const targetBlock = order.maturity + ON_TIME_WINDOW_BLOCKS + 1n;
    if (targetBlock > currentBlock) {
      await mine(Number(targetBlock - currentBlock));
    }

    await fundAndApproveBorrower(fixture, totalDue);
    await orderEngine.connect(borrower).repay(orderId, totalDue);

    expect(await easyToken.balanceOf(borrower.address)).to.equal(borrowerShare - LATE_PENALTY_EASY);
    expect(await easyToken.balanceOf(await pool.getAddress())).to.equal(lenderShare);
    expect(await rewardAccrualManager.getPenaltyDebt(borrower.address)).to.equal(0n);

    const [borrowerEasy] = await rewardView.connect(governance).getUserEasyEarnedWithMeta(borrower.address);
    const [poolEasy] = await rewardView.connect(governance).getUserEasyEarnedWithMeta(await pool.getAddress());
    const [, borrowerPenalty] = await rewardView.connect(borrower).getUserRewardSummaryWithMeta(borrower.address);

    expect(borrowerEasy).to.equal(borrowerShare - LATE_PENALTY_EASY);
    expect(poolEasy).to.equal(lenderShare);
    expect(borrowerPenalty).to.equal(0n);
  });
});