import { expect } from "chai";
import hardhat from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

const { ethers, upgrades } = hardhat;

describe("LoanFlowPushManager (strict B+) – normalized 18-decimal flow deltas", function () {
  const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes("ACCESS_CONTROL_MANAGER"));
  const KEY_LOAN_FLOW_VIEW = ethers.keccak256(ethers.toUtf8Bytes("LOAN_FLOW_VIEW"));
  const KEY_LOAN_FLOW_PUSH_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("LOAN_FLOW_PUSH_MANAGER"));
  const KEY_PRICE_ORACLE = ethers.keccak256(ethers.toUtf8Bytes("PRICE_ORACLE"));
  const KEY_ORDER_ENGINE = ethers.keccak256(ethers.toUtf8Bytes("ORDER_ENGINE"));

  const ROLE_VIEW_PUSH = ethers.keccak256(ethers.toUtf8Bytes("ACTION_VIEW_PUSH"));
  const ROLE_ADMIN = ethers.keccak256(ethers.toUtf8Bytes("ACTION_ADMIN"));

  async function deployFixture() {
    const [admin, outsider] = await ethers.getSigners();

    const RegistryF = await ethers.getContractFactory("MockRegistry");
    const registry = await RegistryF.deploy();
    await registry.waitForDeployment();

    const ACMF = await ethers.getContractFactory("MockAccessControlManager");
    const acm = await ACMF.deploy();
    await acm.waitForDeployment();
    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());

    const ViewF = await ethers.getContractFactory("LoanFlowView");
    const view = await upgrades.deployProxy(ViewF, [await registry.getAddress()]);
    await view.waitForDeployment();

    const PushMgrF = await ethers.getContractFactory("LoanFlowPushManager");
    const pushMgr = await upgrades.deployProxy(PushMgrF, [await registry.getAddress()]);
    await pushMgr.waitForDeployment();

    const OracleF = await ethers.getContractFactory("MockPriceOracle");
    const oracle = await OracleF.deploy();
    await oracle.waitForDeployment();

    const OECallerF = await ethers.getContractFactory("MockOrderEngineCaller");
    const orderEngine = await OECallerF.deploy();
    await orderEngine.waitForDeployment();

    await registry.setModule(KEY_LOAN_FLOW_VIEW, await view.getAddress());
    await registry.setModule(KEY_LOAN_FLOW_PUSH_MANAGER, await pushMgr.getAddress());
    await registry.setModule(KEY_PRICE_ORACLE, await oracle.getAddress());
    await registry.setModule(KEY_ORDER_ENGINE, await orderEngine.getAddress());

    // Allow admin to call retry* APIs and to read Scheme-U/Scheme-O views.
    await acm.grantRole(ROLE_VIEW_PUSH, await admin.getAddress());
    await acm.grantRole(ROLE_ADMIN, await admin.getAddress());

    return { admin, outsider, registry, acm, view, pushMgr, oracle, orderEngine };
  }

  it("retryBorrow normalizes token amount into the shared 18-decimal value unit and updates user + global totals", async function () {
    const { admin, view, pushMgr, oracle } = await loadFixture(deployFixture);

    const user = ethers.Wallet.createRandom().address;
    const asset = ethers.Wallet.createRandom().address;

    // price = $2.00 in 18-decimal asset-native precision
    await oracle.setPrice(asset, 2n * 10n ** 18n, 123n, 18);

    const principal = 10n * 10n ** 18n;
    const orderId = 7n;

    const DATA_TYPE_LOAN_FLOW_UPDATED = ethers.keccak256(ethers.toUtf8Bytes("LOAN_FLOW_UPDATED"));

    const tx = await pushMgr.connect(admin).retryBorrow(user, asset, principal, orderId);
    await expect(tx).to.emit(view, "DataPushed").withArgs(DATA_TYPE_LOAN_FLOW_UPDATED, anyValue);

    const [uBorrowValue, uRepayValue, uBorrowCount, uRepayCount] = await view.getUserLoanFlowWithMeta(user);
    expect(uBorrowValue).to.equal(20n * 10n ** 18n);
    expect(uRepayValue).to.equal(0n);
    expect(uBorrowCount).to.equal(1n);
    expect(uRepayCount).to.equal(0n);

    const [gBorrowValue, gRepayValue, gBorrowCount, gRepayCount] = await view.getGlobalLoanFlowWithMeta();
    expect(gBorrowValue).to.equal(20n * 10n ** 18n);
    expect(gRepayValue).to.equal(0n);
    expect(gBorrowCount).to.equal(1n);
    expect(gRepayCount).to.equal(0n);
  });

  it("getGlobalLoanFlowWithMeta is publicly readable", async function () {
    const { outsider, view } = await loadFixture(deployFixture);
    await expect(view.connect(outsider).getGlobalLoanFlowWithMeta()).to.not.be.reverted;
  });

  it("retryRepay preserves count even when normalized valuation rounds down to 0", async function () {
    const { admin, view, pushMgr, oracle } = await loadFixture(deployFixture);

    const user = ethers.Wallet.createRandom().address;
    const asset = ethers.Wallet.createRandom().address;

    // Extremely small asset-native price; 1 wei still normalizes to 0 at 18 decimals.
    await oracle.setPrice(asset, 1n, 1n, 18);

    const repayAmount = 1n;
    const orderId = 99n;
    const repaidAmountAfter = 1n;

    await pushMgr.connect(admin).retryRepay(user, asset, repayAmount, orderId, repaidAmountAfter);

    const [uBorrowValue, uRepayValue, uBorrowCount, uRepayCount] = await view.getUserLoanFlowWithMeta(user);
    expect(uBorrowValue).to.equal(0n);
    expect(uRepayValue).to.equal(0n);
    expect(uBorrowCount).to.equal(0n);
    expect(uRepayCount).to.equal(1n);
  });

  it("notifyBorrow can only be called by Registry[KEY_ORDER_ENGINE]", async function () {
    const { outsider, pushMgr } = await loadFixture(deployFixture);
    await expect(
      pushMgr.connect(outsider).notifyBorrow(ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address, 1n, 1n)
    ).to.be.revertedWithCustomError(pushMgr, "MissingRole");
  });

  it("emits CacheUpdateFailedWithContext (best-effort) when a dependency is missing", async function () {
    const { admin, registry, pushMgr, view } = await loadFixture(deployFixture);

    const user = ethers.Wallet.createRandom().address;
    const asset = ethers.Wallet.createRandom().address;

    // Simulate misconfiguration: PriceOracle missing in Registry.
    await registry.setModule(KEY_PRICE_ORACLE, ethers.ZeroAddress);

    const tx = await pushMgr.connect(admin).retryBorrow(user, asset, 1n, 1n);
    await expect(tx)
      .to.emit(pushMgr, "CacheUpdateFailedWithContext")
      .withArgs(user, asset, anyValue, await view.getAddress(), 0n, 0n, anyValue, 0, 0);
  });

  it("only LoanFlowPushManager or ACTION_ADMIN can push to LoanFlowView (Scheme B)", async function () {
    const { outsider, view } = await loadFixture(deployFixture);

    const user = ethers.Wallet.createRandom().address;
    await expect(
      view.connect(outsider).pushUserLoanFlowUpdate(user, 1n, 0n, 1n, 0n, ethers.id("rid"), 0, 1)
    ).to.be.revertedWithCustomError(view, "MissingRole");
  });
});

