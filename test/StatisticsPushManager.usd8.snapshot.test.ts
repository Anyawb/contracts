import { expect } from "chai";
import hardhat from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

const { ethers, upgrades } = hardhat;

describe("StatisticsPushManager (strict B+) – normalized 18-decimal snapshot pipeline", function () {
  const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes("ACCESS_CONTROL_MANAGER"));
  const KEY_STATS = ethers.keccak256(ethers.toUtf8Bytes("VAULT_STATISTICS"));
  const KEY_LE = ethers.keccak256(ethers.toUtf8Bytes("LENDING_ENGINE"));
  const KEY_POSITION_VIEW = ethers.keccak256(ethers.toUtf8Bytes("POSITION_VIEW"));
  const KEY_STATS_PUSH_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("STATISTICS_PUSH_MANAGER"));

  const ROLE_VIEW_PRICE_DATA = ethers.keccak256(ethers.toUtf8Bytes("VIEW_PRICE_DATA"));
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

    // Deploy StatisticsView + orchestrator.
    const StatsF = await ethers.getContractFactory("StatisticsView");
    const stats = await upgrades.deployProxy(StatsF, [await registry.getAddress()]);
    await stats.waitForDeployment();

    const PushMgrF = await ethers.getContractFactory("StatisticsPushManager");
    const pushMgr = await upgrades.deployProxy(PushMgrF, [await registry.getAddress()]);
    await pushMgr.waitForDeployment();

    // Deploy valuation mocks.
    const PVF = await ethers.getContractFactory("MockPositionViewValuation");
    const pv = await PVF.deploy();
    await pv.waitForDeployment();

    const LEF = await ethers.getContractFactory("MockLendingEngineBasic");
    const le = await LEF.deploy();
    await le.waitForDeployment();

    // Bind SSOT modules in Registry.
    await registry.setModule(KEY_STATS, await stats.getAddress());
    await registry.setModule(KEY_STATS_PUSH_MANAGER, await pushMgr.getAddress());
    await registry.setModule(KEY_POSITION_VIEW, await pv.getAddress());
    await registry.setModule(KEY_LE, await le.getAddress());

    // Grant required roles for the orchestrator.
    await acm.grantRole(ROLE_VIEW_PRICE_DATA, await pushMgr.getAddress());

    // Allow admin to call retry* APIs.
    await acm.grantRole(ROLE_VIEW_PUSH, await admin.getAddress());
    // Allow admin to read any user-dimensional snapshots (Scheme U).
    await acm.grantRole(ROLE_ADMIN, await admin.getAddress());

    return { admin, outsider, registry, acm, stats, pushMgr, pv, le };
  }

  it("emits CacheUpdateFailedWithContext (best-effort) when a dependency is missing", async function () {
    const { admin, registry, stats, pushMgr } = await loadFixture(deployFixture);

    const user = ethers.Wallet.createRandom().address;

    // Simulate misconfiguration: PositionView missing in Registry.
    await registry.setModule(KEY_POSITION_VIEW, ethers.ZeroAddress);

    const tx = await pushMgr.connect(admin).retryUserStats(user);
    await expect(tx)
      .to.emit(pushMgr, "CacheUpdateFailedWithContext")
      .withArgs(user, ethers.ZeroAddress, anyValue, await stats.getAddress(), 0n, 0n, anyValue, anyValue, 0);
  });

  it("retryUserStats pushes normalized 18-decimal totals from PositionView + LendingEngine into StatisticsView snapshot", async function () {
    const { admin, stats, pushMgr, pv, le } = await loadFixture(deployFixture);

    const user = ethers.Wallet.createRandom().address;
    const collateralValue = 123_456_789n * 10n ** 10n;
    const debtValue = 42_000_000n * 10n ** 10n;

    await pv.setTotal(user, collateralValue);
    await le.borrow(user, ethers.Wallet.createRandom().address, debtValue, 0n, 0); // increments mock total value

    const DATA_TYPE_USER_STATS_UPDATE = ethers.keccak256(ethers.toUtf8Bytes("USER_STATS_UPDATE"));

    const tx = await pushMgr.connect(admin).retryUserStats(user);
    await expect(tx).to.emit(stats, "DataPushed").withArgs(DATA_TYPE_USER_STATS_UPDATE, anyValue);

    const [snap] = await stats.getUserSnapshotWithMeta(user);
    expect(snap.collateral).to.equal(collateralValue);
    expect(snap.debt).to.equal(debtValue);

    const [g] = await stats.getGlobalSnapshotWithMeta();
    expect(g.totalCollateral).to.equal(collateralValue);
    expect(g.totalDebt).to.equal(debtValue);
  });

  it("only StatsPushManager or ACTION_ADMIN can push to StatisticsView (Scheme B)", async function () {
    const { outsider, stats } = await loadFixture(deployFixture);

    const user = ethers.Wallet.createRandom().address;
    await expect(
      stats.connect(outsider).pushUserStatsSnapshot(user, 1n, 1n, ethers.id("rid"), 1n, 1n)
    ).to.be.revertedWithCustomError(stats, "MissingRole");
  });
});

