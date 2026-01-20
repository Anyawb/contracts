/**
 * 多资产组合操作综合测试
 * 
 * 测试目标：
 * - 测试多个用户、多个资产在不同 View 模块中的组合操作
 * - 验证跨模块数据一致性
 * - 测试批量查询功能
 * - 验证预览功能在多资产场景下的正确性
 * - 测试健康因子、风险分析等综合指标
 */

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const KEY_ACM = ethers.id("ACCESS_CONTROL_MANAGER");
const KEY_POSITION_VIEW = ethers.id("POSITION_VIEW");
const KEY_PREVIEW_VIEW = ethers.id("PREVIEW_VIEW");
const KEY_USER_VIEW = ethers.id("USER_VIEW");
const KEY_HEALTH_VIEW = ethers.id("HEALTH_VIEW");
const KEY_SYSTEM_VIEW = ethers.id("SYSTEM_VIEW");
const KEY_STATISTICS_VIEW = ethers.id("STATISTICS_VIEW");
const KEY_LIQUIDATOR_VIEW = ethers.id("LIQUIDATOR_VIEW");
const KEY_RISK_VIEW = ethers.id("RISK_VIEW");
const KEY_CM = ethers.id("COLLATERAL_MANAGER");
const KEY_LE = ethers.id("LENDING_ENGINE");

const ACTION_ADMIN = ethers.id("ACTION_ADMIN");
const ACTION_VIEW_USER_DATA = ethers.id("VIEW_USER_DATA");
const ACTION_VIEW_SYSTEM_DATA = ethers.id("VIEW_SYSTEM_DATA");
const ACTION_VIEW_PUSH = ethers.id("ACTION_VIEW_PUSH");

