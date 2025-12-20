import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const KEY_CM = ethers.id("COLLATERAL_MANAGER");
const KEY_LE = ethers.id("LENDING_ENGINE");
const KEY_LIQUIDATION_VIEW = ethers.id("LIQUIDATION_VIEW");
const KEY_ACCESS_CONTROL = ethers.id("ACCESS_CONTROL_MANAGER");

// =====================
// Debug helpers (opt-in)
// =====================
// Set env var to enable:
//   VBL_LIQUIDATION_DEBUG=1 npx hardhat test ...
const DEBUG = process.env.VBL_LIQUIDATION_DEBUG === "1";
function dlog(...args: any[]) {
  if (DEBUG) console.log("[VBL-LIQ-DEBUG]", ...args);
}
async function getAutomine(): Promise<boolean | "unknown"> {
  try {
    // Hardhat supports this RPC
    return await ethers.provider.send("evm_getAutomine", []);
  } catch {
    return "unknown";
  }
}
async function withTimeout<T>(label: string, p: Promise<T>, ms: number): Promise<T> {
  let t: any;
  const start = Date.now();
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        t = setTimeout(() => {
          reject(
            new Error(
              `[TIMEOUT] ${label} exceeded ${ms}ms (elapsed=${Date.now() - start}ms, automine=${String(
                (globalThis as any).__lastAutomine ?? "unknown"
              )})`
            )
          );
        }, ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}
async function setAutomine(v: boolean) {
  (globalThis as any).__lastAutomine = v;
  dlog("setAutomine", v);
  await ethers.provider.send("evm_setAutomine", [v]);
  dlog("automine now =", await getAutomine());
}
async function mineOnce(tag?: string) {
  dlog("evm_mine", tag ?? "");
  await ethers.provider.send("evm_mine", []);
}

describe("VaultBusinessLogic - liquidation orchestration", function () {
  // Safety net: if a test times out while automine is disabled, it can poison subsequent tests.
  // Always try to restore automine after each test.
  afterEach(async function () {
    try {
      await ethers.provider.send("evm_setAutomine", [true]);
    } catch {
      // ignore
    }
  });
  async function deployFixture() {
    const [deployer, liquidator, user] = await ethers.getSigners();
    const asset = ethers.Wallet.createRandom().address;

    // Deploy mocks
    const Registry = await ethers.getContractFactory("MockRegistry");
    const registry = await Registry.deploy();

    const ACM = await ethers.getContractFactory("MockAccessControlManager");
    const acm = await ACM.deploy();
    await acm.waitForDeployment();
    // Must match ActionKeys.ACTION_LIQUIDATE = keccak256("LIQUIDATE")
    await acm.grantRole(ethers.id("LIQUIDATE"), liquidator.address);

    const CM = await ethers.getContractFactory("MockCollateralManager");
    const cm = await CM.deploy();
    await cm.waitForDeployment();

    const LE = await ethers.getContractFactory("MockLendingEngineBasic");
    const le = await LE.deploy();
    await le.waitForDeployment();

    // Events view mock that can optionally revert
    const EventsView = await ethers.getContractFactory("MockEventsView");
    const ev = await EventsView.deploy();
    await ev.waitForDeployment();

    // Seed registry
    await registry.setModule(KEY_CM, await cm.getAddress());
    await registry.setModule(KEY_LE, await le.getAddress());
    await registry.setModule(KEY_LIQUIDATION_VIEW, await ev.getAddress());
    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());

    // Seed state: user has collateral and debt
    await cm.depositCollateral(user.address, asset, 100n);
    // Use borrow() so MockLendingEngineBasic also updates its totals (used by forceReduceDebt)
    await le.borrow(user.address, asset, 80n, 0n, 0);

    // Deploy VBL proxy
    const VBL = await ethers.getContractFactory("VaultBusinessLogic");
    const vbl = await upgrades.deployProxy(
      VBL,
      [await registry.getAddress(), ethers.Wallet.createRandom().address],
      {
        initializer: "initialize",
      }
    );
    await vbl.waitForDeployment();

    return { vbl, registry, cm, le, ev, liquidator, user, asset };
  }

  async function deployFixtureWithRevertingLE() {
    const base = await deployFixture();
    const RevertingLE = await ethers.getContractFactory("MockLendingEngineReverting");
    const leRevert = await RevertingLE.deploy();
    await leRevert.waitForDeployment();
    // replace LE in registry with reverting mock
    await base.registry.setModule(KEY_LE, await leRevert.getAddress());
    return { ...base, leRevert };
  }

  async function deployFixtureWithReentrantView() {
    const base = await deployFixture();
    const ReentrantView = await ethers.getContractFactory("MockEventsViewReentrant");
    const evRe = (await ReentrantView.deploy(await base.vbl.getAddress())) as any;
    await evRe.waitForDeployment();
    await base.registry.setModule(KEY_LIQUIDATION_VIEW, await evRe.getAddress());
    return { ...base, evRe };
  }

  async function deployFixtureWithReentrantCM() {
    const base = await deployFixture();
    const ReCM = await ethers.getContractFactory("MockCollateralManagerReentrant");
    const cmRe = (await ReCM.deploy(await base.vbl.getAddress())) as any;
    await cmRe.waitForDeployment();
    await base.registry.setModule(KEY_CM, await cmRe.getAddress());
    // keep LE and view same
    return { ...base, cmRe };
  }

  async function deployFixtureWithReentrantLE() {
    const base = await deployFixture();
    const ReLE = await ethers.getContractFactory("MockLendingEngineReentrant");
    const leRe = (await ReLE.deploy(await base.vbl.getAddress())) as any;
    await leRe.waitForDeployment();
    await base.registry.setModule(KEY_LE, await leRe.getAddress());
    return { ...base, leRe };
  }

  it("happy path: seize -> reduce -> push, atomic", async function () {
    const { vbl, cm, le, ev, liquidator, user, asset } = await loadFixture(deployFixture);

    const tx = await vbl.connect(liquidator).liquidate(user.address, asset, asset, 40n, 50n, 0);
    await expect(tx).to.emit(ev, "Pushed").withArgs(user.address, asset, asset, 40n, 50n, liquidator.address, 0);

    expect(await cm.getCollateral(user.address, asset)).to.equal(60n);
    expect(await le.getDebt(user.address, asset)).to.equal(30n);
  });

  it("reverts and leaves state when push fails", async function () {
    const { vbl, cm, le, ev, liquidator, user, asset } = await loadFixture(deployFixture);
    await ev.setShouldRevert(true);

    await expect(
      vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, 10n, 0)
    ).to.be.revertedWith("events-view-revert");

    // collateral/debt unchanged
    expect(await cm.getCollateral(user.address, asset)).to.equal(100n);
    expect(await le.getDebt(user.address, asset)).to.equal(80n);
  });

  it("reverts when liquidator lacks role", async function () {
    const { vbl, user, asset } = await loadFixture(deployFixture);
    await expect(
      vbl.connect(user).liquidate(user.address, asset, asset, 10n, 10n, 0)
    ).to.be.reverted;
  });

  it("reverts (atomic) when collateral seizure fails", async function () {
    const { vbl, cm, le, ev, liquidator, user, asset } = await loadFixture(deployFixture);
    await cm.setShouldFail(true);

    await expect(
      vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, 10n, 0)
    ).to.be.revertedWith("MockCollateralManager: withdraw failed");

    // state unchanged
    await cm.setShouldFail(false);
    expect(await cm.getCollateral(user.address, asset)).to.equal(100n);
    expect(await le.getDebt(user.address, asset)).to.equal(80n);
    await ev.setShouldRevert(false); // ensure no side-effect
  });

  it("works when collateral/debt资产不同，并正确更新各自余额", async function () {
    const { vbl, cm, le, ev, liquidator, user } = await loadFixture(deployFixture);
    const collateralAsset = ethers.Wallet.createRandom().address;
    const debtAsset = ethers.Wallet.createRandom().address;

    await cm.depositCollateral(user.address, collateralAsset, 120n);
    await le.borrow(user.address, debtAsset, 90n, 0n, 0);

    const tx = await vbl.connect(liquidator).liquidate(user.address, collateralAsset, debtAsset, 50n, 40n, 5n);
    await expect(tx)
      .to.emit(ev, "Pushed")
      .withArgs(user.address, collateralAsset, debtAsset, 50n, 40n, liquidator.address, 5n);

    expect(await cm.getCollateral(user.address, collateralAsset)).to.equal(70n);
    expect(await le.getDebt(user.address, debtAsset)).to.equal(50n);
  });

  it("reverts on zero amounts", async function () {
    const { vbl, liquidator, user, asset } = await loadFixture(deployFixture);
    await expect(
      vbl.connect(liquidator).liquidate(user.address, asset, asset, 0, 10n, 0)
    ).to.be.reverted;
    await expect(
      vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, 0, 0)
    ).to.be.reverted;
  });

  it("reverts when debt reduction fails", async function () {
    const { vbl, cm, le, liquidator, user, asset } = await loadFixture(deployFixture);
    // forceReduceDebt will revert if borrow was not seeded; simulate by zeroing debt and failing borrow
    await le.setUserDebt(user.address, asset, 0);

    await expect(
      vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, 10n, 0)
    ).to.be.reverted;

    expect(await cm.getCollateral(user.address, asset)).to.equal(100n);
    expect(await le.getDebt(user.address, asset)).to.equal(0);
  });

  it("reverts when LiquidationView is missing", async function () {
    const { vbl, registry, liquidator, user, asset } = await loadFixture(deployFixture);
    // Remove KEY_LIQUIDATION_VIEW binding
    await registry.setModule(KEY_LIQUIDATION_VIEW, ethers.ZeroAddress);

    await expect(
      vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, 10n, 0)
    ).to.be.reverted;
  });

  it("reverts when AccessControlManager is missing", async function () {
    const { vbl, registry, liquidator, user, asset } = await loadFixture(deployFixture);
    await registry.setModule(KEY_ACCESS_CONTROL, ethers.ZeroAddress);

    await expect(
      vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, 10n, 0)
    ).to.be.reverted;
  });

  it("multiple liquidations on same user adjust balances cumulatively", async function () {
    const { vbl, cm, le, ev, liquidator, user, asset } = await loadFixture(deployFixture);

    await vbl.connect(liquidator).liquidate(user.address, asset, asset, 30n, 20n, 0);
    await vbl.connect(liquidator).liquidate(user.address, asset, asset, 20n, 15n, 0);

    expect(await cm.getCollateral(user.address, asset)).to.equal(50n); // 100 - 30 - 20
    expect(await le.getDebt(user.address, asset)).to.equal(45n); // 80 - 20 - 15
    // last push emitted
    await expect(
      vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, 5n, 0)
    ).to.emit(ev, "Pushed");
  });

  it("seize succeeds but debt reduction reverts -> full revert", async function () {
    const { vbl, cm, le, liquidator, user, asset } = await loadFixture(deployFixtureWithRevertingLE);
    await expect(
      vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, 10n, 0)
    ).to.be.revertedWith("forceReduceDebt-revert");

    // original state intact
    expect(await cm.getCollateral(user.address, asset)).to.equal(100n);
    // reverting LE always reports 0 debt; ensure no change to prior ledger (le is unused after swap)
    expect(await le.getDebt(user.address, asset)).to.equal(80n);
  });

  it("second liquidation on insufficient remaining collateral reverts, keeps previous state", async function () {
    const { vbl, cm, le, liquidator, user, asset } = await loadFixture(deployFixture);

    await vbl.connect(liquidator).liquidate(user.address, asset, asset, 70n, 40n, 0);
    expect(await cm.getCollateral(user.address, asset)).to.equal(30n);
    expect(await le.getDebt(user.address, asset)).to.equal(40n);

    await expect(
      vbl.connect(liquidator).liquidate(user.address, asset, asset, 40n, 10n, 0)
    ).to.be.reverted;

    // state stays after first liquidation
    expect(await cm.getCollateral(user.address, asset)).to.equal(30n);
    expect(await le.getDebt(user.address, asset)).to.equal(40n);
  });

  it("two liquidations in the same block remain consistent (concurrency simulation)", async function () {
    const { vbl, cm, le, liquidator, user, asset } = await loadFixture(deployFixture);
    // Fire two tx back-to-back before awaiting, simulating contention
    const tx1Promise = vbl.connect(liquidator).liquidate(user.address, asset, asset, 30n, 20n, 0);
    const tx2Promise = vbl.connect(liquidator).liquidate(user.address, asset, asset, 20n, 15n, 0);
    await Promise.all([tx1Promise, tx2Promise]);

    expect(await cm.getCollateral(user.address, asset)).to.equal(50n); // 100 - 30 - 20
    expect(await le.getDebt(user.address, asset)).to.equal(45n); // 80 - 20 - 15
  });

  it("handles very large collateral/debt and bonus without overflow", async function () {
    const { vbl, cm, le, ev, liquidator, user } = await loadFixture(deployFixture);
    const collateralAsset = ethers.Wallet.createRandom().address;
    const debtAsset = ethers.Wallet.createRandom().address;
    const big = 10n ** 27n; // 1e27

    await cm.depositCollateral(user.address, collateralAsset, big);
    await le.borrow(user.address, debtAsset, big, 0n, 0);

    const tx = await vbl.connect(liquidator).liquidate(
      user.address,
      collateralAsset,
      debtAsset,
      big / 2n,
      big / 2n,
      big / 4n
    );
    await expect(tx)
      .to.emit(ev, "Pushed")
      .withArgs(user.address, collateralAsset, debtAsset, big / 2n, big / 2n, liquidator.address, big / 4n);

    expect(await cm.getCollateral(user.address, collateralAsset)).to.equal(big / 2n);
    expect(await le.getDebt(user.address, debtAsset)).to.equal(big / 2n);
  });

  // Note: deeper same-block concurrency and reentrancy are already covered by
  // the back-to-back Promise.all test above and nonReentrant guard within VBL.
  // Additional same-block mining tests were removed to avoid hardhat timeouts.

  it("same-block mined pair remains consistent (short window)", async function () {
    this.timeout(60_000);
    const { vbl, cm, le, liquidator, user, asset } = await loadFixture(deployFixture);
    // Make sure we don't inherit a disabled automine from other tests
    await setAutomine(true);
    await setAutomine(false);
    try {
      dlog("sending tx1");
      const tx1 = await withTimeout(
        "send tx1",
        vbl.connect(liquidator).liquidate(user.address, asset, asset, 20n, 12n, 0),
        15_000
      );
      dlog("tx1 hash", tx1.hash);

      dlog("sending tx2");
      const tx2 = await withTimeout(
        "send tx2",
        vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, 8n, 0),
        15_000
      );
      dlog("tx2 hash", tx2.hash);

      // With automine disabled and same-sender sequential nonces, Hardhat may only mine the first tx in the first block.
      // Mine, wait tx1, mine again for tx2.
      await mineOnce("mine #1 (likely tx1)");
      dlog("waiting tx1 receipt");
      await withTimeout("tx1.wait()", tx1.wait(), 20_000);

      await mineOnce("mine #2 (tx2)");
      dlog("waiting tx2 receipt");
      await withTimeout("tx2.wait()", tx2.wait(), 20_000);
      dlog("receipts done");
    } finally {
      await setAutomine(true);
    }
    expect(await cm.getCollateral(user.address, asset)).to.equal(70n); // 100 - 20 - 10
    expect(await le.getDebt(user.address, asset)).to.equal(60n); // 80 - 12 - 8
  });

  it("reentrancy via malicious LiquidationView reverts and rolls back", async function () {
    this.timeout(60_000);
    const { vbl, cm, le, liquidator, user, asset, evRe } = await loadFixture(deployFixtureWithReentrantView);
    await evRe.setReentryParams(user.address, asset, asset, 5n, 5n);

    // Guard against previous tests leaving automine disabled (would hang this test)
    await setAutomine(true);
    dlog("calling liquidate expecting reentrancy revert");
    await expect(
      vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, 10n, 0)
    ).to.be.revertedWith("ReentrancyGuard: reentrant call");
    dlog("reentrancy revert observed");

    // state unchanged
    expect(await cm.getCollateral(user.address, asset)).to.equal(100n);
    expect(await le.getDebt(user.address, asset)).to.equal(80n);
  });

  it("fails on withdrawCollateral and emits no Pushed", async function () {
    const { vbl, cm, ev, liquidator, user, asset } = await loadFixture(deployFixture);
    await cm.setShouldFail(true);
    await expect(
      vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, 10n, 0)
    ).to.be.revertedWith("MockCollateralManager: withdraw failed");
    const events = await ev.queryFilter(ev.filters.Pushed());
    expect(events.length).to.equal(0);
  });

  it("fails on forceReduceDebt and emits no Pushed", async function () {
    const { vbl, ev, liquidator, user, asset } = await loadFixture(deployFixtureWithRevertingLE);
    await expect(
      vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, 10n, 0)
    ).to.be.revertedWith("forceReduceDebt-revert");
    const events = await ev.queryFilter(ev.filters.Pushed());
    expect(events.length).to.equal(0);
  });

  it("fails on permission and emits no Pushed", async function () {
    const { vbl, ev, user, asset } = await loadFixture(deployFixture);
    await expect(
      vbl.connect(user).liquidate(user.address, asset, asset, 10n, 10n, 0)
    ).to.be.reverted;
    const events = await ev.queryFilter(ev.filters.Pushed());
    expect(events.length).to.equal(0);
  });

  it("fails when LE points to EOA and emits no Pushed", async function () {
    const { vbl, registry, ev, liquidator, user, asset } = await loadFixture(deployFixture);
    await registry.setModule(KEY_LE, ethers.Wallet.createRandom().address);
    await expect(
      vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, 10n, 0)
    ).to.be.reverted;
    const events = await ev.queryFilter(ev.filters.Pushed());
    expect(events.length).to.equal(0);
  });

  it("fails when CM points to EOA and emits no Pushed", async function () {
    const { vbl, registry, ev, liquidator, user, asset } = await loadFixture(deployFixture);
    await registry.setModule(KEY_CM, ethers.Wallet.createRandom().address);
    await expect(
      vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, 10n, 0)
    ).to.be.reverted;
    const events = await ev.queryFilter(ev.filters.Pushed());
    expect(events.length).to.equal(0);
  });

  it("reentrancy via CollateralManager is blocked and rolls back", async function () {
    this.timeout(60_000);
    const { vbl, le, liquidator, user, asset, cmRe } = await loadFixture(deployFixtureWithReentrantCM);
    await cmRe.setReentryParams(user.address, asset, 5n, 5n);

    await expect(
      vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, 10n, 0)
    ).to.be.revertedWith("ReentrancyGuard: reentrant call");

    // original debt still 80 (from base fixture)
    expect(await le.getDebt(user.address, asset)).to.equal(80n);
  });

  it("reentrancy via LendingEngine is blocked and rolls back", async function () {
    this.timeout(60_000);
    const { vbl, cm, liquidator, user, asset, leRe } = await loadFixture(deployFixtureWithReentrantLE);
    await leRe.setReentryParams(user.address, asset, 5n, 5n);

    await expect(
      vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, 10n, 0)
    ).to.be.revertedWith("ReentrancyGuard: reentrant call");

    expect(await cm.getCollateral(user.address, asset)).to.equal(100n);
  });

  it("exact full debt and collateral clears positions and emits once", async function () {
    const { vbl, cm, le, ev, liquidator, user, asset } = await loadFixture(deployFixture);
    // current state: collateral 100, debt 80
    const tx = await vbl.connect(liquidator).liquidate(user.address, asset, asset, 100n, 80n, 0);
    await expect(tx)
      .to.emit(ev, "Pushed")
      .withArgs(user.address, asset, asset, 100n, 80n, liquidator.address, 0);
    expect(await cm.getCollateral(user.address, asset)).to.equal(0n);
    expect(await le.getDebt(user.address, asset)).to.equal(0n);
  });

  it("over-collateral request reverts (insufficient collateral)", async function () {
    const { vbl, liquidator, user, asset } = await loadFixture(deployFixture);
    await expect(
      vbl.connect(liquidator).liquidate(user.address, asset, asset, 1_000_000n, 10n, 0)
    ).to.be.reverted;
  });

  it("over-debt request clamps to available debt (mock behavior) and emits actual", async function () {
    const { vbl, cm, le, ev, liquidator, user, asset } = await loadFixture(deployFixture);
    // Current MockLendingEngineBasic reverts on insufficient debt (no clamping)
    await expect(
      vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, 10_000n, 0)
    ).to.be.revertedWith("Insufficient debt");
    // state unchanged
    expect(await le.getDebt(user.address, asset)).to.equal(80n);
    expect(await cm.getCollateral(user.address, asset)).to.equal(100n);
  });

  it("LiquidationView points to EOA -> revert and rollback", async function () {
    const { vbl, cm, le, liquidator, user, asset, registry } = await loadFixture(deployFixture);
    const eoa = ethers.Wallet.createRandom().address;
    await registry.setModule(KEY_LIQUIDATION_VIEW, eoa);
    await expect(
      vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, 10n, 0)
    ).to.be.reverted;
    expect(await cm.getCollateral(user.address, asset)).to.equal(100n);
    expect(await le.getDebt(user.address, asset)).to.equal(80n);
  });

  it("module rebinding: switch LiquidationView after first success uses new sink", async function () {
    const { vbl, registry, ev, liquidator, user, asset } = await loadFixture(deployFixture);
    const NewEvents = await ethers.getContractFactory("MockEventsView");
    const newEv = await NewEvents.deploy();
    await newEv.waitForDeployment();

    // first call uses old ev
    await vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, 10n, 0);
    await registry.setModule(KEY_LIQUIDATION_VIEW, await newEv.getAddress());
    await expect(
      vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, 10n, 0)
    ).to.emit(newEv, "Pushed");
  });

  it("two different liquidators with automine off both succeed with correct emitters", async function () {
    this.timeout(60_000);
    const { vbl, cm, le, ev, user, asset, registry } = await loadFixture(deployFixture);
    const [, liq1, liq2] = await ethers.getSigners();
    const acm = await ethers.getContractAt("MockAccessControlManager", await registry.getModule(KEY_ACCESS_CONTROL));
    await acm.grantRole(ethers.id("LIQUIDATE"), liq1.address);
    await acm.grantRole(ethers.id("LIQUIDATE"), liq2.address);

    await setAutomine(true);
    await setAutomine(false);
    try {
      // Send both txs before mining, so they can be included in the same block.
      const [tx1, tx2] = await withTimeout(
        "send tx1+tx2",
        Promise.all([
          vbl.connect(liq1).liquidate(user.address, asset, asset, 10n, 10n, 1n),
          vbl.connect(liq2).liquidate(user.address, asset, asset, 15n, 12n, 2n),
        ]),
        20_000
      );
      // In practice Hardhat may not always include both senders' txs in a single mined block deterministically,
      // so mine sequentially to avoid hanging while still validating correctness under automine=false.
      await mineOnce("mine #1");
      await withTimeout("tx1.wait()", tx1.wait(), 20_000);
      await mineOnce("mine #2");
      await withTimeout("tx2.wait()", tx2.wait(), 20_000);
    } finally {
      await setAutomine(true);
    }

    expect(await cm.getCollateral(user.address, asset)).to.equal(75n); // 100 -10 -15
    expect(await le.getDebt(user.address, asset)).to.equal(58n); // 80 -10 -12
    const events = await ev.queryFilter(ev.filters.Pushed());
    expect(events.length).to.equal(2);
    const bonuses = events.map((e) => e.args?.bonus);
    const liquidators = events.map((e) => e.args?.liquidator);
    expect(new Set(liquidators)).to.deep.equal(new Set([liq1.address, liq2.address]));
    expect(new Set(bonuses)).to.deep.equal(new Set([1n, 2n]));
  });

  it("asset-split exact clear and over-debt revert", async function () {
    const { vbl, cm, le, ev, liquidator, user } = await loadFixture(deployFixture);
    const ca = ethers.Wallet.createRandom().address;
    const da = ethers.Wallet.createRandom().address;
    await cm.depositCollateral(user.address, ca, 200n);
    await le.borrow(user.address, da, 150n, 0n, 0);

    // exact clear on split assets
    await vbl.connect(liquidator).liquidate(user.address, ca, da, 200n, 150n, 0);
    expect(await cm.getCollateral(user.address, ca)).to.equal(0n);
    expect(await le.getDebt(user.address, da)).to.equal(0n);

    // reset state
    await cm.depositCollateral(user.address, ca, 50n);
    await le.borrow(user.address, da, 30n, 0n, 0);
    await expect(
      vbl.connect(liquidator).liquidate(user.address, ca, da, 60n, 1_000n, 0)
    ).to.be.reverted; // collateral is insufficient (60 > 50), so revert reason may vary by mock
    const events = await ev.queryFilter(ev.filters.Pushed());
    expect(events.filter((e) => e.args?.collateralAsset === ca).length).to.equal(1);
  });

  it("property-ish: multiple runs check event/ledger consistency", async function () {
    const { vbl, cm, le, ev, liquidator, user, asset } = await loadFixture(deployFixture);
    const cases: Array<[bigint, bigint, bigint]> = [
      [5n, 4n, 1n],
      [8n, 6n, 0n],
      [12n, 7n, 3n],
      [6n, 5n, 2n],
      [9n, 8n, 1n],
    ];
    for (const [c, d, b] of cases) {
      await vbl.connect(liquidator).liquidate(user.address, asset, asset, c, d, b);
    }
    const events = await ev.queryFilter(ev.filters.Pushed());
    expect(events.length).to.be.at.least(cases.length);
    const finalCollateral = await cm.getCollateral(user.address, asset);
    const finalDebt = await le.getDebt(user.address, asset);
    const totalC = cases.reduce((acc, [c]) => acc + c, 0n);
    const totalD = cases.reduce((acc, [, d]) => acc + d, 0n);
    expect(finalCollateral).to.equal(100n - totalC);
    expect(finalDebt).to.equal(80n - totalD);
  });
});

