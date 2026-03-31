import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import { ModuleKeys } from "../../../frontend-config/moduleKeys";

describe("LiquidationPayoutManager", function () {
  const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes("SET_PARAMETER"));

  async function deployFixture() {
    const [admin, other] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory("MockRegistry")).deploy();
    const acm = await (await ethers.getContractFactory("MockAccessControlManager")).deploy();
    await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, await acm.getAddress());
    await acm.grantRole(ACTION_SET_PARAMETER, admin.address);

    const recipients = {
      platform: admin.address,
      reserve: admin.address,
      lenderCompensation: admin.address,
    };
    const rates = {
      platformBps: 3000,
      reserveBps: 2000,
      lenderBps: 1000,
      liquidatorBps: 4000,
    };

    const Payout = await ethers.getContractFactory("LiquidationPayoutManager");
    const payout = await upgrades.deployProxy(
      Payout,
      [await registry.getAddress(), await acm.getAddress(), recipients, rates],
      { kind: "uups", initializer: "initialize" }
    );

    return { admin, other, registry, acm, payout, recipients, rates };
  }

  it("initializes with valid registry and config", async function () {
    const { payout, registry, recipients, rates } = await loadFixture(deployFixture);

    expect(await payout.registryAddrVar()).to.equal(await registry.getAddress());
    const recipientsResult = await payout.getRecipients();
    expect(recipientsResult.platform).to.equal(recipients.platform);
    expect(recipientsResult.reserve).to.equal(recipients.reserve);
    expect(recipientsResult.lenderCompensation).to.equal(recipients.lenderCompensation);

    const ratesResult = await payout.getRates();
    expect(ratesResult.platformBps).to.equal(BigInt(rates.platformBps));
    expect(ratesResult.reserveBps).to.equal(BigInt(rates.reserveBps));
    expect(ratesResult.lenderBps).to.equal(BigInt(rates.lenderBps));
    expect(ratesResult.liquidatorBps).to.equal(BigInt(rates.liquidatorBps));
  });

  it("reverts on access control mismatch", async function () {
    const [admin] = await ethers.getSigners();
    const registry = await (await ethers.getContractFactory("MockRegistry")).deploy();
    const acm = await (await ethers.getContractFactory("MockAccessControlManager")).deploy();
    const otherAcm = await (await ethers.getContractFactory("MockAccessControlManager")).deploy();

    await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, await acm.getAddress());

    const recipients = {
      platform: admin.address,
      reserve: admin.address,
      lenderCompensation: admin.address,
    };
    const rates = {
      platformBps: 2500,
      reserveBps: 2500,
      lenderBps: 2500,
      liquidatorBps: 2500,
    };

    const Payout = await ethers.getContractFactory("LiquidationPayoutManager");
    await expect(
      upgrades.deployProxy(Payout, [await registry.getAddress(), await otherAcm.getAddress(), recipients, rates], {
        kind: "uups",
        initializer: "initialize",
      })
    ).to.be.revertedWithCustomError(Payout, "LiquidationPayoutManager__AccessControlMismatch");
  });

  it("rejects invalid rate sums", async function () {
    const [admin] = await ethers.getSigners();
    const registry = await (await ethers.getContractFactory("MockRegistry")).deploy();
    const acm = await (await ethers.getContractFactory("MockAccessControlManager")).deploy();

    const recipients = {
      platform: admin.address,
      reserve: admin.address,
      lenderCompensation: admin.address,
    };
    const badRates = {
      platformBps: 1000,
      reserveBps: 1000,
      lenderBps: 1000,
      liquidatorBps: 1000,
    };

    const Payout = await ethers.getContractFactory("LiquidationPayoutManager");
    await expect(
      upgrades.deployProxy(Payout, [await registry.getAddress(), await acm.getAddress(), recipients, badRates], {
        kind: "uups",
        initializer: "initialize",
      })
    ).to.be.revertedWithCustomError(Payout, "LiquidationPayoutManager__InvalidRates");
  });

  it("updateConfig requires ACTION_SET_PARAMETER", async function () {
    const { payout, other, recipients, rates, acm } = await loadFixture(deployFixture);

    const nextRecipients = {
      platform: other.address,
      reserve: other.address,
      lenderCompensation: other.address,
    };
    const nextRates = { ...rates };

    await expect(payout.connect(other).updateConfig(nextRecipients, nextRates))
      .to.be.revertedWithCustomError(acm, "MissingRole");
  });

  it("updateRecipients rejects zero addresses and emits update", async function () {
    const { payout, admin, recipients, rates } = await loadFixture(deployFixture);

    await expect(
      payout.updateRecipients({ platform: ethers.ZeroAddress, reserve: recipients.reserve, lenderCompensation: recipients.lenderCompensation })
    ).to.be.revertedWithCustomError(payout, "ZeroAddress");

    const nextRecipients = {
      platform: admin.address,
      reserve: ethers.Wallet.createRandom().address,
      lenderCompensation: ethers.Wallet.createRandom().address,
    };

    await expect(payout.updateRecipients(nextRecipients))
      .to.emit(payout, "PayoutConfigUpdated")
      .withArgs(
        [nextRecipients.platform, nextRecipients.reserve, nextRecipients.lenderCompensation],
        [
          BigInt(rates.platformBps),
          BigInt(rates.reserveBps),
          BigInt(rates.lenderBps),
          BigInt(rates.liquidatorBps),
        ]
      );
  });

  it("updateRates rejects invalid sum and emits update", async function () {
    const { payout, rates } = await loadFixture(deployFixture);

    await expect(payout.updateRates({ ...rates, liquidatorBps: 0 }))
      .to.be.revertedWithCustomError(payout, "LiquidationPayoutManager__InvalidRates");

    const nextRates = {
      platformBps: 1000,
      reserveBps: 2000,
      lenderBps: 3000,
      liquidatorBps: 4000,
    };

    await expect(payout.updateRates(nextRates))
      .to.emit(payout, "PayoutConfigUpdated");
  });

  it("calculateShares assigns remainder to liquidator", async function () {
    const { payout } = await loadFixture(deployFixture);
    await payout.updateRates({ platformBps: 3333, reserveBps: 3333, lenderBps: 3333, liquidatorBps: 1 });

    const [platformShare, reserveShare, lenderShare, liquidatorShare] = await payout.calculateShares(101);
    expect(platformShare).to.equal(33n);
    expect(reserveShare).to.equal(33n);
    expect(lenderShare).to.equal(33n);
    expect(liquidatorShare).to.equal(2n);
  });
});