describe("多资产组合操作综合测试 - Multi-Asset Integration", function () {
  async function deployFixture() {
    const [admin, user1, user2, user3, viewer, liquidator] = await ethers.getSigners();

    // 部署 Registry
    const Registry = await ethers.getContractFactory("MockRegistry");
    const registry = await Registry.deploy();

    // 部署 AccessControlManager
    const Access = await ethers.getContractFactory("MockAccessControlManager");
    const acm = await Access.deploy();
    await acm.grantRole(ACTION_ADMIN, admin.address);
    await acm.grantRole(ACTION_VIEW_USER_DATA, viewer.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, viewer.address);
    await acm.grantRole(ACTION_VIEW_PUSH, admin.address);

    // 部署 PositionView
    const Position = await ethers.getContractFactory("MockPositionView");
    const position = await Position.deploy();

    // 部署 PreviewView（使用代理避免初始化冲突）
    const Preview = await ethers.getContractFactory("PreviewView");
    const preview = await upgrades.deployProxy(Preview, [await registry.getAddress()]);

    // 部署 HealthView（使用代理）
    const Health = await ethers.getContractFactory("HealthView");
    const health = await upgrades.deployProxy(Health, [await registry.getAddress()]);

    // 部署 UserView（使用代理）
    const User = await ethers.getContractFactory("UserView");
    const userView = await upgrades.deployProxy(User, [await registry.getAddress()]);

    // 注册所有模块到 Registry
    await registry.setModule(KEY_ACM, await acm.getAddress());
    await registry.setModule(KEY_POSITION_VIEW, await position.getAddress());
    await registry.setModule(KEY_PREVIEW_VIEW, await preview.getAddress());
    await registry.setModule(KEY_USER_VIEW, await userView.getAddress());
    await registry.setModule(KEY_HEALTH_VIEW, await health.getAddress());
    await registry.setModule(KEY_CM, admin.address);
    await registry.setModule(KEY_LE, admin.address);

    // 授权推送权限
    await acm.grantRole(ACTION_VIEW_PUSH, await position.getAddress());
    await acm.grantRole(ACTION_VIEW_PUSH, await health.getAddress());

    // 创建多个测试资产
    const asset1 = ethers.Wallet.createRandom().address;
    const asset2 = ethers.Wallet.createRandom().address;
    const asset3 = ethers.Wallet.createRandom().address;

    return {
      admin,
      user1,
      user2,
      user3,
      viewer,
      liquidator,
      registry,
      acm,
      position,
      preview,
      health,
      userView,
      asset1,
      asset2,
      asset3,
    };
  }

  describe("多用户多资产基础查询", function () {
    it("应该能够查询多个用户在不同资产上的仓位", async function () {
      const { user1, user2, user3, position, asset1, asset2, asset3 } = await loadFixture(deployFixture);

      // 设置用户1的仓位：asset1
      await position.pushUserPositionUpdate(user1.address, asset1, 1000n, 500n);
      // 设置用户2的仓位：asset2
      await position.pushUserPositionUpdate(user2.address, asset2, 2000n, 1000n);
      // 设置用户3的仓位：asset3
      await position.pushUserPositionUpdate(user3.address, asset3, 3000n, 1500n);

      // 查询所有仓位
      const [c1, d1] = await position.getUserPosition(user1.address, asset1);
      const [c2, d2] = await position.getUserPosition(user2.address, asset2);
      const [c3, d3] = await position.getUserPosition(user3.address, asset3);

      expect(c1).to.equal(1000n);
      expect(d1).to.equal(500n);
      expect(c2).to.equal(2000n);
      expect(d2).to.equal(1000n);
      expect(c3).to.equal(3000n);
      expect(d3).to.equal(1500n);
    });

    it("应该能够查询一个用户在多个资产上的仓位", async function () {
      const { user1, position, asset1, asset2, asset3 } = await loadFixture(deployFixture);

      // 用户1在三个资产上都有仓位
      await position.pushUserPositionUpdate(user1.address, asset1, 1000n, 500n);
      await position.pushUserPositionUpdate(user1.address, asset2, 2000n, 800n);
      await position.pushUserPositionUpdate(user1.address, asset3, 3000n, 1200n);

      const [c1, d1] = await position.getUserPosition(user1.address, asset1);
      const [c2, d2] = await position.getUserPosition(user1.address, asset2);
      const [c3, d3] = await position.getUserPosition(user1.address, asset3);

      expect(c1).to.equal(1000n);
      expect(d1).to.equal(500n);
      expect(c2).to.equal(2000n);
      expect(d2).to.equal(800n);
      expect(c3).to.equal(3000n);
      expect(d3).to.equal(1200n);
    });

    it("应该能够查询多个用户在同一资产上的仓位", async function () {
      const { user1, user2, user3, position, asset1 } = await loadFixture(deployFixture);

      // 三个用户都在 asset1 上有仓位
      await position.pushUserPositionUpdate(user1.address, asset1, 1000n, 500n);
      await position.pushUserPositionUpdate(user2.address, asset1, 2000n, 1000n);
      await position.pushUserPositionUpdate(user3.address, asset1, 3000n, 1500n);

      const [c1, d1] = await position.getUserPosition(user1.address, asset1);
      const [c2, d2] = await position.getUserPosition(user2.address, asset1);
      const [c3, d3] = await position.getUserPosition(user3.address, asset1);

      expect(c1).to.equal(1000n);
      expect(d1).to.equal(500n);
      expect(c2).to.equal(2000n);
      expect(d2).to.equal(1000n);
      expect(c3).to.equal(3000n);
      expect(d3).to.equal(1500n);
    });
  });

  describe("多资产预览操作", function () {
    it("应该能够预览用户在不同资产上的操作", async function () {
      const { user1, preview, position, asset1, asset2, asset3 } = await loadFixture(deployFixture);

      // 设置初始仓位
      await position.pushUserPositionUpdate(user1.address, asset1, 1000n, 500n);
      await position.pushUserPositionUpdate(user1.address, asset2, 2000n, 800n);
      await position.pushUserPositionUpdate(user1.address, asset3, 3000n, 1200n);

      // 预览 asset1 的抵押操作
      const [hf1, ok1] = await preview.previewDeposit(user1.address, asset1, 200n);
      expect(hf1).to.equal((1200n * 10_000n) / 500n);
      expect(ok1).to.equal(true);

      // 预览 asset2 的提取操作
      const [hf2, ok2] = await preview.previewWithdraw(user1.address, asset2, 300n);
      expect(hf2).to.equal((1700n * 10_000n) / 800n);
      expect(ok2).to.equal(true);

      // 预览 asset3 的借款操作
      const [hf3, ltv3, maxBorrowable3] = await preview.previewBorrow(user1.address, asset3, 0, 0, 100n);
      expect(hf3).to.equal((3000n * 10_000n) / 1300n);
      expect(ltv3).to.equal((1300n * 10_000n) / 3000n);
      expect(maxBorrowable3).to.equal((3000n * 7_500n) / 10_000n - 1300n);
    });

    it("应该能够预览跨资产的操作组合", async function () {
      const { user1, preview, position, asset1, asset2 } = await loadFixture(deployFixture);

      await position.pushUserPositionUpdate(user1.address, asset1, 1000n, 500n);
      await position.pushUserPositionUpdate(user1.address, asset2, 2000n, 800n);

      // 场景：在 asset1 上增加抵押，在 asset2 上提取抵押
      const [hf1, ok1] = await preview.previewDeposit(user1.address, asset1, 200n);
      const [hf2, ok2] = await preview.previewWithdraw(user1.address, asset2, 300n);

      // 两个资产的操作应该独立计算
      expect(hf1).to.equal((1200n * 10_000n) / 500n);
      expect(ok1).to.equal(true);
      expect(hf2).to.equal((1700n * 10_000n) / 800n);
      expect(ok2).to.equal(true);
    });

    it("应该能够预览多资产的风险改善策略", async function () {
      const { user1, preview, position, asset1, asset2, asset3 } = await loadFixture(deployFixture);

      // 设置高风险仓位：所有资产的 HF 都接近阈值
      await position.pushUserPositionUpdate(user1.address, asset1, 100n, 99n); // HF ≈ 10101
      await position.pushUserPositionUpdate(user1.address, asset2, 200n, 199n); // HF ≈ 10050
      await position.pushUserPositionUpdate(user1.address, asset3, 300n, 299n); // HF ≈ 10033

      // 策略1：在 asset1 上增加抵押
      const [hf1, ok1] = await preview.previewDeposit(user1.address, asset1, 50n);
      expect(hf1).to.equal((150n * 10_000n) / 99n);
      expect(ok1).to.equal(true);

      // 策略2：在 asset2 上还款
      const [hf2, ltv2] = await preview.previewRepay(user1.address, asset2, 50n);
      expect(hf2).to.equal((200n * 10_000n) / 149n);
      expect(ltv2).to.equal((149n * 10_000n) / 200n);

      // 策略3：在 asset3 上组合操作：增加抵押 + 部分还款
      const [hf3, ltv3] = await preview.previewRepay(user1.address, asset3, 50n);
      expect(hf3).to.equal((300n * 10_000n) / 249n);
      expect(ltv3).to.equal((249n * 10_000n) / 300n);
    });
  });

  describe("多资产健康因子查询", function () {
    it("应该能够查询多个用户的健康因子", async function () {
      const { user1, user2, user3, health, position, asset1 } = await loadFixture(deployFixture);

      // 设置仓位并推送健康因子
      await position.pushUserPositionUpdate(user1.address, asset1, 1000n, 500n);
      await health.pushHealthFactor(user1.address, 20_000n); // HF = 200%

      await position.pushUserPositionUpdate(user2.address, asset1, 2000n, 1000n);
      await health.pushHealthFactor(user2.address, 20_000n); // HF = 200%

      await position.pushUserPositionUpdate(user3.address, asset1, 3000n, 2000n);
      await health.pushHealthFactor(user3.address, 15_000n); // HF = 150%

      const [hf1, valid1] = await health.getUserHealthFactor(user1.address);
      const [hf2, valid2] = await health.getUserHealthFactor(user2.address);
      const [hf3, valid3] = await health.getUserHealthFactor(user3.address);

      expect(hf1).to.equal(20_000n);
      expect(valid1).to.equal(true);
      expect(hf2).to.equal(20_000n);
      expect(valid2).to.equal(true);
      expect(hf3).to.equal(15_000n);
      expect(valid3).to.equal(true);
    });

    it("应该能够通过 UserView 查询多资产用户的健康因子", async function () {
      const { user1, userView, health, position, asset1, asset2 } = await loadFixture(deployFixture);

      await position.pushUserPositionUpdate(user1.address, asset1, 1000n, 500n);
      await position.pushUserPositionUpdate(user1.address, asset2, 2000n, 800n);
      await health.pushHealthFactor(user1.address, 18_000n);

      const hf = await userView.connect(user1).getHealthFactor(user1.address);
      expect(hf).to.equal(18_000n);
    });
  });

  describe("多资产批量查询", function () {
    it("应该能够批量查询多个用户多个资产的仓位", async function () {
      const { user1, user2, position, asset1, asset2 } = await loadFixture(deployFixture);

      await position.pushUserPositionUpdate(user1.address, asset1, 1000n, 500n);
      await position.pushUserPositionUpdate(user1.address, asset2, 2000n, 800n);
      await position.pushUserPositionUpdate(user2.address, asset1, 1500n, 600n);
      await position.pushUserPositionUpdate(user2.address, asset2, 2500n, 1000n);

      // 批量查询
      const users = [user1.address, user1.address, user2.address, user2.address];
      const assets = [asset1, asset2, asset1, asset2];

      // 使用 PositionView 的批量查询（如果存在）
      // 这里我们模拟批量查询，实际调用单个查询
      const results = await Promise.all([
        position.getUserPosition(users[0], assets[0]),
        position.getUserPosition(users[1], assets[1]),
        position.getUserPosition(users[2], assets[2]),
        position.getUserPosition(users[3], assets[3]),
      ]);

      expect(results[0][0]).to.equal(1000n); // user1, asset1, collateral
      expect(results[0][1]).to.equal(500n); // user1, asset1, debt
      expect(results[1][0]).to.equal(2000n); // user1, asset2, collateral
      expect(results[1][1]).to.equal(800n); // user1, asset2, debt
      expect(results[2][0]).to.equal(1500n); // user2, asset1, collateral
      expect(results[2][1]).to.equal(600n); // user2, asset1, debt
      expect(results[3][0]).to.equal(2500n); // user2, asset2, collateral
      expect(results[3][1]).to.equal(1000n); // user2, asset2, debt
    });
  });

  describe("多资产组合操作预览", function () {
    it("应该能够预览复杂的多资产操作组合", async function () {
      const { user1, preview, position, asset1, asset2, asset3 } = await loadFixture(deployFixture);

      // 初始状态：用户1在三个资产上都有仓位
      await position.pushUserPositionUpdate(user1.address, asset1, 1000n, 500n);
      await position.pushUserPositionUpdate(user1.address, asset2, 2000n, 800n);
      await position.pushUserPositionUpdate(user1.address, asset3, 3000n, 1200n);

      // 复杂操作组合：
      // 1. 在 asset1 上增加抵押
      const [hf1, ok1] = await preview.previewDeposit(user1.address, asset1, 200n);
      // 2. 在 asset2 上提取抵押
      const [hf2, ok2] = await preview.previewWithdraw(user1.address, asset2, 300n);
      // 3. 在 asset3 上借款
      const [hf3, ltv3, maxBorrowable3] = await preview.previewBorrow(user1.address, asset3, 0, 0, 100n);
      // 4. 在 asset1 上还款
      const [hf4, ltv4] = await preview.previewRepay(user1.address, asset1, 100n);

      // 验证所有预览结果
      expect(hf1).to.equal((1200n * 10_000n) / 500n);
      expect(ok1).to.equal(true);
      expect(hf2).to.equal((1700n * 10_000n) / 800n);
      expect(ok2).to.equal(true);
      expect(hf3).to.equal((3000n * 10_000n) / 1300n);
      expect(ltv3).to.equal((1300n * 10_000n) / 3000n);
      expect(hf4).to.equal((1000n * 10_000n) / 400n);
      expect(ltv4).to.equal((400n * 10_000n) / 1000n);
    });

    it("应该能够预览多资产的风险分散策略", async function () {
      const { user1, preview, position, asset1, asset2, asset3 } = await loadFixture(deployFixture);

      // 初始状态：高风险集中在 asset1
      await position.pushUserPositionUpdate(user1.address, asset1, 100n, 99n); // HF ≈ 10101
      await position.pushUserPositionUpdate(user1.address, asset2, 2000n, 500n); // HF = 40000
      await position.pushUserPositionUpdate(user1.address, asset3, 3000n, 600n); // HF = 50000

      // 风险分散策略：
      // 1. 从 asset2 提取部分抵押
      const [hf2, ok2] = await preview.previewWithdraw(user1.address, asset2, 500n);
      // 2. 将提取的抵押增加到 asset1
      const [hf1, ok1] = await preview.previewDeposit(user1.address, asset1, 500n);

      // 验证风险改善
      expect(hf1).to.equal((600n * 10_000n) / 99n);
      expect(ok1).to.equal(true);
      expect(hf2).to.equal((1500n * 10_000n) / 500n);
      expect(ok2).to.equal(true);
    });
  });

  describe("跨模块数据一致性", function () {
    it("PositionView 和 PreviewView 应该返回一致的数据", async function () {
      const { user1, position, preview, asset1 } = await loadFixture(deployFixture);

      await position.pushUserPositionUpdate(user1.address, asset1, 1000n, 500n);

      // PositionView 查询
      const [c1, d1] = await position.getUserPosition(user1.address, asset1);

      // PreviewView 预览（不改变状态）
      const [hf, ok] = await preview.previewDeposit(user1.address, asset1, 0n);

      // 验证 HF 计算基于正确的仓位数据
      expect(hf).to.equal((c1 * 10_000n) / d1);
      expect(ok).to.equal(true);
    });

    it("多个 View 模块应该能够独立查询同一用户的多资产数据", async function () {
      const { user1, position, preview, userView, asset1, asset2 } = await loadFixture(deployFixture);

      await position.pushUserPositionUpdate(user1.address, asset1, 1000n, 500n);
      await position.pushUserPositionUpdate(user1.address, asset2, 2000n, 800n);

      // PositionView 查询
      const [c1, d1] = await position.getUserPosition(user1.address, asset1);
      const [c2, d2] = await position.getUserPosition(user1.address, asset2);

      // PreviewView 预览
      const [hf1] = await preview.previewDeposit(user1.address, asset1, 0n);
      const [hf2] = await preview.previewDeposit(user1.address, asset2, 0n);

      // UserView 查询（通过 PositionView）
      const [c1_uv, d1_uv] = await userView.connect(user1).getUserPosition(user1.address, asset1);
      const [c2_uv, d2_uv] = await userView.connect(user1).getUserPosition(user1.address, asset2);

      // 验证数据一致性
      expect(c1).to.equal(c1_uv);
      expect(d1).to.equal(d1_uv);
      expect(c2).to.equal(c2_uv);
      expect(d2).to.equal(d2_uv);
      expect(hf1).to.equal((c1 * 10_000n) / d1);
      expect(hf2).to.equal((c2 * 10_000n) / d2);
    });
  });

  describe("多资产状态更新与查询", function () {
    it("应该能够处理多资产状态的连续更新", async function () {
      const { user1, position, preview, asset1, asset2 } = await loadFixture(deployFixture);

      // 初始状态
      await position.pushUserPositionUpdate(user1.address, asset1, 1000n, 500n);
      await position.pushUserPositionUpdate(user1.address, asset2, 2000n, 800n);

      // 第一次预览
      const [hf1_1] = await preview.previewDeposit(user1.address, asset1, 200n);
      const [hf2_1] = await preview.previewDeposit(user1.address, asset2, 300n);

      // 更新 asset1 的状态
      await position.pushUserPositionUpdate(user1.address, asset1, 1200n, 500n);

      // 第二次预览（asset1 状态已更新）
      const [hf1_2] = await preview.previewDeposit(user1.address, asset1, 200n);
      const [hf2_2] = await preview.previewDeposit(user1.address, asset2, 300n);

      // asset1 的 HF 应该变化（因为基础状态变了）
      expect(hf1_1).to.not.equal(hf1_2);
      // asset2 的 HF 应该不变（因为基础状态没变）
      expect(hf2_1).to.equal(hf2_2);
    });
  });

  describe("多资产边界情况", function () {
    it("应该能够处理一个资产为零仓位的情况", async function () {
      const { user1, position, preview, asset1, asset2 } = await loadFixture(deployFixture);

      // asset1 有仓位，asset2 为零仓位
      await position.pushUserPositionUpdate(user1.address, asset1, 1000n, 500n);
      await position.pushUserPositionUpdate(user1.address, asset2, 0n, 0n);

      // 查询 asset1
      const [c1, d1] = await position.getUserPosition(user1.address, asset1);
      expect(c1).to.equal(1000n);
      expect(d1).to.equal(500n);

      // 查询 asset2（零仓位）
      const [c2, d2] = await position.getUserPosition(user1.address, asset2);
      expect(c2).to.equal(0n);
      expect(d2).to.equal(0n);

      // 预览 asset2 的首次抵押
      const [hf2, ok2] = await preview.previewDeposit(user1.address, asset2, 100n);
      expect(hf2).to.equal(ethers.MaxUint256);
      expect(ok2).to.equal(true);
    });

    it("应该能够处理部分资产达到最大 LTV 的情况", async function () {
      const { user1, position, preview, asset1, asset2 } = await loadFixture(deployFixture);

      // asset1 达到最大 LTV (75%)
      await position.pushUserPositionUpdate(user1.address, asset1, 1000n, 750n);
      // asset2 未达到最大 LTV
      await position.pushUserPositionUpdate(user1.address, asset2, 2000n, 1000n);

      // 预览 asset1 的借款（应该 maxBorrowable = 0）
      const [, , maxBorrowable1] = await preview.previewBorrow(user1.address, asset1, 0, 0, 0);
      expect(maxBorrowable1).to.equal(0n);

      // 预览 asset2 的借款（应该还有额度）
      const [, , maxBorrowable2] = await preview.previewBorrow(user1.address, asset2, 0, 0, 0);
      expect(maxBorrowable2).to.be.gt(0n);
    });
  });

  describe("多资产性能测试", function () {
    it("应该能够高效处理大量资产的查询", async function () {
      const { user1, position, preview, asset1, asset2, asset3 } = await loadFixture(deployFixture);

      // 设置多个资产
      await position.pushUserPositionUpdate(user1.address, asset1, 1000n, 500n);
      await position.pushUserPositionUpdate(user1.address, asset2, 2000n, 800n);
      await position.pushUserPositionUpdate(user1.address, asset3, 3000n, 1200n);

      // 并发查询多个资产
      const start = Date.now();
      const results = await Promise.all([
        preview.previewDeposit(user1.address, asset1, 100n),
        preview.previewDeposit(user1.address, asset2, 200n),
        preview.previewDeposit(user1.address, asset3, 300n),
        preview.previewWithdraw(user1.address, asset1, 50n),
        preview.previewWithdraw(user1.address, asset2, 100n),
        preview.previewBorrow(user1.address, asset1, 0, 0, 50n),
        preview.previewBorrow(user1.address, asset2, 0, 0, 100n),
        preview.previewRepay(user1.address, asset1, 25n),
        preview.previewRepay(user1.address, asset2, 50n),
      ]);
      const end = Date.now();

      // 验证所有查询都成功
      expect(results.length).to.equal(9);
      // 验证性能（应该在合理时间内完成）
      expect(end - start).to.be.lt(5000); // 5秒内
    });
  });
});

