import { expect } from "chai";
import { loadFixture, mine } from "@nomicfoundation/hardhat-network-helpers";
import { ethers, upgrades } from "hardhat";

const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes("ACCESS_CONTROL_MANAGER"));
const KEY_DEGRADATION_MONITOR = ethers.keccak256(ethers.toUtf8Bytes("DEGRADATION_MONITOR"));

const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes("ACTION_ADMIN"));
const ACTION_VIEW_SYSTEM_STATUS = ethers.keccak256(ethers.toUtf8Bytes("ACTION_VIEW_SYSTEM_STATUS"));

describe("DegradationMonitor (Scheme A trends fallback)", function () {
  async function deployFixture() {
    const [admin, systemViewer, other] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory("MockRegistry")).deploy();
    const acm = await (await ethers.getContractFactory("MockAccessControlManager")).deploy();
    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());

    await acm.grantRole(ACTION_ADMIN, admin.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_STATUS, systemViewer.address);

    const CoreFactory = await ethers.getContractFactory("src/monitor/DegradationCore.sol:DegradationCore");
    const core = await upgrades.deployProxy(CoreFactory, [await registry.getAddress()], { kind: "uups" });

    const StorageFactory = await ethers.getContractFactory("src/monitor/DegradationStorage.sol:DegradationStorage");
    const storage = await upgrades.deployProxy(StorageFactory, [await registry.getAddress()], { kind: "uups" });

    const MonitorFactory = await ethers.getContractFactory("src/monitor/DegradationMonitor.sol:DegradationMonitor");
    const monitor = await upgrades.deployProxy(
      MonitorFactory,
      [
        await registry.getAddress(),
        admin.address, // upgrade admin
        await core.getAddress(),
        await storage.getAddress(),
        ethers.ZeroAddress, // health module (unused here)
        ethers.ZeroAddress, // analytics module (unset -> Scheme A fallback)
        admin.address, // placeholder admin module addr
        1800, // upgrade window blocks
      ],
      { kind: "uups" }
    );

    // Important: core/storage allow monitor reads when registry points KEY_DEGRADATION_MONITOR to this monitor.
    await registry.setModule(KEY_DEGRADATION_MONITOR, await monitor.getAddress());

    return { registry, acm, core, storage, monitor, admin, systemViewer, other };
  }

  it("computes trends from DegradationStorage window when analytics is unset", async function () {
    const { storage, monitor, admin } = await loadFixture(deployFixture);

    // Ensure current block is beyond the default recent window (ViewConstants.CACHE_DURATION_BLOCKS=150).
    await mine(200);
    const cur = BigInt(await ethers.provider.getBlockNumber());
    const oldBlock = cur - 151n;

    const moduleA = ethers.Wallet.createRandom().address;
    const moduleB = ethers.Wallet.createRandom().address;

    const reasonA = ethers.keccak256(ethers.toUtf8Bytes("REASON_A"));
    const reasonB = ethers.keccak256(ethers.toUtf8Bytes("REASON_B"));

    // Two recent events for moduleA, one old event for moduleB.
    await storage.connect(admin).addEventToCircularBuffer({
      module: moduleA,
      reasonHash: reasonA,
      fallbackValue: 10n,
      usedFallback: true,
      legacyBlockNumber: cur,
      blockNumber: cur,
    });
    await storage.connect(admin).addEventToCircularBuffer({
      module: moduleA,
      reasonHash: reasonA,
      fallbackValue: 20n,
      usedFallback: true,
      legacyBlockNumber: cur - 1n,
      blockNumber: cur - 1n,
    });
    await storage.connect(admin).addEventToCircularBuffer({
      module: moduleB,
      reasonHash: reasonB,
      fallbackValue: 30n,
      usedFallback: false,
      legacyBlockNumber: oldBlock,
      blockNumber: oldBlock,
    });

    const [total, recent, mostFrequent, avg] = await monitor.connect(admin).getSystemDegradationTrends();
    expect(total).to.equal(3n);
    expect(recent).to.equal(2n);
    expect(mostFrequent).to.equal(moduleA);
    expect(avg).to.equal(20n); // (10+20+30)/3
  });

  it("supports DegradationMonitor as write-path coordinator (no ACTION_ADMIN needed for monitor itself)", async function () {
    const { monitor, admin } = await loadFixture(deployFixture);

    const targetModule = ethers.Wallet.createRandom().address;
    await monitor.connect(admin).recordDegradationEvent(targetModule, "E2E_REASON", 42n, true);

    // Core stats should reflect the write.
    const stats = await monitor.getGracefulDegradationStats();
    expect(stats.totalDegradations).to.equal(1n);
    expect(stats.lastDegradedModule).to.equal(targetModule);

    // Storage ring-buffer should contain the event; monitor read is viewer-gated but admin passes.
    const history = await monitor.connect(admin).getSystemDegradationHistory(10);
    expect(history.length).to.equal(1);
    expect(history[0].module).to.equal(targetModule);
  });

  it("rejects direct writes to Core/Storage from non-monitor, non-admin callers", async function () {
    const { core, storage, acm, other } = await loadFixture(deployFixture);

    const targetModule = ethers.Wallet.createRandom().address;

    await expect(core.connect(other).adminRecordDegradation(targetModule, "NOPE", 1n, true)).to.be.revertedWithCustomError(
      acm,
      "MissingRole"
    );

    await expect(
      storage.connect(other).addEventToCircularBuffer({
        module: targetModule,
        reasonHash: ethers.keccak256(ethers.toUtf8Bytes("NOPE")),
        fallbackValue: 1n,
        usedFallback: true,
        legacyBlockNumber: 1n,
        blockNumber: 1n,
      })
    ).to.be.revertedWithCustomError(acm, "MissingRole");
  });

  it("prefers DegradationCore lifetime totals/avg when available (still uses storage for recent/frequent)", async function () {
    const { storage, core, monitor, admin } = await loadFixture(deployFixture);

    await mine(200);
    const cur = BigInt(await ethers.provider.getBlockNumber());
    const oldBlock = cur - 151n;

    // Seed core lifetime stats: 2 events with fallback 10 and 20 => avg = 15.
    await core.connect(admin).adminRecordDegradation(ethers.Wallet.createRandom().address, "CORE_1", 10n, true);
    await core.connect(admin).adminRecordDegradation(ethers.Wallet.createRandom().address, "CORE_2", 20n, true);

    const moduleA = ethers.Wallet.createRandom().address;
    const moduleB = ethers.Wallet.createRandom().address;
    const reasonA = ethers.keccak256(ethers.toUtf8Bytes("REASON_A"));
    const reasonB = ethers.keccak256(ethers.toUtf8Bytes("REASON_B"));

    // Storage window: moduleB is most frequent; only one recent event.
    await storage.connect(admin).addEventToCircularBuffer({
      module: moduleB,
      reasonHash: reasonB,
      fallbackValue: 1n,
      usedFallback: true,
      legacyBlockNumber: cur,
      blockNumber: cur,
    });
    await storage.connect(admin).addEventToCircularBuffer({
      module: moduleB,
      reasonHash: reasonB,
      fallbackValue: 2n,
      usedFallback: true,
      legacyBlockNumber: oldBlock,
      blockNumber: oldBlock,
    });
    await storage.connect(admin).addEventToCircularBuffer({
      module: moduleA,
      reasonHash: reasonA,
      fallbackValue: 3n,
      usedFallback: true,
      legacyBlockNumber: oldBlock,
      blockNumber: oldBlock,
    });

    const [total, recent, mostFrequent, avg] = await monitor.connect(admin).getSystemDegradationTrends();
    expect(total).to.equal(2n); // from core lifetime totals
    expect(avg).to.equal(15n); // from core lifetime avg
    expect(recent).to.equal(1n); // from storage window scan
    expect(mostFrequent).to.equal(moduleB); // from storage window scan
  });

  it("reverts for callers without viewer/admin permissions", async function () {
    const { monitor, other } = await loadFixture(deployFixture);
    await expect(monitor.connect(other).getSystemDegradationTrends()).to.be.revertedWithCustomError(
      monitor,
      "MissingSystemHealthViewerRole",
    );
  });
});

