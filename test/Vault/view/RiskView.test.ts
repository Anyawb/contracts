import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const KEY_ACM = ethers.keccak256(ethers.toUtf8Bytes("ACCESS_CONTROL_MANAGER"));
const KEY_HEALTH_VIEW = ethers.keccak256(ethers.toUtf8Bytes("HEALTH_VIEW"));
const KEY_LE = ethers.keccak256(ethers.toUtf8Bytes("LENDING_ENGINE"));
const KEY_POSITION_VIEW = ethers.keccak256(ethers.toUtf8Bytes("POSITION_VIEW"));
const KEY_GUARANTEE_FUND = ethers.keccak256(ethers.toUtf8Bytes("GUARANTEE_FUND_MANAGER"));
const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes("ACTION_ADMIN"));
const ACTION_VIEW_USER_DATA = ethers.keccak256(ethers.toUtf8Bytes("VIEW_USER_DATA"));

describe("RiskView", function () {
  async function deployFixture() {
    const [admin, user, other] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("MockRegistry");
    const registry = await Registry.deploy();

    const ACM = await ethers.getContractFactory("MockAccessControlManager");
    const acm = await ACM.deploy();

    const HealthView = await ethers.getContractFactory("MockHealthViewLite");
    const hv = await HealthView.deploy();

    const DebtTotals = await ethers.getContractFactory("MockDebtTotals");
    const le = await DebtTotals.deploy(); // debt (getUserTotalDebtValue)
    const PVTotals = await ethers.getContractFactory("MockPositionViewValuation");
    const pv = await PVTotals.deploy(); // collateral (PositionView valuation)

    const Guarantee = await ethers.getContractFactory("MockGuaranteeFund");
    const gf = await Guarantee.deploy();

    await registry.setModule(KEY_ACM, await acm.getAddress());
    await registry.setModule(KEY_HEALTH_VIEW, await hv.getAddress());
    await registry.setModule(KEY_LE, await le.getAddress());
    await registry.setModule(KEY_POSITION_VIEW, await pv.getAddress());
    await registry.setModule(KEY_GUARANTEE_FUND, await gf.getAddress());

    await acm.grantRole(ACTION_ADMIN, admin.address);
    await acm.grantRole(ACTION_VIEW_USER_DATA, admin.address);

    const RiskView = await ethers.getContractFactory("RiskView");
    const rv = (await upgrades.deployProxy(RiskView, [await registry.getAddress()], { kind: "uups" })) as any;

    return { admin, user, other, registry, acm, hv, le, pv, gf, rv };
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
    expect(res.isValid).to.equal(true);
  });

  it("getUserRiskAssessment returns warning when HF between 100% and 110%", async function () {
    const { hv, rv, user } = await loadFixture(deployFixture);
    await hv.setHealth(user.address, 10_500, true); // bps
    const res = await rv.getUserRiskAssessment(user.address);
    expect(res.liquidatable).to.equal(false);
    expect(res.warningLevel).to.equal(1);
    expect(res.isValid).to.equal(true);
  });

  it("getUserRiskAssessment returns none when HF >= 110%", async function () {
    const { hv, rv, user } = await loadFixture(deployFixture);
    await hv.setHealth(user.address, 12_000, true); // bps
    const res = await rv.getUserRiskAssessment(user.address);
    expect(res.liquidatable).to.equal(false);
    expect(res.warningLevel).to.equal(0);
    expect(res.isValid).to.equal(true);
  });

  it("getUserRiskAssessment falls back to default when invalid", async function () {
    const { hv, rv, user } = await loadFixture(deployFixture);
    await hv.setHealth(user.address, 0, false);
    const res = await rv.getUserRiskAssessment(user.address);
    expect(res.healthFactor).to.equal(10_000);
    expect(res.liquidatable).to.equal(false);
    expect(res.isValid).to.equal(false);
    expect(res.blockNumber).to.equal(0n);
  });

  it("batchGetRiskAssessments enforces max batch size", async function () {
    const { rv } = await loadFixture(deployFixture);
    const tooMany = Array.from({ length: 101 }, () => ethers.Wallet.createRandom().address);
    await expect(rv.batchGetRiskAssessments(tooMany)).to.be.revertedWithCustomError(rv, "BatchTooLarge");
  });

  it("calculateHealthFactorExcludingGuarantee uses totals and guarantee", async function () {
    const { rv, le, pv, gf, user } = await loadFixture(deployFixture);
    await le.setTotal(user.address, 100); // debt
    await pv.setTotal(user.address, 200); // collateral
    const asset = ethers.Wallet.createRandom().address;
    await gf.setLocked(user.address, asset, 50); // guarantee
    const [hf] = await rv.calculateHealthFactorExcludingGuarantee(user.address, asset);
    expect(hf).to.equal(15000);
  });

  it("upgrade authorization requires admin role", async function () {
    const { rv, other } = await loadFixture(deployFixture);
    await expect(
      rv.connect(other).upgradeToAndCall(ethers.Wallet.createRandom().address, "0x")
    ).to.be.reverted;
  });

  describe("ARCH 4.xx RV-01/RV-02/RV-03: responsibility boundary, batch limit, permission consistency", function () {
    it("RV-01: exposes no push* functions and no business-writable entrypoints", async function () {
      const { rv } = await loadFixture(deployFixture);
      const funcFragments = rv.interface.fragments.filter((f: any) => f.type === "function");
      const names: string[] = funcFragments.map((f: any) => f.name);

      expect(names.some((n) => n.toLowerCase().startsWith("push"))).to.equal(false);

      const writable = funcFragments.filter((f: any) => !["view", "pure"].includes(String(f.stateMutability)));
      const writableNames = Array.from(new Set(writable.map((f: any) => f.name))) as string[];
      const allowed = new Set(["initialize", "upgradeTo", "upgradeToAndCall"]);
      expect(writableNames.every((n) => allowed.has(n))).to.equal(true);
    });

    it("RV-02: batch upper bound is enforced", async function () {
      const { rv } = await loadFixture(deployFixture);
      const tooMany = Array.from({ length: 101 }, () => ethers.Wallet.createRandom().address);
      await expect(rv.batchGetRiskAssessments(tooMany)).to.be.revertedWithCustomError(rv, "BatchTooLarge");
    });

    it("RV-03: Scheme U gates (self allowed; non-self and batch require VIEW_USER_DATA/ADMIN)", async function () {
      const { rv, user, other, acm } = await loadFixture(deployFixture);

      // self-read allowed without roles
      await expect(rv.connect(other).getUserRiskAssessment(other.address)).to.not.be.reverted;

      // non-self should revert MissingRole()
      await expect(rv.connect(other).getUserRiskAssessment(user.address)).to.be.revertedWithCustomError(
        rv,
        "MissingRole"
      );

      // batch has no self-bypass
      await expect(rv.connect(other).batchGetRiskAssessments([other.address])).to.be.revertedWithCustomError(
        rv,
        "MissingRole"
      );

      await acm.grantRole(ACTION_VIEW_USER_DATA, other.address);

      const a = await rv.connect(other).getUserRiskAssessment(user.address);
      expect(a.healthFactor).to.be.a("bigint");
    });
  });
});

