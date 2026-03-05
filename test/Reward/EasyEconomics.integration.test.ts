import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import hardhat from "hardhat";

const { ethers, upgrades } = hardhat;

const KEY = {
  ACM: () => ethers.keccak256(ethers.toUtf8Bytes("ACCESS_CONTROL_MANAGER")),
  RM: () => ethers.keccak256(ethers.toUtf8Bytes("REWARD_MANAGER")),
  EASY_TOKEN: () => ethers.keccak256(ethers.toUtf8Bytes("EASY_TOKEN")),
  EASY_EMISSION_CONFIG: () => ethers.keccak256(ethers.toUtf8Bytes("EASY_EMISSION_CONFIG")),
  EASY_EMISSION_CONTROLLER: () => ethers.keccak256(ethers.toUtf8Bytes("EASY_EMISSION_CONTROLLER")),
  EASY_CONSUMPTION: () => ethers.keccak256(ethers.toUtf8Bytes("EASY_CONSUMPTION")),
  EASY_RECYCLE_DISTRIBUTOR: () => ethers.keccak256(ethers.toUtf8Bytes("EASY_RECYCLE_DISTRIBUTOR")),
  LOAN_FLOW_VIEW: () => ethers.keccak256(ethers.toUtf8Bytes("LOAN_FLOW_VIEW")),
  PRICE_ORACLE: () => ethers.keccak256(ethers.toUtf8Bytes("PRICE_ORACLE")),
} as const;

const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes("SET_PARAMETER"));
const ACTION_CONSUME_EASY = ethers.keccak256(ethers.toUtf8Bytes("CONSUME_EASY"));

