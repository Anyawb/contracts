import { expect } from "chai";
import hardhat from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const { ethers, upgrades } = hardhat;

describe("value rounding bias with many 18-decimal valuations", function () {
  const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes("ACCESS_CONTROL_MANAGER"));
  const KEY_LOAN_FLOW_VIEW = ethers.keccak256(ethers.toUtf8Bytes("LOAN_FLOW_VIEW"));
  const KEY_LOAN_FLOW_PUSH_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("LOAN_FLOW_PUSH_MANAGER"));
  const KEY_PRICE_ORACLE = ethers.keccak256(ethers.toUtf8Bytes("PRICE_ORACLE"));
  const KEY_ORDER_ENGINE = ethers.keccak256(ethers.toUtf8Bytes("ORDER_ENGINE"));

  const ROLE_VIEW_PUSH = ethers.keccak256(ethers.toUtf8Bytes("ACTION_VIEW_PUSH"));
  const ROLE_ADMIN = ethers.keccak256(ethers.toUtf8Bytes("ACTION_ADMIN"));
  const E18 = 10n ** 18n;
  const USD8_SCALE = 10n ** 8n;

  function floorUsd8(amountBaseUnits: bigint, priceUsd8: bigint, assetDecimals: bigint = 18n): bigint {
    return (amountBaseUnits * priceUsd8) / 10n ** assetDecimals;
  }

  async function deployLoanFlowFixture() {
    const [admin] = await ethers.getSigners();

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

    await acm.grantRole(ROLE_VIEW_PUSH, await admin.getAddress());
    await acm.grantRole(ROLE_ADMIN, await admin.getAddress());

    return { admin, view, pushMgr, oracle };
  }

  it("LoanFlowView undercounts when many 18-decimal micro-borrows are rounded per event", async function () {
    const { admin, view, pushMgr, oracle } = await loadFixture(deployLoanFlowFixture);

    const user = ethers.Wallet.createRandom().address;
    const asset = ethers.Wallet.createRandom().address;
    const priceUsd8 = 95_000_000n;
    const amountBaseUnits = 10n ** 10n;
    const borrowCount = 20;

    await oracle.setPrice(asset, priceUsd8, 1n, 18);

    let exactNumerator = 0n;
    let perEventFloored = 0n;

    for (let index = 0; index < borrowCount; index += 1) {
      await pushMgr.connect(admin).retryBorrow(user, asset, amountBaseUnits, BigInt(index + 1));
      exactNumerator += amountBaseUnits * priceUsd8;
      perEventFloored += floorUsd8(amountBaseUnits, priceUsd8);
    }

    const aggregateFloor = exactNumerator / E18;
    const [storedBorrowUsd8, storedRepayUsd8, storedBorrowCount, storedRepayCount] = await view.getUserLoanFlowWithMeta(user);

    expect(perEventFloored).to.equal(0n);
    expect(aggregateFloor).to.equal(19n);
    expect(storedBorrowUsd8).to.equal(perEventFloored);
    expect(storedRepayUsd8).to.equal(0n);
    expect(storedBorrowCount).to.equal(BigInt(borrowCount));
    expect(storedRepayCount).to.equal(0n);

    const biasUsd8 = aggregateFloor - storedBorrowUsd8;
    expect(biasUsd8).to.equal(19n);
    expect(ethers.formatUnits(biasUsd8, 8)).to.equal("0.00000019");
  });

  it("heterogeneous 18-decimal prices still lose value if each position is floored before aggregation", async function () {
    const amountBaseUnits = 10n ** 10n;
    const priceUsd8List = [
      91_000_001n,
      92_000_003n,
      93_000_007n,
      94_000_009n,
      95_000_011n,
      96_000_013n,
      97_000_017n,
      98_000_019n,
      99_000_023n,
      99_999_937n,
    ];

    let exactNumerator = 0n;
    let perPositionFloored = 0n;

    for (const priceUsd8 of priceUsd8List) {
      exactNumerator += amountBaseUnits * priceUsd8;
      perPositionFloored += floorUsd8(amountBaseUnits, priceUsd8);
    }

    const aggregateFloor = exactNumerator / E18;
    const lostUsd8 = aggregateFloor - perPositionFloored;

    expect(perPositionFloored).to.equal(0n);
    expect(aggregateFloor).to.equal(9n);
    expect(lostUsd8).to.equal(9n);
    expect(ethers.formatUnits(lostUsd8, 8)).to.equal("0.00000009");
  });

  it("the absolute USD error is bounded by the number of rounded entries times 1e-8 USD", async function () {
    const entryCount = 1_000_000n;
    const amountBaseUnits = 10n ** 10n;
    const priceUsd8 = 99_999_999n;

    const perEntryFloor = floorUsd8(amountBaseUnits, priceUsd8);
    const aggregateFloor = (entryCount * amountBaseUnits * priceUsd8) / E18;
    const totalPerEntryFloor = entryCount * perEntryFloor;
    const lostUsd8 = aggregateFloor - totalPerEntryFloor;

    expect(perEntryFloor).to.equal(0n);
    expect(lostUsd8).to.equal(999_999n);
    expect(lostUsd8).to.be.lessThan(entryCount);
    expect(ethers.formatUnits(lostUsd8, 8)).to.equal("0.00999999");
    expect(ethers.formatUnits(entryCount * USD8_SCALE, 8)).to.equal("1000000.0");
  });
});