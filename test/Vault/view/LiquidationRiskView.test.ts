import { expect } from "chai";
import { ethers, upgrades } from "hardhat";

const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes("ACCESS_CONTROL_MANAGER"));
const KEY_LIQUIDATION_RISK_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATION_RISK_MANAGER"));
const KEY_HEALTH_VIEW = ethers.keccak256(ethers.toUtf8Bytes("HEALTH_VIEW"));

const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes("ACTION_ADMIN"));
const ACTION_VIEW_RISK_DATA = ethers.keccak256(ethers.toUtf8Bytes("VIEW_RISK_DATA"));
const ACTION_VIEW_PUSH = ethers.keccak256(ethers.toUtf8Bytes("ACTION_VIEW_PUSH"));

describe("LiquidationRiskView (HealthView-aligned)", function () {
  async function deployFixture() {
    const [admin, user, other, viewer] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory("MockRegistry")).deploy();
    const acm = await (await ethers.getContractFactory("MockAccessControlManager")).deploy();
    const rm = await (await ethers.getContractFactory("MockLiquidationRiskManager")).deploy();

    // HealthView (UUPS)
    const HealthView = await ethers.getContractFactory("HealthView");
    const healthView = await upgrades.deployProxy(HealthView, [await registry.getAddress()], { kind: "uups" });

    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(KEY_LIQUIDATION_RISK_MANAGER, await rm.getAddress());
    await registry.setModule(KEY_HEALTH_VIEW, await healthView.getAddress());

    await acm.grantRole(ACTION_ADMIN, admin.address);
    await acm.grantRole(ACTION_VIEW_RISK_DATA, admin.address);
    await acm.grantRole(ACTION_VIEW_RISK_DATA, viewer.address);
    await acm.grantRole(ACTION_VIEW_PUSH, admin.address);

    // Seed mock RM data (risk + thresholds)
    await rm.setLiquidatable(user.address, true);
    await rm.setLiquidatable(other.address, false);
    await rm.setRiskScore(user.address, 55);
    await rm.setLiquidationThreshold(11_000);
    await rm.setMinHealthFactor(10_500);

    // Seed HealthView cache (timestamp=0 => use block.timestamp)
    await healthView.connect(admin).pushRiskStatus(user.address, 12_000, 10_500, false, 0);

    // Deploy LiquidationRiskView
    const ViewFactory = await ethers.getContractFactory("LiquidationRiskView");
    const view = await upgrades.deployProxy(ViewFactory, [await registry.getAddress()], { kind: "uups" });

    return { view, registry, acm, rm, healthView, admin, user, other, viewer };
  }

  it("stores registry and exposes getters", async function () {
    const { view, registry } = await deployFixture();
    expect(await view.registryAddr()).to.equal(await registry.getAddress());
    expect(await view.getRegistry()).to.equal(await registry.getAddress());
  });

  it("allows user to view own liquidation status without risk role", async function () {
    const { view, user } = await deployFixture();
    await expect(view.connect(user).isLiquidatable(user.address)).to.not.be.reverted;
  });

  it("denies viewing other user risk without role", async function () {
    const { view, user, other, acm } = await deployFixture();
    await expect(view.connect(other).isLiquidatable(user.address)).to.be.revertedWithCustomError(acm, "MissingRole");
  });

  it("returns cached HF + block when valid", async function () {
    const { view, user } = await deployFixture();
    const res = await view.getHealthFactorCacheWithBlock(user.address);
    const currentBlock = await ethers.provider.getBlockNumber();
    expect(res.healthFactor).to.equal(12_000n);
    expect(res.timestamp).to.not.equal(0n);
    expect(res.blockNumber).to.equal(BigInt(currentBlock));
  });

  it("returns zeros when cache is empty/invalid", async function () {
    const { view, other } = await deployFixture();
    const res = await view.getHealthFactorCacheWithBlock(other.address);
    expect(res.healthFactor).to.equal(0n);
    expect(res.timestamp).to.equal(0n);
    expect(res.blockNumber).to.equal(0n);
  });

  it("reads risk score from RiskManager and HF from HealthView", async function () {
    const { view, user, other } = await deployFixture();
    expect(await view.getLiquidationRiskScore(user.address)).to.equal(55n);
    expect(await view.getUserHealthFactor(user.address)).to.equal(12_000n);
    expect(await view.getUserHealthFactor(other.address)).to.equal(0n);
  });

  it("batchIsLiquidatable returns flags (role-gated)", async function () {
    const { view, admin, user, other } = await deployFixture();
    const res = await view.connect(admin).batchIsLiquidatable([user.address, other.address]);
    expect(res[0]).to.equal(true);
    expect(res[1]).to.equal(false);
  });

  it("batchGetUserHealthFactors returns cached factors (invalid => 0)", async function () {
    const { view, admin, user, other } = await deployFixture();
    const res = await view.connect(admin).batchGetUserHealthFactors([user.address, other.address]);
    expect(res[0]).to.equal(12_000n);
    expect(res[1]).to.equal(0n);
  });

  it("getHealthFactorCache returns raw cache (hf + timestamp)", async function () {
    const { view, user } = await deployFixture();
    const cache = await view.getHealthFactorCache(user.address);
    expect(cache.healthFactor).to.equal(12_000n);
    expect(cache.timestamp).to.not.equal(0n);
  });
});

