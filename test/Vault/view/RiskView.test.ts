import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const KEY_ACM = ethers.keccak256(ethers.toUtf8Bytes("ACCESS_CONTROL_MANAGER"));
const KEY_HEALTH_VIEW = ethers.keccak256(ethers.toUtf8Bytes("HEALTH_VIEW"));
const KEY_LE = ethers.keccak256(ethers.toUtf8Bytes("LENDING_ENGINE"));
const KEY_CM = ethers.keccak256(ethers.toUtf8Bytes("COLLATERAL_MANAGER"));
const KEY_GUARANTEE_FUND = ethers.keccak256(ethers.toUtf8Bytes("GUARANTEE_FUND_MANAGER"));
const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes("ACTION_ADMIN"));

describe("RiskView", function () {
  async function deployFixture() {
    const [admin, user, other] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("MockRegistry");
    const registry = await Registry.deploy();

    const ACM = await ethers.getContractFactory("MockAccessControlManager");
    const acm = await ACM.deploy();

    const HealthView = await ethers.getContractFactory("MockHealthViewLite");
    const hv = await HealthView.deploy();

    const Totals = await ethers.getContractFactory("MockTotals");
    const le = await Totals.deploy(); // debt
    const cm = await Totals.deploy(); // collateral

    const Guarantee = await ethers.getContractFactory("MockGuaranteeFund");
    const gf = await Guarantee.deploy();

    await registry.setModule(KEY_ACM, await acm.getAddress());
    await registry.setModule(KEY_HEALTH_VIEW, await hv.getAddress());
    await registry.setModule(KEY_LE, await le.getAddress());
    await registry.setModule(KEY_CM, await cm.getAddress());
    await registry.setModule(KEY_GUARANTEE_FUND, await gf.getAddress());

    await acm.grantRole(ACTION_ADMIN, admin.address);

    const RiskView = await ethers.getContractFactory("RiskView");
    const rv = await upgrades.deployProxy(RiskView, [await registry.getAddress()], { kind: "uups" });

    return { admin, user, other, registry, acm, hv, le, cm, gf, rv };
  }

  it("initialize should revert on zero registry", async function () {
    const RiskView = await ethers.getContractFactory("RiskView");
    await expect(upgrades.deployProxy(RiskView, [ethers.ZeroAddress], { kind: "uups" })).to.be.revertedWithCustomError(
      RiskView,
      "ZeroAddress"
    );
  });

  it("getUserRiskAssessment returns critical when HF < 100%", async function () {
    const { hv, rv, user } = await loadFixture(deployFixture);
    await hv.setHealth(user.address, 9_000, true); // bps
    const res = await rv.getUserRiskAssessment(user.address);
    expect(res.liquidatable).to.equal(true);
    expect(res.warningLevel).to.equal(2);
  });

  it("getUserRiskAssessment returns warning when HF between 100% and 110%", async function () {
    const { hv, rv, user } = await loadFixture(deployFixture);
    await hv.setHealth(user.address, 10_500, true); // bps
    const res = await rv.getUserRiskAssessment(user.address);
    expect(res.liquidatable).to.equal(false);
    expect(res.warningLevel).to.equal(1);
  });

  it("getUserRiskAssessment returns none when HF >= 110%", async function () {
    const { hv, rv, user } = await loadFixture(deployFixture);
    await hv.setHealth(user.address, 12_000, true); // bps
    const res = await rv.getUserRiskAssessment(user.address);
    expect(res.liquidatable).to.equal(false);
    expect(res.warningLevel).to.equal(0);
  });

  it("getUserRiskAssessment falls back to default when invalid", async function () {
    const { hv, rv, user } = await loadFixture(deployFixture);
    await hv.setHealth(user.address, 0, false);
    const res = await rv.getUserRiskAssessment(user.address);
    expect(res.healthFactor).to.equal(10_000);
    expect(res.liquidatable).to.equal(false);
  });

  it("batchGetRiskAssessments enforces max batch size", async function () {
    const { rv } = await loadFixture(deployFixture);
    const tooMany = Array.from({ length: 101 }, () => ethers.Wallet.createRandom().address);
    await expect(rv.batchGetRiskAssessments(tooMany)).to.be.revertedWithCustomError(rv, "RiskView__BatchTooLarge");
  });

  it("calculateHealthFactorExcludingGuarantee uses totals and guarantee", async function () {
    const { rv, le, cm, gf, user } = await loadFixture(deployFixture);
    await le.setTotal(user.address, 100); // debt
    await cm.setTotal(user.address, 200); // collateral
    const asset = ethers.Wallet.createRandom().address;
    await gf.setLocked(user.address, asset, 50); // guarantee
    const hf = await rv.calculateHealthFactorExcludingGuarantee(user.address, asset);
    expect(hf).to.equal(15000);
  });

  it("registryAddr returns current registry", async function () {
    const { rv, registry } = await loadFixture(deployFixture);
    expect(await rv.registryAddr()).to.equal(await registry.getAddress());
  });

  it("upgrade authorization requires admin role", async function () {
    const { rv, other } = await loadFixture(deployFixture);
    await expect(
      rv.connect(other).upgradeToAndCall(ethers.Wallet.createRandom().address, "0x")
    ).to.be.reverted;
  });
});

