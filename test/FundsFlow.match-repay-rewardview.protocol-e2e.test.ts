import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, mine } from "@nomicfoundation/hardhat-network-helpers";
import type { MockERC20 } from "../types/src/Mocks/MockERC20";
import type { LendingEngine } from "../types/src/core/LendingEngine.sol/LendingEngine";
import type { EasyToken } from "../types/src/Token/EasyToken";
import type { FeeRouter } from "../types/src/Vault/FeeRouter";
import type { VaultBusinessLogic } from "../types/src/Vault/modules/VaultBusinessLogic";
import type { RewardView } from "../types/src/Vault/view/modules/RewardView.sol/RewardView";

import { ModuleKeys } from "../frontend-config/moduleKeys";

describe("Funds-Flow – match to reward-view protocol E2E", function () {
  const LendingEngineFQN = "src/core/LendingEngine.sol:LendingEngine";

  const ACTION_ORDER_CREATE = ethers.keccak256(ethers.toUtf8Bytes("ORDER_CREATE"));
  const ACTION_DEPOSIT = ethers.keccak256(ethers.toUtf8Bytes("DEPOSIT"));
  const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes("SET_PARAMETER"));
  const ACTION_REPAY = ethers.keccak256(ethers.toUtf8Bytes("REPAY"));
  const ACTION_VIEW_USER_DATA = ethers.keccak256(ethers.toUtf8Bytes("VIEW_USER_DATA"));
  const ACTION_VIEW_SYSTEM_DATA = ethers.keccak256(ethers.toUtf8Bytes("VIEW_SYSTEM_DATA"));
  const ACTION_BORROW = ethers.keccak256(ethers.toUtf8Bytes("BORROW"));

  const DATA_TYPE_RESERVE_CONSUMED = ethers.keccak256(ethers.toUtf8Bytes("RESERVE_CONSUMED"));
  const DATA_TYPE_FEE_DISTRIBUTED = ethers.keccak256(ethers.toUtf8Bytes("FEE_DISTRIBUTED"));
  const DATA_TYPE_LOAN_CREATED = ethers.keccak256(ethers.toUtf8Bytes("LOAN_CREATED"));
  const DATA_TYPE_EASY_MINTED = ethers.keccak256(ethers.toUtf8Bytes("EASY_MINTED"));
  const DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED = ethers.keccak256(
    ethers.toUtf8Bytes("REWARD_PENALTY_LEDGER_UPDATED")
  );
  const DATA_TYPE_PENALTY_LEDGER_OP = ethers.keccak256(ethers.toUtf8Bytes("PENALTY_LEDGER"));
  const DATA_TYPE_GUARANTEE_RELEASED = ethers.keccak256(ethers.toUtf8Bytes("GUARANTEE_RELEASED"));
  const DATA_TYPE_GUARANTEE_FORFEITED = ethers.keccak256(ethers.toUtf8Bytes("GUARANTEE_FORFEITED"));
  const REWARD_VIEW_UNAVAILABLE_HEX = ethers.hexlify(ethers.toUtf8Bytes("rewardView unavailable"));

  const BORROW_INTENT_TYPES = {
    BorrowIntent: [
      { name: "borrower", type: "address" },
      { name: "collateralAsset", type: "address" },
      { name: "collateralAmount", type: "uint256" },
      { name: "borrowAsset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "termDays", type: "uint16" },
      { name: "rateBps", type: "uint256" },
      { name: "expireAt", type: "uint256" },
      { name: "salt", type: "bytes32" },
    ],
  } as const;

  const LEND_INTENT_TYPES = {
    LendIntent: [
      { name: "lenderSigner", type: "address" },
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "minTermDays", type: "uint16" },
      { name: "maxTermDays", type: "uint16" },
      { name: "minRateBps", type: "uint256" },
      { name: "expireAt", type: "uint256" },
      { name: "salt", type: "bytes32" },
    ],
  } as const;

  const DATA_PUSH_IFACE = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
  const DATA_PUSH_TOPIC0 = ethers.id("DataPushed(bytes32,bytes)").toLowerCase();
  const REWARD_VIEW_PUSH_FAILED_IFACE = new ethers.Interface([
    "event RewardViewPushFailed(address indexed user, address indexed rewardView, bytes32 indexed op, bytes payload, bytes reason)",
  ]);
  const REWARD_VIEW_PUSH_FAILED_TOPIC0 = ethers.id(
    "RewardViewPushFailed(address,address,bytes32,bytes,bytes)"
  ).toLowerCase();
  const ABI = ethers.AbiCoder.defaultAbiCoder();

  const PRICE_USD8 = 10n ** 8n;
  const TERM_DAYS = 5;
  const TERM_5D_BLOCKS = 36_000n;
  const ON_TIME_WINDOW_BLOCKS = 7_200n;
  const RATE_BPS = 1_000n;
  const FEE_BPS = 300n;
  const BORROW_FEE_BPS = 30n;
  const BPS_DENOM = 10_000n;
  const YEAR_BLOCKS = 2_628_000n;
  const LATE_PENALTY_EASY = (10n ** 18n * 500n) / 10_000n;

  type GuaranteeRecordLike = {
    promisedInterest: bigint;
    startTime: bigint;
    maturityTime: bigint;
    earlyRepayPenaltyDays: bigint;
  };

  function getDataPushEntries(receipt: any, emitter?: string) {
    return receipt.logs
      .filter((log: any) => {
        if ((log.topics?.[0] || "").toLowerCase() !== DATA_PUSH_TOPIC0) return false;
        if (!emitter) return true;
        return log.address.toLowerCase() === emitter.toLowerCase();
      })
      .map((log: any) => DATA_PUSH_IFACE.parseLog(log))
      .filter((parsed: any) => parsed !== null)
      .map((parsed: any) => ({ dataTypeHash: parsed.args.dataTypeHash.toLowerCase(), payload: parsed.args.payload }));
  }

  function getRewardViewPushFailedEntries(receipt: any, emitter?: string) {
    return receipt.logs
      .filter((log: any) => {
        if ((log.topics?.[0] || "").toLowerCase() !== REWARD_VIEW_PUSH_FAILED_TOPIC0) return false;
        if (!emitter) return true;
        return log.address.toLowerCase() === emitter.toLowerCase();
      })
      .map((log: any) => REWARD_VIEW_PUSH_FAILED_IFACE.parseLog(log))
      .filter((parsed: any) => parsed !== null)
      .map((parsed: any) => ({
        user: parsed.args.user,
        rewardView: parsed.args.rewardView,
        op: parsed.args.op.toLowerCase(),
        payload: parsed.args.payload,
        reason: ethers.hexlify(ethers.getBytes(parsed.args.reason)).toLowerCase(),
      }));
  }

  function calcInterest(principal: bigint, rateBps: bigint, termBlocks: bigint): bigint {
    return (principal * rateBps * termBlocks) / (YEAR_BLOCKS * BPS_DENOM);
  }

  function calcExpectedGuaranteeInterest(principal: bigint, annualRateBps: bigint, termDays: bigint): bigint {
    return (principal * annualRateBps * termDays) / (365n * BPS_DENOM);
  }

  function calcExpectedEarlyRepaymentSplit(
    record: GuaranteeRecordLike,
    platformFeeRateBps: bigint,
    currentBlock: bigint
  ) {
    const startBlock = record.startTime;
    const maturityBlock = record.maturityTime;
    let totalBlocks = maturityBlock > startBlock ? maturityBlock - startBlock : 0n;
    if (totalBlocks === 0n) totalBlocks = 1n;

    let elapsedBlocks = currentBlock - startBlock;
    if (elapsedBlocks > totalBlocks) elapsedBlocks = totalBlocks;

    const promised = record.promisedInterest;
    const actualInterestPaid = (promised * elapsedBlocks) / totalBlocks;

    const penaltyBlocks = record.earlyRepayPenaltyDays;
    let penaltyInterest = (promised * penaltyBlocks) / totalBlocks;

    const remainingGuarantee = promised - actualInterestPaid;
    if (penaltyInterest > remainingGuarantee) penaltyInterest = remainingGuarantee;

    const platformFee = (penaltyInterest * platformFeeRateBps) / BPS_DENOM;
    const penaltyToLender = actualInterestPaid + penaltyInterest - platformFee;
    const refundToBorrower = promised - actualInterestPaid - penaltyInterest;

    return { actualInterestPaid, penaltyToLender, refundToBorrower, platformFee };
  }

  function calcExpectedMint(principal: bigint) {
    const amountUsd8Gross = (principal * PRICE_USD8) / 10n ** 18n;
    const amountUsd8Net = (amountUsd8Gross * (BPS_DENOM - BORROW_FEE_BPS)) / BPS_DENOM;
    const totalMinted = (amountUsd8Net * 10n * 10n ** 18n) / (1000n * PRICE_USD8);
    const borrowerShare = totalMinted / 2n;
    const lenderShare = totalMinted - borrowerShare;
    return { amountUsd8Net, totalMinted, borrowerShare, lenderShare };
  }

  async function buildMatchData(params: {
    vbl: any;
    borrower: any;
    lender: any;
    token: any;
    principal: bigint;
    rateBps: bigint;
    termDays: number;
  }) {
    const { vbl, borrower, lender, token, principal, rateBps, termDays } = params;
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
      collateralAsset: ethers.ZeroAddress,
      collateralAmount: 0n,
      borrowAsset: await token.getAddress(),
      amount: principal,
      termDays,
      rateBps,
      expireAt,
      salt: ethers.keccak256(ethers.toUtf8Bytes("borrow-intent-protocol-e2e")),
    };

    const lendIntent = {
      lenderSigner: lender.address,
      asset: await token.getAddress(),
      amount: principal,
      minTermDays: termDays,
      maxTermDays: termDays,
      minRateBps: rateBps,
      expireAt,
      salt: ethers.keccak256(ethers.toUtf8Bytes("lend-intent-protocol-e2e")),
    };

    const typedLendIntentTypes = { LendIntent: [...LEND_INTENT_TYPES.LendIntent] };
    const lendIntentHash = ethers.TypedDataEncoder.hashStruct("LendIntent", typedLendIntentTypes, lendIntent);
    const sigBorrower = await borrower.signTypedData(domain, BORROW_INTENT_TYPES, borrowIntent);
    const sigLender = await lender.signTypedData(domain, typedLendIntentTypes, lendIntent);

    return { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender };
  }

  async function deployFixture(options?: { enableGuarantee?: boolean; registerRewardView?: boolean }) {
    const { enableGuarantee = false, registerRewardView = true } = options ?? {};
    const [owner, lender, borrower] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory("MockRegistry")).deploy();
    await registry.waitForDeployment();

    const acm = await (await ethers.getContractFactory("MockAccessControlManager")).deploy();
    await acm.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, await acm.getAddress());

    const assetWhitelist = await (await ethers.getContractFactory("MockAssetWhitelist")).deploy();
    await assetWhitelist.waitForDeployment();

    const token = (await (await ethers.getContractFactory("MockERC20")).deploy(
      "Mock USDC",
      "USDC",
      18,
      ethers.parseUnits("1000000", 18)
    )) as MockERC20;
    await token.waitForDeployment();

    const collateralManager = await (await ethers.getContractFactory("MockCollateralManager")).deploy();
    await collateralManager.waitForDeployment();

    const lendingEngineLedger = await (await ethers.getContractFactory("MockLendingEngineBasic")).deploy();
    await lendingEngineLedger.waitForDeployment();

    const priceOracle = await (await ethers.getContractFactory("MockPriceOracle")).deploy();
    await priceOracle.waitForDeployment();

    const loanFlowView = await (await ethers.getContractFactory("MockLoanFlowView")).deploy();
    await loanFlowView.waitForDeployment();

    const vaultRouter = await (await ethers.getContractFactory("MockVaultRouter")).deploy();
    await vaultRouter.waitForDeployment();

    const vaultCore = await upgrades.deployProxy(await ethers.getContractFactory("VaultCore"), [registry.target, await vaultRouter.getAddress()], {
      kind: "uups",
      initializer: "initialize",
    });

    const settlementManager = await upgrades.deployProxy(
      await ethers.getContractFactory("SettlementManager"),
      [registry.target],
      { kind: "uups", initializer: "initialize" }
    );

    const lenderPoolVault = await upgrades.deployProxy(
      await ethers.getContractFactory("LenderPoolVault"),
      [registry.target],
      { kind: "uups", initializer: "initialize" }
    );

    const feeRouter = (await upgrades.deployProxy(
      await ethers.getContractFactory("FeeRouter"),
      [registry.target, owner.address, owner.address, Number(FEE_BPS), 0],
      { kind: "uups", initializer: "initialize" }
    )) as FeeRouter;

    const rewardManagerCore = await upgrades.deployProxy(
      await ethers.getContractFactory("RewardManagerCore"),
      [registry.target],
      { kind: "uups", initializer: "initialize" }
    );

    const rewardAccrualManager = await upgrades.deployProxy(
      await ethers.getContractFactory("RewardAccrualManager"),
      [registry.target],
      { kind: "uups", initializer: "initialize" }
    );

    const rewardManager = await upgrades.deployProxy(
      await ethers.getContractFactory("RewardManager"),
      [registry.target],
      { kind: "uups", initializer: "initialize" }
    );

    const easyEmissionController = await upgrades.deployProxy(
      await ethers.getContractFactory("EasyEmissionController"),
      [registry.target],
      { kind: "uups", initializer: "initialize" }
    );

    const easyEmissionConfig = await upgrades.deployProxy(
      await ethers.getContractFactory("EasyEmissionConfig"),
      [registry.target],
      { kind: "uups", initializer: "initialize" }
    );

    const easyToken = (await upgrades.deployProxy(
      await ethers.getContractFactory("EasyToken"),
      [owner.address],
      { kind: "uups", initializer: "initialize" }
    )) as EasyToken;

    const rewardView = (await upgrades.deployProxy(await ethers.getContractFactory("RewardView"), [registry.target], {
      kind: "uups",
      initializer: "initialize",
    })) as RewardView;

    let guaranteeFundManager: any = null;
    let earlyRepaymentGuaranteeManager: any = null;
    if (enableGuarantee) {
      guaranteeFundManager = await upgrades.deployProxy(
        await ethers.getContractFactory("GuaranteeFundManager"),
        [await vaultCore.getAddress(), registry.target, owner.address],
        { kind: "uups", initializer: "initialize" }
      );

      earlyRepaymentGuaranteeManager = await upgrades.deployProxy(
        await ethers.getContractFactory("EarlyRepaymentGuaranteeManager"),
        [registry.target, owner.address, Number(FEE_BPS)],
        { kind: "uups", initializer: "initialize" }
      );
    }

    const orderEngine = (await upgrades.deployProxy(
      await ethers.getContractFactory(LendingEngineFQN),
      [registry.target],
      { kind: "uups", initializer: "initialize" }
    )) as LendingEngine;

    const loanNFT = await upgrades.deployProxy(
      await ethers.getContractFactory("LoanNFT"),
      ["Loan NFT", "LOAN", "https://example.invalid/token/", registry.target],
      { kind: "uups", initializer: "initialize" }
    );

    const vbl = (await upgrades.deployProxy(await ethers.getContractFactory("VaultBusinessLogic"), [registry.target, token.target], {
      kind: "uups",
      initializer: "initialize",
    })) as VaultBusinessLogic;

    await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(ModuleKeys.KEY_ASSET_WHITELIST, await assetWhitelist.getAddress());
    await registry.setModule(ModuleKeys.KEY_CM, await collateralManager.getAddress());
    await registry.setModule(ModuleKeys.KEY_LE, await lendingEngineLedger.getAddress());
    await registry.setModule(ModuleKeys.KEY_ORDER_ENGINE, await orderEngine.getAddress());
    await registry.setModule(ModuleKeys.KEY_VAULT_CORE, await vaultCore.getAddress());
    await registry.setModule(ModuleKeys.KEY_SETTLEMENT_MANAGER, await settlementManager.getAddress());
    await registry.setModule(ModuleKeys.KEY_LENDER_POOL_VAULT, await lenderPoolVault.getAddress());
    await registry.setModule(ModuleKeys.KEY_VAULT_BUSINESS_LOGIC, await vbl.getAddress());
    await registry.setModule(ModuleKeys.KEY_FR, await feeRouter.getAddress());
    await registry.setModule(ModuleKeys.KEY_RM, await rewardManager.getAddress());
    await registry.setModule(ModuleKeys.KEY_REWARD_MANAGER_CORE, await rewardManagerCore.getAddress());
    await registry.setModule(ModuleKeys.KEY_REWARD_ACCRUAL_MANAGER, await rewardAccrualManager.getAddress());
    await registry.setModule(ModuleKeys.KEY_EASY_EMISSION_CONTROLLER, await easyEmissionController.getAddress());
    await registry.setModule(ModuleKeys.KEY_EASY_EMISSION_CONFIG, await easyEmissionConfig.getAddress());
    await registry.setModule(ModuleKeys.KEY_EASY_TOKEN, await easyToken.getAddress());
    if (registerRewardView) {
      await registry.setModule(ModuleKeys.KEY_REWARD_VIEW, await rewardView.getAddress());
    }
    await registry.setModule(ModuleKeys.KEY_LOAN_FLOW_VIEW, await loanFlowView.getAddress());
    await registry.setModule(ModuleKeys.KEY_PRICE_ORACLE, await priceOracle.getAddress());
    await registry.setModule(ModuleKeys.KEY_LOAN_NFT, await loanNFT.getAddress());
    if (enableGuarantee) {
      await registry.setModule(ModuleKeys.KEY_GUARANTEE_FUND, await guaranteeFundManager.getAddress());
      await registry.setModule(
        ModuleKeys.KEY_EARLY_REPAYMENT_GUARANTEE,
        await earlyRepaymentGuaranteeManager.getAddress()
      );
    }

    await acm.grantRole(ACTION_SET_PARAMETER, owner.address);
    await acm.grantRole(ACTION_ORDER_CREATE, await vbl.getAddress());
    await acm.grantRole(ACTION_DEPOSIT, await vbl.getAddress());
    await acm.grantRole(ACTION_REPAY, borrower.address);
    await acm.grantRole(ACTION_REPAY, await settlementManager.getAddress());
    await acm.grantRole(ACTION_VIEW_USER_DATA, owner.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, owner.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, await settlementManager.getAddress());
    await acm.grantRole(ACTION_BORROW, await orderEngine.getAddress());

    await feeRouter.connect(owner).addSupportedToken(token.target);
    await assetWhitelist.setAssetAllowed(token.target, true);
    if (enableGuarantee) {
      await acm.grantRole(ACTION_DEPOSIT, await guaranteeFundManager.getAddress());
      await earlyRepaymentGuaranteeManager.connect(owner).setGuaranteeEnabled(token.target, true);
    }

    await easyToken.connect(owner).setSoleMinter(await easyEmissionController.getAddress());
    await easyToken.connect(owner).grantRole(await easyToken.BURNER_ROLE(), await rewardAccrualManager.getAddress());

    const currentBlock = await ethers.provider.getBlockNumber();
    await priceOracle.setPrice(token.target, PRICE_USD8, currentBlock, 18);
    await loanFlowView.setGlobalLoanFlow(0n, 0n, 0n, 0n, true, BigInt(currentBlock));

    await token.transfer(lender.address, ethers.parseUnits("10000", 18));
    await token.connect(lender).approve(await vbl.getAddress(), ethers.parseUnits("100000", 18));

    return {
      owner,
      lender,
      borrower,
      registry,
      acm,
      assetWhitelist,
      collateralManager,
      lendingEngineLedger,
      token,
      priceOracle,
      loanFlowView,
      vaultCore,
      settlementManager,
      lenderPoolVault,
      feeRouter,
      rewardManager,
      rewardAccrualManager,
      easyEmissionController,
      easyToken,
      rewardView,
      guaranteeFundManager,
      earlyRepaymentGuaranteeManager,
      orderEngine,
      loanNFT,
      vbl,
    };
  }

  async function deployGuaranteeFixture() {
    return deployFixture({ enableGuarantee: true });
  }

  async function deployNoRewardViewFixture() {
    return deployFixture({ registerRewardView: false });
  }

  async function finalizeMatchAndGetOrder(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    principal: bigint,
    expectedBorrowerDelta?: bigint
  ) {
    const { owner, lender, borrower, token, vbl, lenderPoolVault, feeRouter, orderEngine, lendingEngineLedger } = fixture;
    const { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender } = await buildMatchData({
      vbl,
      borrower,
      lender,
      token,
      principal,
      rateBps: RATE_BPS,
      termDays: TERM_DAYS,
    });

    await vbl.connect(lender).reserveForLending(lender.address, token.target, principal, lendIntentHash);

    const borrowerBalBefore = await token.balanceOf(borrower.address);
    const poolBalBefore = await token.balanceOf(await lenderPoolVault.getAddress());
    const ownerBalBefore = await token.balanceOf(owner.address);

    const tx = await vbl.connect(borrower).finalizeMatch(borrowIntent, [lendIntent], sigBorrower, [sigLender]);
    const receipt = await tx.wait();

    const expectedFee = (principal * FEE_BPS) / BPS_DENOM;
    const expectedNet = principal - expectedFee;

    expect((await token.balanceOf(borrower.address)) - borrowerBalBefore).to.equal(
      expectedBorrowerDelta ?? expectedNet
    );
    expect(await token.balanceOf(await lenderPoolVault.getAddress())).to.equal(poolBalBefore - principal);
    expect((await token.balanceOf(owner.address)) - ownerBalBefore).to.equal(expectedFee);

    const orderId = 0n;
    const order = await orderEngine.connect(owner).getLoanOrderForView(orderId);
    expect(order.borrower).to.equal(borrower.address);
    expect(order.lender).to.equal(await lenderPoolVault.getAddress());
    expect(order.principal).to.equal(principal);
    expect(order.asset).to.equal(token.target);
    expect(await lendingEngineLedger.getDebt(borrower.address, token.target)).to.equal(principal);

    const dataTypes = getDataPushEntries(receipt).map((entry) => entry.dataTypeHash);
    expect(dataTypes).to.include(DATA_TYPE_RESERVE_CONSUMED.toLowerCase());
    expect(dataTypes).to.include(DATA_TYPE_FEE_DISTRIBUTED.toLowerCase());
    expect(dataTypes).to.include(DATA_TYPE_LOAN_CREATED.toLowerCase());

    return { tx, receipt, orderId, order, expectedNet, expectedFee };
  }

  async function topUpAndRepay(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    orderId: bigint,
    totalDue: bigint
  ) {
    const { borrower, orderEngine, token } = fixture;
    const borrowerBal = await token.balanceOf(borrower.address);
    if (borrowerBal < totalDue) {
      await token.mint(borrower.address, totalDue - borrowerBal);
    }
    await token.connect(borrower).approve(await orderEngine.getAddress(), totalDue);
    return orderEngine.connect(borrower).repay(orderId, totalDue);
  }

  async function topUpAndRepayViaVaultCore(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    orderId: bigint,
    asset: string,
    totalDue: bigint
  ) {
    const { borrower, token, vaultCore } = fixture;
    const borrowerBal = await token.balanceOf(borrower.address);
    if (borrowerBal < totalDue) {
      await token.mint(borrower.address, totalDue - borrowerBal);
    }
    await token.connect(borrower).approve(await vaultCore.getAddress(), totalDue);
    return vaultCore.connect(borrower).repay(orderId, asset, totalDue);
  }

  it("reserve -> finalizeMatch -> on-time repay keeps RewardView/DataPush/frontend schema consistent", async function () {
    const fixture = await loadFixture(deployFixture);
    const { owner, borrower, lenderPoolVault, rewardView, easyToken } = fixture;
    const principal = ethers.parseEther("1100");
    const { orderId, order } = await finalizeMatchAndGetOrder(fixture, principal);

    const totalDue = principal + calcInterest(principal, RATE_BPS, BigInt(order.term));
    const { amountUsd8Net, totalMinted, borrowerShare, lenderShare } = calcExpectedMint(principal);

    const currentBlock = BigInt(await ethers.provider.getBlockNumber());
    const targetBlock = BigInt(order.maturity) - ON_TIME_WINDOW_BLOCKS;
    if (targetBlock > currentBlock) {
      await mine(Number(targetBlock - currentBlock));
    }

    const repayTx = await topUpAndRepay(fixture, orderId, totalDue);
    const repayReceipt = await repayTx.wait();

    expect(await easyToken.balanceOf(borrower.address)).to.equal(borrowerShare);
    expect(await easyToken.balanceOf(await lenderPoolVault.getAddress())).to.equal(lenderShare);

    const [borrowerBalance] = await rewardView.connect(borrower).getUserBalanceWithMeta(borrower.address);
    const [borrowerEasyEarned] = await rewardView.connect(borrower).getUserEasyEarnedWithMeta(borrower.address);
    const [lenderEasyEarned] = await rewardView.connect(owner).getUserEasyEarnedWithMeta(await lenderPoolVault.getAddress());
    const [, borrowerPenalty] = await rewardView.connect(borrower).getUserRewardSummaryWithMeta(borrower.address);

    expect(borrowerBalance).to.equal(borrowerShare);
    expect(borrowerEasyEarned).to.equal(borrowerShare);
    expect(lenderEasyEarned).to.equal(lenderShare);
    expect(borrowerPenalty).to.equal(0n);

    const rewardPushes = getDataPushEntries(repayReceipt, (await rewardView.getAddress()).toString());
    const easyMintPush = rewardPushes.find((entry) => entry.dataTypeHash === DATA_TYPE_EASY_MINTED.toLowerCase());
    expect(easyMintPush).to.not.equal(undefined);

    const [payloadBorrower, payloadLender, payloadTotalMinted, payloadBorrowerShare, payloadLenderShare, payloadOrderId, payloadAmountUsd8] =
      ABI.decode(
        ["address", "address", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"],
        easyMintPush!.payload
      );

    expect(payloadBorrower).to.equal(borrower.address);
    expect(payloadLender).to.equal(await lenderPoolVault.getAddress());
    expect(payloadTotalMinted).to.equal(totalMinted);
    expect(payloadBorrowerShare).to.equal(borrowerShare);
    expect(payloadLenderShare).to.equal(lenderShare);
    expect(payloadOrderId).to.equal(orderId);
    expect(payloadAmountUsd8).to.equal(amountUsd8Net);
  });

  it("late repay keeps frontend-visible final state consistent: EASY_MINTED net of penalty and last penalty-ledger push is zero", async function () {
    const fixture = await loadFixture(deployFixture);
    const { owner, borrower, lenderPoolVault, rewardView, easyToken, rewardAccrualManager } = fixture;
    const principal = ethers.parseEther("1100");
    const { orderId, order } = await finalizeMatchAndGetOrder(fixture, principal);

    const totalDue = principal + calcInterest(principal, RATE_BPS, BigInt(order.term));
    const { amountUsd8Net, borrowerShare, lenderShare } = calcExpectedMint(principal);

    const currentBlock = BigInt(await ethers.provider.getBlockNumber());
    const targetBlock = BigInt(order.maturity) + ON_TIME_WINDOW_BLOCKS + 1n;
    if (targetBlock > currentBlock) {
      await mine(Number(targetBlock - currentBlock));
    }

    const repayTx = await topUpAndRepay(fixture, orderId, totalDue);
    const repayReceipt = await repayTx.wait();

    const expectedBorrowerNet = borrowerShare - LATE_PENALTY_EASY;
    const expectedTotalMinted = expectedBorrowerNet + lenderShare;

    expect(await easyToken.balanceOf(borrower.address)).to.equal(expectedBorrowerNet);
    expect(await easyToken.balanceOf(await lenderPoolVault.getAddress())).to.equal(lenderShare);
    expect(await rewardAccrualManager.getPenaltyDebt(borrower.address)).to.equal(0n);

    const [borrowerBalance] = await rewardView.connect(borrower).getUserBalanceWithMeta(borrower.address);
    const [borrowerEasyEarned] = await rewardView.connect(borrower).getUserEasyEarnedWithMeta(borrower.address);
    const [lenderEasyEarned] = await rewardView.connect(owner).getUserEasyEarnedWithMeta(await lenderPoolVault.getAddress());
    const [, borrowerPenalty] = await rewardView.connect(borrower).getUserRewardSummaryWithMeta(borrower.address);

    expect(borrowerBalance).to.equal(expectedBorrowerNet);
    expect(borrowerEasyEarned).to.equal(expectedBorrowerNet);
    expect(lenderEasyEarned).to.equal(lenderShare);
    expect(borrowerPenalty).to.equal(0n);

    const rewardPushes = getDataPushEntries(repayReceipt, (await rewardView.getAddress()).toString());
    const easyMintPush = rewardPushes.find((entry) => entry.dataTypeHash === DATA_TYPE_EASY_MINTED.toLowerCase());
    expect(easyMintPush).to.not.equal(undefined);

    const [, , payloadTotalMinted, payloadBorrowerShare, payloadLenderShare, payloadOrderId, payloadAmountUsd8] = ABI.decode(
      ["address", "address", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"],
      easyMintPush!.payload
    );

    expect(payloadTotalMinted).to.equal(expectedTotalMinted);
    expect(payloadBorrowerShare).to.equal(expectedBorrowerNet);
    expect(payloadLenderShare).to.equal(lenderShare);
    expect(payloadOrderId).to.equal(orderId);
    expect(payloadAmountUsd8).to.equal(amountUsd8Net);

    const penaltyPushes = rewardPushes.filter(
      (entry) => entry.dataTypeHash === DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED.toLowerCase()
    );
    expect(penaltyPushes.length).to.be.greaterThan(0);

    const lastPenaltyPush = penaltyPushes[penaltyPushes.length - 1];
    const [, pendingDebt] = ABI.decode(["address", "uint256", "uint256"], lastPenaltyPush.payload);
    expect(pendingDebt).to.equal(0n);
  });

  it("reserve -> finalizeMatch -> early repay via SettlementManager keeps guarantee custody, reward mint, and frontend pushes consistent", async function () {
    const fixture = await loadFixture(deployGuaranteeFixture);
    const {
      borrower,
      owner,
      token,
      lenderPoolVault,
      feeRouter,
      rewardView,
      easyToken,
      guaranteeFundManager,
      earlyRepaymentGuaranteeManager,
    } = fixture;
    const principal = ethers.parseEther("1100");
    const expectedGuarantee = calcExpectedGuaranteeInterest(principal, RATE_BPS, BigInt(TERM_DAYS));

    await token.connect(borrower).approve(await guaranteeFundManager.getAddress(), expectedGuarantee);

    const { orderId, order } = await finalizeMatchAndGetOrder(
      fixture,
      principal,
      principal - (principal * FEE_BPS) / BPS_DENOM - expectedGuarantee
    );
    expect(await guaranteeFundManager.getLockedGuarantee(borrower.address, token.target)).to.equal(expectedGuarantee);
    expect(await earlyRepaymentGuaranteeManager.hasActiveGuarantee(borrower.address, token.target)).to.equal(true);

    const guaranteeId = await earlyRepaymentGuaranteeManager.getUserGuaranteeId(borrower.address, token.target);
    const guaranteeRecord = await earlyRepaymentGuaranteeManager.getGuaranteeRecord(guaranteeId);
    const feeRate = await earlyRepaymentGuaranteeManager.platformFeeRate();
    const totalDue = principal + calcInterest(principal, RATE_BPS, BigInt(order.term));
    const { amountUsd8Net, totalMinted, borrowerShare, lenderShare } = calcExpectedMint(principal);

    const borrowerBalBefore = await token.balanceOf(borrower.address);
    const guaranteeBalBefore = await token.balanceOf(await guaranteeFundManager.getAddress());
    expect(guaranteeBalBefore).to.equal(expectedGuarantee);

    if (borrowerBalBefore < totalDue) {
      await token.mint(borrower.address, totalDue - borrowerBalBefore);
    }
    const borrowerBalBeforeRepay = await token.balanceOf(borrower.address);
    await token.connect(borrower).approve(await fixture.vaultCore.getAddress(), totalDue);

    const repayTx = await fixture.vaultCore.connect(borrower).repay(orderId, token.target, totalDue);
    const repayReceipt = await repayTx.wait();
    const settleBlock = BigInt(repayReceipt!.blockNumber);
    const expectedSplit = calcExpectedEarlyRepaymentSplit(
      {
        promisedInterest: guaranteeRecord.promisedInterest,
        startTime: guaranteeRecord.startTime,
        maturityTime: guaranteeRecord.maturityTime,
        earlyRepayPenaltyDays: guaranteeRecord.earlyRepayPenaltyDays,
      },
      feeRate,
      settleBlock
    );

    expect(await guaranteeFundManager.getLockedGuarantee(borrower.address, token.target)).to.equal(0n);
    expect(await token.balanceOf(await guaranteeFundManager.getAddress())).to.equal(0n);
    expect(await earlyRepaymentGuaranteeManager.hasActiveGuarantee(borrower.address, token.target)).to.equal(false);
    expect(await token.balanceOf(borrower.address)).to.equal(
      borrowerBalBeforeRepay - totalDue + expectedSplit.refundToBorrower
    );

    expect(await easyToken.balanceOf(borrower.address)).to.equal(borrowerShare);
    expect(await easyToken.balanceOf(await lenderPoolVault.getAddress())).to.equal(lenderShare);

    const [borrowerEasyEarned] = await rewardView.connect(borrower).getUserEasyEarnedWithMeta(borrower.address);
    const [lenderEasyEarned] = await rewardView.connect(owner).getUserEasyEarnedWithMeta(await lenderPoolVault.getAddress());
    const [, borrowerPenalty] = await rewardView.connect(borrower).getUserRewardSummaryWithMeta(borrower.address);

    expect(borrowerEasyEarned).to.equal(borrowerShare);
    expect(lenderEasyEarned).to.equal(lenderShare);
    expect(borrowerPenalty).to.equal(0n);

    const guaranteePushes = getDataPushEntries(repayReceipt, (await guaranteeFundManager.getAddress()).toString());
    const releasePush = guaranteePushes.find((entry) => entry.dataTypeHash === DATA_TYPE_GUARANTEE_RELEASED.toLowerCase());
    expect(releasePush).to.not.equal(undefined);

    const forfeitedPushes = guaranteePushes.filter(
      (entry) => entry.dataTypeHash === DATA_TYPE_GUARANTEE_FORFEITED.toLowerCase()
    );
    expect(forfeitedPushes.length).to.equal(2);

    const [, releaseAsset, releaseAmount] = ABI.decode(["address", "address", "uint256", "uint256"], releasePush!.payload);
    expect(releaseAsset).to.equal(token.target);
    expect(releaseAmount).to.equal(expectedSplit.refundToBorrower);

    const forfeitedDecoded = forfeitedPushes.map((entry) =>
      ABI.decode(["address", "address", "uint256", "address", "uint256"], entry.payload)
    );
    const forfeitedAmounts = forfeitedDecoded.map((decoded) => BigInt(decoded[2])).sort((a, b) => (a < b ? -1 : 1));
    const expectedForfeitedAmounts = [expectedSplit.penaltyToLender, expectedSplit.platformFee].sort((a, b) =>
      a < b ? -1 : 1
    );
    expect(forfeitedAmounts).to.deep.equal(expectedForfeitedAmounts);
    expect(forfeitedDecoded.map((decoded) => decoded[3].toLowerCase())).to.have.members([
      (await lenderPoolVault.getAddress()).toLowerCase(),
      (await feeRouter.getAddress()).toLowerCase(),
    ]);

    const rewardPushes = getDataPushEntries(repayReceipt, (await rewardView.getAddress()).toString());
    const easyMintPush = rewardPushes.find((entry) => entry.dataTypeHash === DATA_TYPE_EASY_MINTED.toLowerCase());
    expect(easyMintPush).to.not.equal(undefined);

    const [, payloadLender, payloadTotalMinted, payloadBorrowerShare, payloadLenderShare, payloadOrderId, payloadAmountUsd8] =
      ABI.decode(["address", "address", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"], easyMintPush!.payload);

    expect(payloadLender).to.equal(await lenderPoolVault.getAddress());
    expect(payloadTotalMinted).to.equal(totalMinted);
    expect(payloadBorrowerShare).to.equal(borrowerShare);
    expect(payloadLenderShare).to.equal(lenderShare);
    expect(payloadOrderId).to.equal(orderId);
    expect(payloadAmountUsd8).to.equal(amountUsd8Net);
  });

  it("late repay still mints and clears penalty debt when RewardView is unavailable; observability degrades via RewardViewPushFailed", async function () {
    const fixture = await loadFixture(deployNoRewardViewFixture);
    const { borrower, lenderPoolVault, registry, easyEmissionController, rewardAccrualManager, easyToken } = fixture;
    const principal = ethers.parseEther("1100");
    const { orderId, order } = await finalizeMatchAndGetOrder(fixture, principal);

    const totalDue = principal + calcInterest(principal, RATE_BPS, BigInt(order.term));
    const { amountUsd8Net, borrowerShare, lenderShare } = calcExpectedMint(principal);

    expect(await registry.getModule(ModuleKeys.KEY_REWARD_VIEW)).to.equal(ethers.ZeroAddress);

    const currentBlock = BigInt(await ethers.provider.getBlockNumber());
    const targetBlock = BigInt(order.maturity) + ON_TIME_WINDOW_BLOCKS + 1n;
    if (targetBlock > currentBlock) {
      await mine(Number(targetBlock - currentBlock));
    }

    const repayTx = await topUpAndRepay(fixture, orderId, totalDue);
    const repayReceipt = await repayTx.wait();

    const expectedBorrowerNet = borrowerShare - LATE_PENALTY_EASY;
    const expectedTotalMinted = expectedBorrowerNet + lenderShare;

    expect(await easyToken.balanceOf(borrower.address)).to.equal(expectedBorrowerNet);
    expect(await easyToken.balanceOf(await lenderPoolVault.getAddress())).to.equal(lenderShare);
    expect(await rewardAccrualManager.getPenaltyDebt(borrower.address)).to.equal(0n);

    const emissionPushFailures = getRewardViewPushFailedEntries(
      repayReceipt,
      (await easyEmissionController.getAddress()).toString()
    );
    const easyMintFailure = emissionPushFailures.find((entry) => entry.op === DATA_TYPE_EASY_MINTED.toLowerCase());
    expect(easyMintFailure).to.not.equal(undefined);
    expect(easyMintFailure!.rewardView).to.equal(ethers.ZeroAddress);
    expect(easyMintFailure!.reason).to.equal(REWARD_VIEW_UNAVAILABLE_HEX.toLowerCase());

    const [payloadBorrower, payloadLender, payloadTotalMinted, payloadBorrowerShare, payloadLenderShare, payloadOrderId, payloadAmountUsd8] =
      ABI.decode(["address", "address", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"], easyMintFailure!.payload);

    expect(payloadBorrower).to.equal(borrower.address);
    expect(payloadLender).to.equal(await lenderPoolVault.getAddress());
    expect(payloadTotalMinted).to.equal(expectedTotalMinted);
    expect(payloadBorrowerShare).to.equal(expectedBorrowerNet);
    expect(payloadLenderShare).to.equal(lenderShare);
    expect(payloadOrderId).to.equal(orderId);
    expect(payloadAmountUsd8).to.equal(amountUsd8Net);

    const penaltyPushFailures = getRewardViewPushFailedEntries(
      repayReceipt,
      (await rewardAccrualManager.getAddress()).toString()
    ).filter((entry) => entry.op === DATA_TYPE_PENALTY_LEDGER_OP.toLowerCase());
    expect(penaltyPushFailures.length).to.be.greaterThan(0);
    expect(penaltyPushFailures[penaltyPushFailures.length - 1].rewardView).to.equal(ethers.ZeroAddress);
  });
});