import { expect } from "chai";
import hardhat from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

const { ethers, upgrades } = hardhat;

describe("LoanFlowPushManager (strict B+) – USD-8 flow deltas", function () {
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

  it("retryBorrow converts token amount into USD-8 and updates user + global totals", async function () {
    const { admin, view, pushMgr, oracle } = await loadFixture(deployFixture);

    const user = ethers.Wallet.createRandom().address;
    const asset = ethers.Wallet.createRandom().address;

    // priceUsd8 = $2.00, decimals=18
    await oracle.setPrice(asset, 200_000_000n, 123n, 18);

    const principal = 10n * 10n ** 18n;
    const orderId = 7n;

    const DATA_TYPE_LOAN_FLOW_UPDATED = ethers.keccak256(ethers.toUtf8Bytes("LOAN_FLOW_UPDATED"));

    const tx = await pushMgr.connect(admin).retryBorrow(user, asset, principal, orderId);
    await expect(tx).to.emit(view, "DataPushed").withArgs(DATA_TYPE_LOAN_FLOW_UPDATED, anyValue);

    const [uBorrowUsd8, uRepayUsd8, uBorrowCount, uRepayCount] = await view.getUserLoanFlowWithMeta(user);
    expect(uBorrowUsd8).to.equal(2_000_000_000n); // 10 * $2, USD-8
    expect(uRepayUsd8).to.equal(0n);
    expect(uBorrowCount).to.equal(1n);
    expect(uRepayCount).to.equal(0n);

    const [gBorrowUsd8, gRepayUsd8, gBorrowCount, gRepayCount] = await view.getGlobalLoanFlowWithMeta();
    expect(gBorrowUsd8).to.equal(2_000_000_000n);
    expect(gRepayUsd8).to.equal(0n);
    expect(gBorrowCount).to.equal(1n);
    expect(gRepayCount).to.equal(0n);
  });

  it("getGlobalLoanFlowWithMeta is publicly readable", async function () {
    const { outsider, view } = await loadFixture(deployFixture);
    await expect(view.connect(outsider).getGlobalLoanFlowWithMeta()).to.not.be.reverted;
  });

  it("retryRepay preserves count even when USD-8 rounds down to 0", async function () {
    const { admin, view, pushMgr, oracle } = await loadFixture(deployFixture);

    const user = ethers.Wallet.createRandom().address;
    const asset = ethers.Wallet.createRandom().address;

    // priceUsd8 = 1 (=$0.00000001), decimals=18; 1 wei -> valueUsd8=0
    await oracle.setPrice(asset, 1n, 1n, 18);

    const repayAmount = 1n;
    const orderId = 99n;
    const repaidAmountAfter = 1n;

    await pushMgr.connect(admin).retryRepay(user, asset, repayAmount, orderId, repaidAmountAfter);

    const [uBorrowUsd8, uRepayUsd8, uBorrowCount, uRepayCount] = await view.getUserLoanFlowWithMeta(user);
    expect(uBorrowUsd8).to.equal(0n);
    expect(uRepayUsd8).to.equal(0n);
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