describe("Easy economics milestones (A-D)", function () {
  async function deployConfigFixture() {
    const [admin, user] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("MockRegistry");
    const registry = await Registry.deploy();

    const ACM = await ethers.getContractFactory("AccessControlManager");
    const acm = await ACM.deploy(admin.address);

    await registry.setModule(KEY.ACM(), await acm.getAddress());

    const EasyToken = await ethers.getContractFactory("EasyToken");
    const easyToken = await upgrades.deployProxy(EasyToken, [admin.address], { kind: "uups" });

    const EasyEmissionConfig = await ethers.getContractFactory("EasyEmissionConfig");
    const easyEmissionConfig = await upgrades.deployProxy(EasyEmissionConfig, [await registry.getAddress()], {
      kind: "uups",
    });

    return { admin, user, registry, acm, easyToken, easyEmissionConfig };
  }

  it("Milestone A: EasyToken mint/burn and EasyEmissionConfig params", async function () {
    const { admin, user, acm, easyToken, easyEmissionConfig } = await loadFixture(deployConfigFixture);

    if (!(await acm.hasRole(ACTION_SET_PARAMETER, admin.address))) {
      await acm.grantRole(ACTION_SET_PARAMETER, admin.address);
    }

    // EasyEmissionConfig defaults
    const [thr0, mintPer0, kNum0, kDen0] = await easyEmissionConfig.getEmissionParams();
    expect(thr0).to.equal(100_000_000n * 10n ** 8n);
    expect(mintPer0).to.equal(10n * 10n ** 18n);
    expect(kNum0).to.equal(1n);
    expect(kDen0).to.equal(10_000_000n);

    // Update params
    await easyEmissionConfig.connect(admin).setEmissionParams(123n, 456n, 7n, 9n);
    const [thr1, mintPer1, kNum1, kDen1] = await easyEmissionConfig.getEmissionParams();
    expect(thr1).to.equal(123n);
    expect(mintPer1).to.equal(456n);
    expect(kNum1).to.equal(7n);
    expect(kDen1).to.equal(9n);

    // EasyToken mint/burn via sole minter
    await easyToken.connect(admin).setSoleMinter(admin.address);
    await easyToken.connect(admin).mint(user.address, 10n * 10n ** 18n);
    expect(await easyToken.balanceOf(user.address)).to.equal(10n * 10n ** 18n);

    const BURNER_ROLE = await easyToken.BURNER_ROLE();
    if (!(await easyToken.hasRole(BURNER_ROLE, admin.address))) {
      await easyToken.connect(admin).grantRole(BURNER_ROLE, admin.address);
    }

    await easyToken.connect(admin).burn(user.address, 2n * 10n ** 18n);
    expect(await easyToken.balanceOf(user.address)).to.equal(8n * 10n ** 18n);
  });

  async function deployEmissionFixture() {
    const [admin, borrower, lender] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("MockRegistry");
    const registry = await Registry.deploy();

    const EasyToken = await ethers.getContractFactory("EasyToken");
    const easyToken = await upgrades.deployProxy(EasyToken, [admin.address], { kind: "uups" });

    const EasyEmissionConfig = await ethers.getContractFactory("EasyEmissionConfig");
    const easyEmissionConfig = await upgrades.deployProxy(EasyEmissionConfig, [await registry.getAddress()], {
      kind: "uups",
    });

    const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
    const priceOracle = await MockPriceOracle.deploy();

    const MockLoanFlowView = await ethers.getContractFactory("MockLoanFlowView");
    const loanFlowView = await MockLoanFlowView.deploy();

    const EasyEmissionController = await ethers.getContractFactory("EasyEmissionController");
    const controller = await upgrades.deployProxy(EasyEmissionController, [await registry.getAddress()], {
      kind: "uups",
    });

    await registry.setModule(KEY.RM(), admin.address);
    await registry.setModule(KEY.EASY_TOKEN(), await easyToken.getAddress());
    await registry.setModule(KEY.EASY_EMISSION_CONFIG(), await easyEmissionConfig.getAddress());
    await registry.setModule(KEY.PRICE_ORACLE(), await priceOracle.getAddress());
    await registry.setModule(KEY.LOAN_FLOW_VIEW(), await loanFlowView.getAddress());
    await registry.setModule(KEY.EASY_EMISSION_CONTROLLER(), await controller.getAddress());

    await easyToken.connect(admin).setSoleMinter(await controller.getAddress());

    return { admin, borrower, lender, easyToken, controller, priceOracle, loanFlowView, easyEmissionConfig };
  }

  it("Milestone B: Easy emission controller mints on-time repay and splits 50/50", async function () {
    const { admin, borrower, lender, easyToken, controller, priceOracle, loanFlowView, easyEmissionConfig } =
      await loadFixture(deployEmissionFixture);

    const asset = ethers.Wallet.createRandom().address;
    await priceOracle.setPrice(asset, 10n ** 8n, 1n, 6n); // $1, assetDecimals=6
    await loanFlowView.setGlobalLoanFlow(0n, 0n, 0n, 0n, true, 1n);

    // NOTE: mint is based on net amount after 0.06% fee, and net must be >= 1000U.
    // Use 1001 USDC so net amount is still >= 1000U.
    const amountBaseUnits = 1_001n * 10n ** 6n; // 1001 USDC
    await controller
      .connect(admin)
      .onLoanEventByOrderWithLender(borrower.address, lender.address, asset, 1n, amountBaseUnits, 0n, 1);

    const [, mintPer1000Usd] = await easyEmissionConfig.getEmissionParams();
    const amountUsd8Gross = (amountBaseUnits * 10n ** 8n) / 10n ** 6n; // $1, assetDecimals=6
    const amountUsd8Net = (amountUsd8Gross * (10_000n - 6n)) / 10_000n;
    const totalMinted = (amountUsd8Net * mintPer1000Usd) / (1_000n * 10n ** 8n);
    const borrowerShare = totalMinted / 2n;
    const lenderShare = totalMinted - borrowerShare;

    expect(await easyToken.balanceOf(borrower.address)).to.equal(borrowerShare);
    expect(await easyToken.balanceOf(lender.address)).to.equal(lenderShare);
  });

  it("Milestone B: Easy emission controller skips non-on-time outcomes", async function () {
    const { admin, borrower, lender, easyToken, controller, priceOracle, loanFlowView } =
      await loadFixture(deployEmissionFixture);

    const asset = ethers.Wallet.createRandom().address;
    await priceOracle.setPrice(asset, 10n ** 8n, 1n, 6n);
    await loanFlowView.setGlobalLoanFlow(0n, 0n, 0n, 0n, true, 1n);

    const amountBaseUnits = 1_000n * 10n ** 6n;
    await controller
      .connect(admin)
      .onLoanEventByOrderWithLender(borrower.address, lender.address, asset, 1n, amountBaseUnits, 0n, 0);

    expect(await easyToken.balanceOf(borrower.address)).to.equal(0n);
    expect(await easyToken.balanceOf(lender.address)).to.equal(0n);
  });

  it("Milestone B: deflation stage uses retained supply in mint formula", async function () {
    const { admin, borrower, lender, easyToken, controller, priceOracle, loanFlowView, easyEmissionConfig } =
      await loadFixture(deployEmissionFixture);

    const [thr, mintPer, kNum, kDen] = await easyEmissionConfig.getEmissionParams();
    const asset = ethers.Wallet.createRandom().address;
    await priceOracle.setPrice(asset, 10n ** 8n, 1n, 6n);
    await loanFlowView.setGlobalLoanFlow(thr + 1n, 0n, 0n, 0n, true, 1n);

    // Seed retained supply = 100 EASY
    await easyToken.connect(admin).setSoleMinter(admin.address);
    await easyToken.connect(admin).mint(admin.address, 100n * 10n ** 18n);
    await easyToken.connect(admin).setSoleMinter(await controller.getAddress());

    const amountBaseUnits = 1_001n * 10n ** 6n;
    await controller
      .connect(admin)
      .onLoanEventByOrderWithLender(borrower.address, lender.address, asset, 9n, amountBaseUnits, 0n, 1);

    const retainedEasy = 100n;
    const amountUsd8Gross = (amountBaseUnits * 10n ** 8n) / 10n ** 6n;
    const amountUsd8Net = (amountUsd8Gross * (10_000n - 6n)) / 10_000n;
    const base = (amountUsd8Net * 10n ** 10n) / 100n; // amountUsd8 * 1e18 / 1e8 / 100
    const expectedTotal = (base * kDen) / (kDen + kNum * retainedEasy);

    const borrowerBal = await easyToken.balanceOf(borrower.address);
    const lenderBal = await easyToken.balanceOf(lender.address);
    expect(borrowerBal + lenderBal).to.equal(expectedTotal);
  });

  async function deployConsumptionFixture() {
    const [admin, user, caller, team, eco] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("MockRegistry");
    const registry = await Registry.deploy();

    const ACM = await ethers.getContractFactory("AccessControlManager");
    const acm = await ACM.deploy(admin.address);

    const EasyToken = await ethers.getContractFactory("EasyToken");
    const easyToken = await upgrades.deployProxy(EasyToken, [admin.address], { kind: "uups" });

    const EasyConsumption = await ethers.getContractFactory("EasyConsumption");
    const easyConsumption = await upgrades.deployProxy(EasyConsumption, [await registry.getAddress()], {
      kind: "uups",
    });

    const EasyRecycleDistributor = await ethers.getContractFactory("EasyRecycleDistributor");
    const easyRecycle = await upgrades.deployProxy(
      EasyRecycleDistributor,
      [await registry.getAddress(), team.address, eco.address],
      { kind: "uups" }
    );

    await registry.setModule(KEY.ACM(), await acm.getAddress());
    await registry.setModule(KEY.EASY_TOKEN(), await easyToken.getAddress());
    await registry.setModule(KEY.EASY_CONSUMPTION(), await easyConsumption.getAddress());
    await registry.setModule(KEY.EASY_RECYCLE_DISTRIBUTOR(), await easyRecycle.getAddress());

    await easyToken.connect(admin).setSoleMinter(admin.address);
    await easyToken.connect(admin).mint(user.address, 5n * 10n ** 18n);

    // Recycle distributor must be able to burn the received EASY.
    const BURNER_ROLE = await easyToken.BURNER_ROLE();
    if (!(await easyToken.hasRole(BURNER_ROLE, await easyRecycle.getAddress()))) {
      await easyToken.connect(admin).grantRole(BURNER_ROLE, await easyRecycle.getAddress());
    }

    await easyToken.connect(user).approve(await easyConsumption.getAddress(), 10n ** 18n);

    return { admin, user, caller, team, eco, acm, easyToken, easyConsumption, easyRecycle };
  }

  it("Milestone C: EasyConsumption spends 1 EASY and splits 75/15/10", async function () {
    const { admin, user, team, eco, easyToken, easyConsumption } = await loadFixture(deployConsumptionFixture);

    const beforeSupply = await easyToken.totalSupply();
    await easyConsumption.connect(user).consumeEasiMCall(user.address);

    const burnAmount = 75n * 10n ** 16n; // 0.75
    const teamAmount = 15n * 10n ** 16n; // 0.15
    const ecoAmount = 10n * 10n ** 16n; // 0.10

    expect(await easyToken.balanceOf(user.address)).to.equal(4n * 10n ** 18n);
    expect(await easyToken.balanceOf(team.address)).to.equal(teamAmount);
    expect(await easyToken.balanceOf(eco.address)).to.equal(ecoAmount);
    expect(await easyToken.totalSupply()).to.equal(beforeSupply - burnAmount);
  });

  it("Milestone C: non-user caller must have ACTION_CONSUME_EASY", async function () {
    const { caller, user, acm, easyConsumption } = await loadFixture(deployConsumptionFixture);

    await expect(easyConsumption.connect(caller).consumeStrategyApiCall(user.address)).to.be.revertedWithCustomError(
      acm,
      "MissingRole"
    );

    await acm.grantRole(ACTION_CONSUME_EASY, caller.address);
    await easyConsumption.connect(caller).consumeStrategyApiCall(user.address);
  });

  async function deployStakingFixture() {
    const [admin, user] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("MockRegistry");
    const registry = await Registry.deploy();

    const EasyToken = await ethers.getContractFactory("EasyToken");
    const easyToken = await upgrades.deployProxy(EasyToken, [admin.address], { kind: "uups" });

    const EasyStaking = await ethers.getContractFactory("EasyStaking");
    const easyStaking = await upgrades.deployProxy(EasyStaking, [await registry.getAddress()], { kind: "uups" });

    await registry.setModule(KEY.EASY_TOKEN(), await easyToken.getAddress());

    await easyToken.connect(admin).setSoleMinter(admin.address);
    await easyToken.connect(admin).mint(user.address, 3n * 10n ** 18n);

    await easyToken.connect(user).approve(await easyStaking.getAddress(), 3n * 10n ** 18n);

    return { user, easyToken, easyStaking };
  }

  it("Milestone D: EasyStaking stake/unstake moves balances", async function () {
    const { user, easyToken, easyStaking } = await loadFixture(deployStakingFixture);

    await easyStaking.connect(user).stake(2n * 10n ** 18n);
    expect(await easyStaking.balanceOf(user.address)).to.equal(2n * 10n ** 18n);
    expect(await easyToken.balanceOf(user.address)).to.equal(1n * 10n ** 18n);

    await easyStaking.connect(user).unstake(1n * 10n ** 18n);
    expect(await easyStaking.balanceOf(user.address)).to.equal(1n * 10n ** 18n);
    expect(await easyToken.balanceOf(user.address)).to.equal(2n * 10n ** 18n);
  });
});
