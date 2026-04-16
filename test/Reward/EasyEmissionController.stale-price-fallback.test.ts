import { expect } from "chai";
import { loadFixture, mine } from "@nomicfoundation/hardhat-network-helpers";
import hardhat from "hardhat";

const { ethers, upgrades } = hardhat;

const KEY = {
  ACM: () => ethers.keccak256(ethers.toUtf8Bytes("ACCESS_CONTROL_MANAGER")),
  RM: () => ethers.keccak256(ethers.toUtf8Bytes("REWARD_MANAGER")),
  EASY_TOKEN: () => ethers.keccak256(ethers.toUtf8Bytes("EASY_TOKEN")),
  EASY_EMISSION_CONFIG: () => ethers.keccak256(ethers.toUtf8Bytes("EASY_EMISSION_CONFIG")),
  EASY_EMISSION_CONTROLLER: () => ethers.keccak256(ethers.toUtf8Bytes("EASY_EMISSION_CONTROLLER")),
  LOAN_FLOW_VIEW: () => ethers.keccak256(ethers.toUtf8Bytes("LOAN_FLOW_VIEW")),
  PRICE_ORACLE: () => ethers.keccak256(ethers.toUtf8Bytes("PRICE_ORACLE")),
} as const;

const ACTION_UPDATE_PRICE = ethers.keccak256(ethers.toUtf8Bytes("UPDATE_PRICE"));

describe("EasyEmissionController stale price fallback", function () {
  async function deployFixture() {
    const [admin, borrower, lender] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("MockRegistry");
    const registry = await Registry.deploy();

    const ACM = await ethers.getContractFactory("AccessControlManager");
    const acm = await ACM.deploy(admin.address);
    await registry.setModule(KEY.ACM(), await acm.getAddress());
    await acm.grantRole(ACTION_UPDATE_PRICE, admin.address);

    const EasyToken = await ethers.getContractFactory("EasyToken");
    const easyToken = await upgrades.deployProxy(EasyToken, [admin.address], { kind: "uups" });

    const EasyEmissionConfig = await ethers.getContractFactory("EasyEmissionConfig");
    const easyEmissionConfig = await upgrades.deployProxy(EasyEmissionConfig, [await registry.getAddress()], {
      kind: "uups",
    });

    const PriceOracle = await ethers.getContractFactory("PriceOracle");
    const priceOracle = await upgrades.deployProxy(PriceOracle, [await registry.getAddress()], {
      kind: "uups",
    });

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

    const asset = ethers.Wallet.createRandom().address;
    await priceOracle.connect(admin).configureAsset(asset, "usd-coin", 6, 1);
    const updateBlock = BigInt(await ethers.provider.getBlockNumber());
    await priceOracle.connect(admin).updatePrice(asset, 10n ** 6n, updateBlock);
    await loanFlowView.setGlobalLoanFlow(0n, 0n, 0n, 0n, true, 1n);

    return {
      admin,
      borrower,
      lender,
      asset,
      easyToken,
      controller,
      easyEmissionConfig,
      priceOracle,
    };
  }

  it("mints using the latest stored oracle record when strict getPrice is stale", async function () {
    const { admin, borrower, lender, asset, easyToken, controller, easyEmissionConfig, priceOracle } = await loadFixture(deployFixture);

    await mine(2);
    await expect(priceOracle.getPrice(asset)).to.be.revertedWithCustomError(priceOracle, "PriceOracle__StalePrice");

    const amountBaseUnits = 1_004n * 10n ** 6n;
    await controller
      .connect(admin)
      .onLoanEventByOrderWithLender(borrower.address, lender.address, asset, 1n, amountBaseUnits, 0n, 1);

    const [, mintPer1000Usd] = await easyEmissionConfig.getEmissionParams();
    const amountValueGross = (amountBaseUnits * 10n ** 18n) / 10n ** 6n;
    const amountValueNet = (amountValueGross * (10_000n - 30n)) / 10_000n;
    const totalMinted = (amountValueNet * mintPer1000Usd) / (1_000n * 10n ** 18n);
    const borrowerShare = totalMinted / 2n;
    const lenderShare = totalMinted - borrowerShare;

    expect(await easyToken.balanceOf(borrower.address)).to.equal(borrowerShare);
    expect(await easyToken.balanceOf(lender.address)).to.equal(lenderShare);
  });
});