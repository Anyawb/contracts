import { expect } from "chai";
import { ethers } from "hardhat";

describe("AssetDecimalMath", function () {
  async function deployHarness() {
    const factory = await ethers.getContractFactory("TestAssetDecimalMath");
    const harness = await factory.deploy();
    await harness.waitForDeployment();
    return harness;
  }

  it("应在相同 decimals 下保持原值", async function () {
    const harness = await deployHarness();
    const value = 123456789n;

    expect(await harness.rescale(value, 6, 6)).to.equal(value);
  });

  it("应支持 6 -> 18 精度放大", async function () {
    const harness = await deployHarness();
    const value = 100n * 10n ** 6n;

    expect(await harness.rescale(value, 6, 18)).to.equal(100n * 10n ** 18n);
  });

  it("应支持 18 -> 6 精度缩小", async function () {
    const harness = await deployHarness();
    const value = 1000n * 10n ** 18n;

    expect(await harness.rescale(value, 18, 6)).to.equal(1000n * 10n ** 6n);
  });

  it("应支持连续缩放 6 -> 8 -> 18", async function () {
    const harness = await deployHarness();
    const start = 123n * 10n ** 6n;
    const mid = await harness.rescale(start, 6, 8);
    const end = await harness.rescale(mid, 8, 18);

    expect(mid).to.equal(123n * 10n ** 8n);
    expect(end).to.equal(123n * 10n ** 18n);
  });

  it("应在降精度时支持显式向上取整", async function () {
    const harness = await deployHarness();

    expect(await harness.rescaleDown(1000001n, 6, 3)).to.equal(1000n);
    expect(await harness.rescaleUp(1000001n, 6, 3)).to.equal(1001n);
  });

  it("应按资产 decimals 计算 6 位资产 value", async function () {
    const harness = await deployHarness();
    const amountBaseUnits = 150n * 10n ** 6n;
    const priceUsd = 1n * 10n ** 6n;

    expect(await harness.calcValue(amountBaseUnits, priceUsd, 6)).to.equal(150n * 10n ** 6n);
  });

  it("应按资产 decimals 计算 18 位资产 value", async function () {
    const harness = await deployHarness();
    const amountBaseUnits = 5n * 10n ** 17n;
    const priceUsd = 2000n * 10n ** 18n;

    expect(await harness.calcValue(amountBaseUnits, priceUsd, 18)).to.equal(1000n * 10n ** 18n);
  });

  it("应支持 value -> amount 反推", async function () {
    const harness = await deployHarness();
    const valueUsd = 1000n * 10n ** 18n;
    const priceUsd = 2000n * 10n ** 18n;

    expect(await harness.calcAmountFromValue(valueUsd, priceUsd, 18)).to.equal(5n * 10n ** 17n);
  });

  it("normalizeValue 应与 rescale 一致", async function () {
    const harness = await deployHarness();
    const valueUsd = 777n * 10n ** 6n;

    expect(await harness.normalizeValue(valueUsd, 6, 18)).to.equal(777n * 10n ** 18n);
  });

  it("normalizeValueUp 应在降精度时向上取整", async function () {
    const harness = await deployHarness();

    expect(await harness.normalizeValueDown(1000001n, 6, 3)).to.equal(1000n);
    expect(await harness.normalizeValueUp(1000001n, 6, 3)).to.equal(1001n);
  });

  it("应在极小值缩小时向下取整", async function () {
    const harness = await deployHarness();

    expect(await harness.rescale(1n, 18, 6)).to.equal(0n);
  });

  it("应锁定非整除 amount -> value -> amount 的向下损失语义", async function () {
    const harness = await deployHarness();
    const amountBaseUnits = 3n;
    const priceUsd = 500000n;

    const valueUsd = await harness.calcValue(amountBaseUnits, priceUsd, 6);
    const amountRoundTrip = await harness.calcAmountFromValue(valueUsd, priceUsd, 6);

    expect(valueUsd).to.equal(1n);
    expect(amountRoundTrip).to.equal(2n);
  });

  it("应锁定非整除 value -> amount -> value 的向下损失语义", async function () {
    const harness = await deployHarness();
    const valueUsd = 5n;
    const priceUsd = 2000001n;

    const amountBaseUnits = await harness.calcAmountFromValue(valueUsd, priceUsd, 6);
    const valueRoundTrip = await harness.calcValue(amountBaseUnits, priceUsd, 6);

    expect(amountBaseUnits).to.equal(2n);
    expect(valueRoundTrip).to.equal(4n);
  });

  it("price 为 0 时 calcAmountFromValue 应回滚", async function () {
    const harness = await deployHarness();
    const txPromise = harness.calcAmountFromValue(1n, 0n, 6);

    await expect(txPromise).to.be.revertedWithCustomError(harness, "DivisionByZero");
  });

  it("当 exponent 超过安全边界时应回滚", async function () {
    const harness = await deployHarness();
    const txPromise = harness.rescale(1n, 0, 78);

    await expect(txPromise).to.be.revertedWithCustomError(harness, "AssetDecimalMath__ExponentTooHigh").withArgs(78, 77);
  });
});