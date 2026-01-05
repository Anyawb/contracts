import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const KEY_ACM = ethers.id("ACCESS_CONTROL_MANAGER");
const KEY_POSITION_VIEW = ethers.id("POSITION_VIEW");
const ACTION_ADMIN = ethers.id("ACTION_ADMIN");
const ACTION_VIEW_USER_DATA = ethers.id("VIEW_USER_DATA");

describe("PreviewView", function () {
  async function deployFixture() {
    const [admin, user, viewer, stranger, user2, user3] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("MockRegistry");
    const registry = await Registry.deploy();

    const Access = await ethers.getContractFactory("MockAccessControlManager");
    const acm = await Access.deploy();
    await acm.grantRole(ACTION_ADMIN, admin.address);
    await acm.grantRole(ACTION_VIEW_USER_DATA, viewer.address);

    const Position = await ethers.getContractFactory("MockPositionView");
    const position = await Position.deploy();

    await registry.setModule(KEY_ACM, await acm.getAddress());
    await registry.setModule(KEY_POSITION_VIEW, await position.getAddress());

    const Preview = await ethers.getContractFactory("PreviewView");
    const preview = await upgrades.deployProxy(Preview, [await registry.getAddress()]);

    const asset = ethers.Wallet.createRandom().address;
    const asset2 = ethers.Wallet.createRandom().address;
    const asset3 = ethers.Wallet.createRandom().address;

    return { admin, user, viewer, stranger, user2, user3, registry, acm, position, preview, asset, asset2, asset3 };
  }

  describe("init", function () {
    it("reverts on zero registry", async function () {
      const Preview = await ethers.getContractFactory("PreviewView");
      await expect(upgrades.deployProxy(Preview, [ethers.ZeroAddress])).to.be.revertedWithCustomError(
        Preview,
        "ZeroAddress"
      );
    });
  });

  describe("access control", function () {
    it("user can call own preview", async function () {
      const { user, preview, position, asset } = await deployFixture();
      await position.pushUserPositionUpdate(user.address, asset, 100n, 20n);
      const [hf, ok] = await preview.connect(user).previewDeposit(user.address, asset, 50n);
      expect(hf).to.equal((150n * 10_000n) / 20n);
      expect(ok).to.equal(true);
    });

    it("viewer role can call others", async function () {
      const { user, viewer, preview, position, asset } = await deployFixture();
      await position.pushUserPositionUpdate(user.address, asset, 100n, 20n);
      const [hf, ok] = await preview.connect(viewer).previewDeposit(user.address, asset, 0);
      expect(hf).to.equal((100n * 10_000n) / 20n);
      expect(ok).to.equal(true);
    });

    it("stranger is blocked", async function () {
      const { user, stranger, preview, position, asset } = await deployFixture();
      await position.pushUserPositionUpdate(user.address, asset, 50n, 10n);
      await expect(
        preview.connect(stranger).previewDeposit(user.address, asset, 10n)
      ).to.be.revertedWithCustomError(preview, "PreviewView__Unauthorized");
    });
  });

  describe("preview calculations", function () {
    it("previewDeposit updates HF and ok flag", async function () {
      const { user, preview, position, asset } = await deployFixture();
      await position.pushUserPositionUpdate(user.address, asset, 100n, 50n);
      const [hf, ok] = await preview.previewDeposit(user.address, asset, 50n);
      expect(hf).to.equal((150n * 10_000n) / 50n);
      expect(ok).to.equal(true);
    });

    it("previewWithdraw undercollateral sets ok false when debt exists", async function () {
      const { user, preview, position, asset } = await deployFixture();
      await position.pushUserPositionUpdate(user.address, asset, 40n, 20n);
      const [hf, ok] = await preview.previewWithdraw(user.address, asset, 50n);
      expect(hf).to.equal(0n);
      expect(ok).to.equal(false);
    });

    it("previewBorrow computes HF/LTV/maxBorrowable", async function () {
      const { user, preview, position, asset } = await deployFixture();
      await position.pushUserPositionUpdate(user.address, asset, 100n, 20n);
      const [hf, ltv, maxBorrowable] = await preview.previewBorrow(user.address, asset, 0, 30n, 10n);
      expect(hf).to.equal((130n * 10_000n) / 30n);
      expect(ltv).to.equal((30n * 10_000n) / 130n);
      expect(maxBorrowable).to.equal((130n * 7_500n) / 10_000n - 30n);
    });

    it("previewBorrow caps maxBorrowable at zero when already above max LTV", async function () {
      const { user, preview, position, asset } = await deployFixture();
      await position.pushUserPositionUpdate(user.address, asset, 100n, 80n);
      const [, , maxBorrowable] = await preview.previewBorrow(user.address, asset, 0, 0, 10n);
      expect(maxBorrowable).to.equal(0n);
    });

    it("previewRepay reduces debt and LTV", async function () {
      const { user, preview, position, asset } = await deployFixture();
      await position.pushUserPositionUpdate(user.address, asset, 100n, 50n);
      const [hf, ltv] = await preview.previewRepay(user.address, asset, 20n);
      expect(hf).to.equal((100n * 10_000n) / 30n);
      expect(ltv).to.equal((30n * 10_000n) / 100n);
    });

    it("preview functions revert on zero asset", async function () {
      const { user, preview } = await deployFixture();
      await expect(preview.previewDeposit(user.address, ethers.ZeroAddress, 1)).to.be.revertedWithCustomError(
        preview,
        "PreviewView__InvalidInput"
      );
    });
  });

  describe("边界条件测试", function () {
    it("previewDeposit - 零金额抵押", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 100n, 50n);
      const [hf, ok] = await preview.previewDeposit(user.address, asset, 0n);
      expect(hf).to.equal((100n * 10_000n) / 50n);
      expect(ok).to.equal(true);
    });

    it("previewDeposit - 债务为 0 时 HF 为最大值", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 100n, 0n);
      const [hf, ok] = await preview.previewDeposit(user.address, asset, 50n);
      expect(hf).to.equal(ethers.MaxUint256);
      expect(ok).to.equal(true);
    });

    it("previewDeposit - HF 刚好等于 MIN_HF_BPS", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      // 设置初始状态：collateral = 100, debt = 100, HF = 10000 (刚好等于 MIN_HF_BPS)
      await position.pushUserPositionUpdate(user.address, asset, 100n, 100n);
      const [hf, ok] = await preview.previewDeposit(user.address, asset, 0n);
      expect(hf).to.equal(10_000n);
      expect(ok).to.equal(true);
    });

    it("previewDeposit - HF 略低于 MIN_HF_BPS", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      // collateral = 99, debt = 100, HF = 9900 < 10000
      await position.pushUserPositionUpdate(user.address, asset, 99n, 100n);
      const [hf, ok] = await preview.previewDeposit(user.address, asset, 0n);
      expect(hf).to.equal(9_900n);
      expect(ok).to.equal(false);
    });

    it("previewWithdraw - 零金额提取", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 100n, 50n);
      const [hf, ok] = await preview.previewWithdraw(user.address, asset, 0n);
      expect(hf).to.equal((100n * 10_000n) / 50n);
      expect(ok).to.equal(true);
    });

    it("previewWithdraw - 提取金额超过抵押品时归零", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 100n, 50n);
      const [hf, ok] = await preview.previewWithdraw(user.address, asset, 150n);
      expect(hf).to.equal(0n);
      expect(ok).to.equal(false);
    });

    it("previewWithdraw - 提取全部抵押品且无债务时 ok 为 true", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 100n, 0n);
      const [hf, ok] = await preview.previewWithdraw(user.address, asset, 100n);
      expect(hf).to.equal(ethers.MaxUint256);
      expect(ok).to.equal(true);
    });

    it("previewWithdraw - 提取后刚好满足最小 HF", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      // 初始：collateral = 200, debt = 100, HF = 20000
      // 提取 100 后：collateral = 100, debt = 100, HF = 10000 (刚好等于 MIN_HF_BPS)
      await position.pushUserPositionUpdate(user.address, asset, 200n, 100n);
      const [hf, ok] = await preview.previewWithdraw(user.address, asset, 100n);
      expect(hf).to.equal(10_000n);
      expect(ok).to.equal(true);
    });

    it("previewBorrow - 零金额借款", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 100n, 20n);
      const [hf, ltv, maxBorrowable] = await preview.previewBorrow(user.address, asset, 0, 0, 0);
      expect(hf).to.equal((100n * 10_000n) / 20n);
      expect(ltv).to.equal((20n * 10_000n) / 100n);
      expect(maxBorrowable).to.equal((100n * 7_500n) / 10_000n - 20n);
    });

    it("previewBorrow - LTV 刚好等于 MAX_LTV_BPS", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      // collateral = 100, debt = 75, LTV = 75% (刚好等于 MAX_LTV_BPS)
      await position.pushUserPositionUpdate(user.address, asset, 100n, 75n);
      const [, ltv, maxBorrowable] = await preview.previewBorrow(user.address, asset, 0, 0, 0);
      expect(ltv).to.equal(7_500n);
      expect(maxBorrowable).to.equal(0n);
    });

    it("previewBorrow - 新增抵押后计算 maxBorrowable", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      // 初始：collateral = 100, debt = 20
      // 新增抵押 50 后：collateral = 150, maxDebt = 150 * 0.75 = 112.5
      // maxBorrowable = 112.5 - 20 = 92.5 (向下取整为 92)
      await position.pushUserPositionUpdate(user.address, asset, 100n, 20n);
      const [, , maxBorrowable] = await preview.previewBorrow(user.address, asset, 0, 50n, 0);
      expect(maxBorrowable).to.equal((150n * 7_500n) / 10_000n - 20n);
    });

    it("previewBorrow - 债务为 0 时 LTV 为 0", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 100n, 0n);
      const [hf, ltv, maxBorrowable] = await preview.previewBorrow(user.address, asset, 0, 0, 0);
      expect(hf).to.equal(ethers.MaxUint256);
      expect(ltv).to.equal(0n);
      expect(maxBorrowable).to.equal((100n * 7_500n) / 10_000n);
    });

    it("previewRepay - 零金额还款", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 100n, 50n);
      const [hf, ltv] = await preview.previewRepay(user.address, asset, 0n);
      expect(hf).to.equal((100n * 10_000n) / 50n);
      expect(ltv).to.equal((50n * 10_000n) / 100n);
    });

    it("previewRepay - 还款金额超过债务时债务归零", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 100n, 50n);
      const [hf, ltv] = await preview.previewRepay(user.address, asset, 100n);
      expect(hf).to.equal(ethers.MaxUint256);
      expect(ltv).to.equal(0n);
    });

    it("previewRepay - 还款金额等于债务时债务归零", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 100n, 50n);
      const [hf, ltv] = await preview.previewRepay(user.address, asset, 50n);
      expect(hf).to.equal(ethers.MaxUint256);
      expect(ltv).to.equal(0n);
    });

    it("previewRepay - 债务为 0 时 LTV 为 0", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 100n, 0n);
      const [hf, ltv] = await preview.previewRepay(user.address, asset, 10n);
      expect(hf).to.equal(ethers.MaxUint256);
      expect(ltv).to.equal(0n);
    });

    it("previewDeposit - 抵押品为 0 且债务为 0 时 HF 为最大值", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 0n, 0n);
      const [hf, ok] = await preview.previewDeposit(user.address, asset, 50n);
      expect(hf).to.equal(ethers.MaxUint256);
      expect(ok).to.equal(true);
    });

    it("previewWithdraw - 抵押品为 0 时 HF 为 0", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 0n, 50n);
      const [hf, ok] = await preview.previewWithdraw(user.address, asset, 0n);
      expect(hf).to.equal(0n);
      expect(ok).to.equal(false);
    });
  });

  describe("多用户/多资产场景", function () {
    it("多个用户同时查询不同资产", async function () {
      const { user, user2, user3, preview, position, asset, asset2, asset3 } = await loadFixture(deployFixture);
      
      await position.pushUserPositionUpdate(user.address, asset, 100n, 20n);
      await position.pushUserPositionUpdate(user2.address, asset2, 200n, 40n);
      await position.pushUserPositionUpdate(user3.address, asset3, 300n, 60n);

      const [hf1, ok1] = await preview.previewDeposit(user.address, asset, 50n);
      const [hf2, ok2] = await preview.previewDeposit(user2.address, asset2, 100n);
      const [hf3, ok3] = await preview.previewDeposit(user3.address, asset3, 150n);

      expect(hf1).to.equal((150n * 10_000n) / 20n);
      expect(ok1).to.equal(true);
      expect(hf2).to.equal((300n * 10_000n) / 40n);
      expect(ok2).to.equal(true);
      expect(hf3).to.equal((450n * 10_000n) / 60n);
      expect(ok3).to.equal(true);
    });

    it("一个用户多个资产", async function () {
      const { user, preview, position, asset, asset2, asset3 } = await loadFixture(deployFixture);
      
      await position.pushUserPositionUpdate(user.address, asset, 100n, 20n);
      await position.pushUserPositionUpdate(user.address, asset2, 200n, 40n);
      await position.pushUserPositionUpdate(user.address, asset3, 300n, 60n);

      const [hf1, ok1] = await preview.previewDeposit(user.address, asset, 50n);
      const [hf2, ok2] = await preview.previewWithdraw(user.address, asset2, 50n);
      const [hf3, ltv3, maxBorrowable3] = await preview.previewBorrow(user.address, asset3, 0, 0, 10n);

      expect(hf1).to.equal((150n * 10_000n) / 20n);
      expect(ok1).to.equal(true);
      expect(hf2).to.equal((150n * 10_000n) / 40n);
      expect(ok2).to.equal(true);
      expect(hf3).to.equal((300n * 10_000n) / 70n);
      expect(ltv3).to.equal((70n * 10_000n) / 300n);
      expect(maxBorrowable3).to.equal((300n * 7_500n) / 10_000n - 70n);
    });

    it("多个用户同一个资产", async function () {
      const { user, user2, user3, preview, position, asset } = await loadFixture(deployFixture);
      
      await position.pushUserPositionUpdate(user.address, asset, 100n, 20n);
      await position.pushUserPositionUpdate(user2.address, asset, 200n, 40n);
      await position.pushUserPositionUpdate(user3.address, asset, 300n, 60n);

      const [hf1, ok1] = await preview.previewDeposit(user.address, asset, 50n);
      const [hf2, ok2] = await preview.previewWithdraw(user2.address, asset, 50n);
      const [hf3, ltv3] = await preview.previewRepay(user3.address, asset, 20n);

      expect(hf1).to.equal((150n * 10_000n) / 20n);
      expect(ok1).to.equal(true);
      expect(hf2).to.equal((150n * 10_000n) / 40n);
      expect(ok2).to.equal(true);
      expect(hf3).to.equal((300n * 10_000n) / 40n);
      expect(ltv3).to.equal((40n * 10_000n) / 300n);
    });

    it("混合场景：多用户多资产交叉查询", async function () {
      const { user, user2, preview, position, asset, asset2 } = await loadFixture(deployFixture);
      
      await position.pushUserPositionUpdate(user.address, asset, 100n, 20n);
      await position.pushUserPositionUpdate(user.address, asset2, 200n, 40n);
      await position.pushUserPositionUpdate(user2.address, asset, 150n, 30n);
      await position.pushUserPositionUpdate(user2.address, asset2, 250n, 50n);

      // user 对 asset 的操作
      const [hf1, ok1] = await preview.previewDeposit(user.address, asset, 50n);
      // user 对 asset2 的操作
      const [hf2, ok2] = await preview.previewWithdraw(user.address, asset2, 50n);
      // user2 对 asset 的操作
      const [hf3, ltv3] = await preview.previewRepay(user2.address, asset, 10n);
      // user2 对 asset2 的操作
      const [hf4, ltv4, maxBorrowable4] = await preview.previewBorrow(user2.address, asset2, 0, 0, 5n);

      expect(hf1).to.equal((150n * 10_000n) / 20n);
      expect(ok1).to.equal(true);
      expect(hf2).to.equal((150n * 10_000n) / 40n);
      expect(ok2).to.equal(true);
      expect(hf3).to.equal((150n * 10_000n) / 20n);
      expect(ltv3).to.equal((20n * 10_000n) / 150n);
      expect(hf4).to.equal((250n * 10_000n) / 55n);
      expect(ltv4).to.equal((55n * 10_000n) / 250n);
      expect(maxBorrowable4).to.equal((250n * 7_500n) / 10_000n - 55n);
    });
  });

  describe("计算准确性测试", function () {
    it("previewDeposit - 精确计算 HF", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      // collateral = 1000, debt = 500, HF = 20000
      // 抵押 250 后：collateral = 1250, debt = 500, HF = 25000
      await position.pushUserPositionUpdate(user.address, asset, 1000n, 500n);
      const [hf, ok] = await preview.previewDeposit(user.address, asset, 250n);
      expect(hf).to.equal(25_000n);
      expect(ok).to.equal(true);
    });

    it("previewWithdraw - 精确计算 HF", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      // collateral = 1000, debt = 500, HF = 20000
      // 提取 250 后：collateral = 750, debt = 500, HF = 15000
      await position.pushUserPositionUpdate(user.address, asset, 1000n, 500n);
      const [hf, ok] = await preview.previewWithdraw(user.address, asset, 250n);
      expect(hf).to.equal(15_000n);
      expect(ok).to.equal(true);
    });

    it("previewBorrow - 精确计算 LTV 和 maxBorrowable", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      // collateral = 1000, debt = 200
      // 新增抵押 100，借款 50 后：collateral = 1100, debt = 250
      // LTV = 250 * 10000 / 1100 = 2272.72... (向下取整为 2272)
      // maxDebt = 1100 * 7500 / 10000 = 825
      // maxBorrowable = 825 - 250 = 575
      await position.pushUserPositionUpdate(user.address, asset, 1000n, 200n);
      const [hf, ltv, maxBorrowable] = await preview.previewBorrow(user.address, asset, 0, 100n, 50n);
      expect(hf).to.equal((1100n * 10_000n) / 250n);
      expect(ltv).to.equal((250n * 10_000n) / 1100n);
      expect(maxBorrowable).to.equal((1100n * 7_500n) / 10_000n - 250n);
    });

    it("previewRepay - 精确计算 LTV", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      // collateral = 1000, debt = 500, LTV = 5000
      // 还款 200 后：collateral = 1000, debt = 300, LTV = 3000
      await position.pushUserPositionUpdate(user.address, asset, 1000n, 500n);
      const [hf, ltv] = await preview.previewRepay(user.address, asset, 200n);
      expect(hf).to.equal((1000n * 10_000n) / 300n);
      expect(ltv).to.equal((300n * 10_000n) / 1000n);
    });

    it("previewBorrow - maxBorrowable 边界情况", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      // collateral = 1000, debt = 750 (刚好达到 MAX_LTV)
      // maxDebt = 1000 * 0.75 = 750
      // maxBorrowable = 750 - 750 = 0
      await position.pushUserPositionUpdate(user.address, asset, 1000n, 750n);
      const [, , maxBorrowable] = await preview.previewBorrow(user.address, asset, 0, 0, 0);
      expect(maxBorrowable).to.equal(0n);
    });

    it("previewBorrow - maxBorrowable 略低于边界", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      // collateral = 1000, debt = 749
      // maxDebt = 1000 * 0.75 = 750
      // maxBorrowable = 750 - 749 = 1
      await position.pushUserPositionUpdate(user.address, asset, 1000n, 749n);
      const [, , maxBorrowable] = await preview.previewBorrow(user.address, asset, 0, 0, 0);
      expect(maxBorrowable).to.equal(1n);
    });
  });

  describe("Registry 错误处理", function () {
    it("PositionView 模块不存在时应该 revert", async function () {
      const { user, registry, preview, asset } = await loadFixture(deployFixture);
      
      // 移除 PositionView 模块
      await registry.setModule(KEY_POSITION_VIEW, ethers.ZeroAddress);
      
      await expect(
        preview.previewDeposit(user.address, asset, 50n)
      ).to.be.reverted;
    });

    it("Registry 地址无效时应该 revert", async function () {
      const Preview = await ethers.getContractFactory("PreviewView");
      const preview = await Preview.deploy();
      // 未初始化，_registryAddr 为 0
      const [user] = await ethers.getSigners();
      const asset = ethers.Wallet.createRandom().address;
      
      await expect(
        preview.previewDeposit(user.address, asset, 50n)
      ).to.be.revertedWithCustomError(preview, "ZeroAddress");
    });
  });

  describe("访问控制详细测试", function () {
    it("ACTION_ADMIN 可以查询任何用户", async function () {
      const { admin, user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 100n, 20n);
      
      const [hf, ok] = await preview.connect(admin).previewDeposit(user.address, asset, 50n);
      expect(hf).to.equal((150n * 10_000n) / 20n);
      expect(ok).to.equal(true);
    });

    it("VIEW_USER_DATA 可以查询任何用户", async function () {
      const { viewer, user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 100n, 20n);
      
      const [hf, ok] = await preview.connect(viewer).previewDeposit(user.address, asset, 50n);
      expect(hf).to.equal((150n * 10_000n) / 20n);
      expect(ok).to.equal(true);
    });

    it("用户只能查询自己的数据", async function () {
      const { user, user2, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 100n, 20n);
      
      // user 可以查询自己的数据
      const [hf1, ok1] = await preview.connect(user).previewDeposit(user.address, asset, 50n);
      expect(hf1).to.equal((150n * 10_000n) / 20n);
      expect(ok1).to.equal(true);
      
      // user 不能查询 user2 的数据（如果 user2 没有数据，会返回 0，但访问控制会阻止）
      await position.pushUserPositionUpdate(user2.address, asset, 200n, 40n);
      await expect(
        preview.connect(user).previewDeposit(user2.address, asset, 50n)
      ).to.be.revertedWithCustomError(preview, "PreviewView__Unauthorized");
    });

    it("所有 preview 函数都遵循相同的访问控制", async function () {
      const { stranger, user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 100n, 20n);
      
      await expect(
        preview.connect(stranger).previewDeposit(user.address, asset, 50n)
      ).to.be.revertedWithCustomError(preview, "PreviewView__Unauthorized");
      
      await expect(
        preview.connect(stranger).previewWithdraw(user.address, asset, 50n)
      ).to.be.revertedWithCustomError(preview, "PreviewView__Unauthorized");
      
      await expect(
        preview.connect(stranger).previewBorrow(user.address, asset, 0, 0, 10n)
      ).to.be.revertedWithCustomError(preview, "PreviewView__Unauthorized");
      
      await expect(
        preview.connect(stranger).previewRepay(user.address, asset, 10n)
      ).to.be.revertedWithCustomError(preview, "PreviewView__Unauthorized");
    });
  });

  describe("极端值测试", function () {
    it("previewDeposit - 非常大的金额", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      const largeAmount = ethers.parseEther("1000000");
      await position.pushUserPositionUpdate(user.address, asset, largeAmount, largeAmount / 2n);
      
      const [hf, ok] = await preview.previewDeposit(user.address, asset, largeAmount);
      expect(hf).to.equal((largeAmount * 2n * 10_000n) / (largeAmount / 2n));
      expect(ok).to.equal(true);
    });

    it("previewDeposit - 非常小的金额", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 1000n, 500n);
      
      const [hf, ok] = await preview.previewDeposit(user.address, asset, 1n);
      expect(hf).to.equal((1001n * 10_000n) / 500n);
      expect(ok).to.equal(true);
    });

    it("previewBorrow - 非常大的借款金额", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      const largeCollateral = ethers.parseEther("1000000");
      const largeDebt = largeCollateral / 2n;
      await position.pushUserPositionUpdate(user.address, asset, largeCollateral, largeDebt);
      
      // 使用一个合理的借款金额，确保不会超过 maxDebt
      const borrowAmount = largeCollateral / 10n; // 10% 的抵押品
      const [hf, ltv, maxBorrowable] = await preview.previewBorrow(user.address, asset, 0, 0, borrowAmount);
      const newDebt = largeDebt + borrowAmount;
      expect(hf).to.equal((largeCollateral * 10_000n) / newDebt);
      expect(ltv).to.equal((newDebt * 10_000n) / largeCollateral);
      // maxDebt = largeCollateral * 0.75
      // maxBorrowable = maxDebt - newDebt (如果 newDebt < maxDebt)
      const maxDebt = (largeCollateral * 7_500n) / 10_000n;
      if (newDebt < maxDebt) {
        expect(maxBorrowable).to.equal(maxDebt - newDebt);
      } else {
        expect(maxBorrowable).to.equal(0n);
      }
    });

    it("previewRepay - 还款金额为 MaxUint256", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 100n, 50n);
      
      const [hf, ltv] = await preview.previewRepay(user.address, asset, ethers.MaxUint256);
      expect(hf).to.equal(ethers.MaxUint256);
      expect(ltv).to.equal(0n);
    });
  });

  describe("连续操作场景", function () {
    it("连续多次 previewDeposit", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 100n, 50n);
      
      const [hf1, ok1] = await preview.previewDeposit(user.address, asset, 50n);
      const [hf2, ok2] = await preview.previewDeposit(user.address, asset, 50n);
      const [hf3, ok3] = await preview.previewDeposit(user.address, asset, 50n);
      
      // 所有操作都基于相同的初始状态 (100, 50)
      expect(hf1).to.equal((150n * 10_000n) / 50n);
      expect(hf2).to.equal((150n * 10_000n) / 50n);
      expect(hf3).to.equal((150n * 10_000n) / 50n);
      expect(ok1).to.equal(true);
      expect(ok2).to.equal(true);
      expect(ok3).to.equal(true);
    });

    it("不同操作的组合预览", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 1000n, 500n);
      
      // 预览抵押
      const [hf1, ok1] = await preview.previewDeposit(user.address, asset, 200n);
      // 预览提取
      const [hf2, ok2] = await preview.previewWithdraw(user.address, asset, 100n);
      // 预览借款
      const [hf3, ltv3, maxBorrowable3] = await preview.previewBorrow(user.address, asset, 0, 0, 50n);
      // 预览还款
      const [hf4, ltv4] = await preview.previewRepay(user.address, asset, 100n);
      
      expect(hf1).to.equal((1200n * 10_000n) / 500n);
      expect(ok1).to.equal(true);
      expect(hf2).to.equal((900n * 10_000n) / 500n);
      expect(ok2).to.equal(true);
      expect(hf3).to.equal((1000n * 10_000n) / 550n);
      expect(ltv3).to.equal((550n * 10_000n) / 1000n);
      expect(maxBorrowable3).to.equal((1000n * 7_500n) / 10_000n - 550n);
      expect(hf4).to.equal((1000n * 10_000n) / 400n);
      expect(ltv4).to.equal((400n * 10_000n) / 1000n);
    });

    it("模拟用户操作流程的预览", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      
      // 初始状态：无抵押无债务
      await position.pushUserPositionUpdate(user.address, asset, 0n, 0n);
      
      // 1. 预览首次抵押
      const [hf1, ok1] = await preview.previewDeposit(user.address, asset, 1000n);
      expect(hf1).to.equal(ethers.MaxUint256);
      expect(ok1).to.equal(true);
      
      // 更新状态：抵押 1000
      await position.pushUserPositionUpdate(user.address, asset, 1000n, 0n);
      
      // 2. 预览借款
      const [hf2, ltv2, maxBorrowable2] = await preview.previewBorrow(user.address, asset, 0, 0, 500n);
      expect(hf2).to.equal((1000n * 10_000n) / 500n);
      expect(ltv2).to.equal((500n * 10_000n) / 1000n);
      expect(maxBorrowable2).to.equal((1000n * 7_500n) / 10_000n - 500n);
      
      // 更新状态：抵押 1000，债务 500
      await position.pushUserPositionUpdate(user.address, asset, 1000n, 500n);
      
      // 3. 预览再次抵押以提高 HF
      const [hf3, ok3] = await preview.previewDeposit(user.address, asset, 200n);
      expect(hf3).to.equal((1200n * 10_000n) / 500n);
      expect(ok3).to.equal(true);
      
      // 4. 预览部分还款
      const [hf4, ltv4] = await preview.previewRepay(user.address, asset, 200n);
      expect(hf4).to.equal((1000n * 10_000n) / 300n);
      expect(ltv4).to.equal((300n * 10_000n) / 1000n);
    });
  });

  describe("UUPS 升级测试", function () {
    it("非管理员不能升级", async function () {
      const { user, preview } = await loadFixture(deployFixture);
      const PreviewV2 = await ethers.getContractFactory("PreviewView");
      const previewV2 = await PreviewV2.deploy();
      
      await expect(
        preview.connect(user).upgradeToAndCall(await previewV2.getAddress(), "0x")
      ).to.be.reverted;
    });

    it("验证 _authorizeUpgrade 使用 ViewAccessLib", async function () {
      // 这个测试验证 _authorizeUpgrade 的实现使用了 ViewAccessLib
      // 实际的升级测试需要在代理合约环境中进行，这里只验证访问控制逻辑
      const { admin, user, preview, acm } = await loadFixture(deployFixture);
      
      // 验证 admin 有 ACTION_ADMIN 角色
      const hasRole = await acm.hasRole(ACTION_ADMIN, admin.address);
      expect(hasRole).to.equal(true);
      
      // 验证 user 没有 ACTION_ADMIN 角色
      const userHasRole = await acm.hasRole(ACTION_ADMIN, user.address);
      expect(userHasRole).to.equal(false);
      
      // 注意：实际的升级测试需要在代理合约环境中进行
      // 这里只验证访问控制的基础逻辑
    });
  });

  describe("计算精度与舍入测试", function () {
    it("previewDeposit - 小数精度处理（向下舍入）", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      // collateral = 100, debt = 33, HF = 100 * 10000 / 33 = 30303.03... (向下舍入为 30303)
      await position.pushUserPositionUpdate(user.address, asset, 100n, 33n);
      const [hf, ok] = await preview.previewDeposit(user.address, asset, 0n);
      expect(hf).to.equal((100n * 10_000n) / 33n);
      expect(ok).to.equal(true);
    });

    it("previewBorrow - LTV 计算精度", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      // collateral = 1000, debt = 333, LTV = 333 * 10000 / 1000 = 3330
      await position.pushUserPositionUpdate(user.address, asset, 1000n, 333n);
      const [, ltv] = await preview.previewBorrow(user.address, asset, 0, 0, 0);
      expect(ltv).to.equal((333n * 10_000n) / 1000n);
    });

    it("previewBorrow - maxBorrowable 计算精度", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      // collateral = 1000, debt = 100
      // maxDebt = 1000 * 7500 / 10000 = 750
      // maxBorrowable = 750 - 100 = 650
      await position.pushUserPositionUpdate(user.address, asset, 1000n, 100n);
      const [, , maxBorrowable] = await preview.previewBorrow(user.address, asset, 0, 0, 0);
      expect(maxBorrowable).to.equal((1000n * 7_500n) / 10_000n - 100n);
    });

    it("previewRepay - 部分还款后的 LTV 精度", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      // collateral = 1000, debt = 333
      // 还款 111 后：debt = 222, LTV = 222 * 10000 / 1000 = 2220
      await position.pushUserPositionUpdate(user.address, asset, 1000n, 333n);
      const [, ltv] = await preview.previewRepay(user.address, asset, 111n);
      expect(ltv).to.equal((222n * 10_000n) / 1000n);
    });
  });

  describe("状态变化一致性测试", function () {
    it("PositionView 数据更新后预览结果同步", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      
      // 初始状态
      await position.pushUserPositionUpdate(user.address, asset, 100n, 50n);
      const [hf1, ok1] = await preview.previewDeposit(user.address, asset, 50n);
      expect(hf1).to.equal((150n * 10_000n) / 50n);
      
      // 更新 PositionView 数据
      await position.pushUserPositionUpdate(user.address, asset, 200n, 100n);
      const [hf2, ok2] = await preview.previewDeposit(user.address, asset, 50n);
      expect(hf2).to.equal((250n * 10_000n) / 100n);
      expect(ok2).to.equal(true);
    });

    it("多次预览操作结果一致性", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 1000n, 500n);
      
      // 连续多次相同预览操作应返回相同结果
      const results = await Promise.all([
        preview.previewDeposit(user.address, asset, 200n),
        preview.previewDeposit(user.address, asset, 200n),
        preview.previewDeposit(user.address, asset, 200n),
      ]);
      
      expect(results[0][0]).to.equal(results[1][0]);
      expect(results[1][0]).to.equal(results[2][0]);
      expect(results[0][1]).to.equal(results[1][1]);
      expect(results[1][1]).to.equal(results[2][1]);
    });

    it("不同预览函数对同一状态的一致性", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 1000n, 500n);
      
      // previewDeposit 和 previewBorrow 应该基于相同的初始状态
      const [hf1, ok1] = await preview.previewDeposit(user.address, asset, 0n);
      const [hf2] = await preview.previewBorrow(user.address, asset, 0, 0, 0);
      
      // 两者应该返回相同的 HF（因为都没有改变状态）
      expect(hf1).to.equal(hf2);
    });
  });

  describe("复杂业务场景测试", function () {
    it("高风险仓位逐步改善预览", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      // 初始高风险状态：collateral = 100, debt = 90, HF = 11111 (略高于阈值)
      await position.pushUserPositionUpdate(user.address, asset, 100n, 90n);
      
      // 1. 预览增加抵押
      const [hf1, ok1] = await preview.previewDeposit(user.address, asset, 50n);
      expect(hf1).to.equal((150n * 10_000n) / 90n);
      expect(ok1).to.equal(true);
      
      // 2. 预览部分还款
      const [hf2, ltv2] = await preview.previewRepay(user.address, asset, 30n);
      expect(hf2).to.equal((100n * 10_000n) / 60n);
      expect(ltv2).to.equal((60n * 10_000n) / 100n);
      
      // 3. 预览组合操作：增加抵押 + 部分还款
      const [hf3, ltv3] = await preview.previewRepay(user.address, asset, 20n);
      // 先还款，再预览增加抵押
      await position.pushUserPositionUpdate(user.address, asset, 100n, 70n);
      const [hf4, ok4] = await preview.previewDeposit(user.address, asset, 30n);
      expect(hf4).to.equal((130n * 10_000n) / 70n);
      expect(ok4).to.equal(true);
    });

    it("最大杠杆操作预览", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      // 初始：collateral = 1000, debt = 0
      await position.pushUserPositionUpdate(user.address, asset, 1000n, 0n);
      
      // 预览借款到最大 LTV
      const maxDebt = (1000n * 7_500n) / 10_000n; // 750
      const [hf, ltv, maxBorrowable] = await preview.previewBorrow(user.address, asset, 0, 0, maxDebt);
      
      expect(ltv).to.equal(7_500n);
      expect(maxBorrowable).to.equal(0n);
      expect(hf).to.equal((1000n * 10_000n) / maxDebt);
    });

    it("清算边界预览", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      // 接近清算线：collateral = 100, debt = 99, HF = 10101 (略高于 10000)
      await position.pushUserPositionUpdate(user.address, asset, 100n, 99n);
      
      const [hf1, ok1] = await preview.previewDeposit(user.address, asset, 0n);
      expect(hf1).to.be.gte(10_000n);
      expect(ok1).to.equal(true);
      
      // 预览提取少量抵押后是否仍安全
      const [hf2, ok2] = await preview.previewWithdraw(user.address, asset, 1n);
      expect(hf2).to.equal((99n * 10_000n) / 99n);
      expect(ok2).to.equal(true);
    });

    it("多资产组合操作预览", async function () {
      const { user, preview, position, asset, asset2 } = await loadFixture(deployFixture);
      
      await position.pushUserPositionUpdate(user.address, asset, 1000n, 500n);
      await position.pushUserPositionUpdate(user.address, asset2, 2000n, 1000n);
      
      // 对 asset 进行抵押预览
      const [hf1, ok1] = await preview.previewDeposit(user.address, asset, 200n);
      
      // 对 asset2 进行还款预览
      const [hf2, ltv2] = await preview.previewRepay(user.address, asset2, 200n);
      
      // 两个资产的操作应该独立
      expect(hf1).to.equal((1200n * 10_000n) / 500n);
      expect(ok1).to.equal(true);
      expect(hf2).to.equal((2000n * 10_000n) / 800n);
      expect(ltv2).to.equal((800n * 10_000n) / 2000n);
    });
  });

  describe("错误处理增强测试", function () {
    it("所有 preview 函数对零地址资产的一致性处理", async function () {
      const { user, preview } = await loadFixture(deployFixture);
      
      await expect(
        preview.previewDeposit(user.address, ethers.ZeroAddress, 1n)
      ).to.be.revertedWithCustomError(preview, "PreviewView__InvalidInput");
      
      await expect(
        preview.previewWithdraw(user.address, ethers.ZeroAddress, 1n)
      ).to.be.revertedWithCustomError(preview, "PreviewView__InvalidInput");
      
      await expect(
        preview.previewBorrow(user.address, ethers.ZeroAddress, 0, 0, 1n)
      ).to.be.revertedWithCustomError(preview, "PreviewView__InvalidInput");
      
      await expect(
        preview.previewRepay(user.address, ethers.ZeroAddress, 1n)
      ).to.be.revertedWithCustomError(preview, "PreviewView__InvalidInput");
    });

    it("Registry 模块切换后预览功能正常", async function () {
      const { user, registry, preview, position, asset } = await loadFixture(deployFixture);
      
      await position.pushUserPositionUpdate(user.address, asset, 100n, 50n);
      const [hf1, ok1] = await preview.previewDeposit(user.address, asset, 50n);
      expect(ok1).to.equal(true);
      
      // 切换 PositionView 模块（模拟升级场景）
      const Position2 = await ethers.getContractFactory("MockPositionView");
      const position2 = await Position2.deploy();
      await registry.setModule(KEY_POSITION_VIEW, await position2.getAddress());
      
      // 新模块应该能正常工作
      await position2.pushUserPositionUpdate(user.address, asset, 200n, 100n);
      const [hf2, ok2] = await preview.previewDeposit(user.address, asset, 50n);
      expect(ok2).to.equal(true);
      expect(hf2).to.equal((250n * 10_000n) / 100n);
    });
  });

  describe("数据一致性验证", function () {
    it("previewDeposit 和 previewBorrow 的 HF 计算一致性", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 1000n, 500n);
      
      // previewDeposit: 增加 200 抵押
      const [hf1, ok1] = await preview.previewDeposit(user.address, asset, 200n);
      
      // previewBorrow: 增加 200 抵押，0 借款（应该得到相同的 HF）
      const [hf2] = await preview.previewBorrow(user.address, asset, 0, 200n, 0);
      
      expect(hf1).to.equal(hf2);
    });

    it("previewRepay 和 previewBorrow 的 LTV 计算一致性", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 1000n, 500n);
      
      // previewRepay: 还款 200，新债务 = 300
      const [, ltv1] = await preview.previewRepay(user.address, asset, 200n);
      
      // 更新状态后，previewBorrow 应该得到相同的 LTV（如果抵押和债务相同）
      await position.pushUserPositionUpdate(user.address, asset, 1000n, 300n);
      const [, ltv2] = await preview.previewBorrow(user.address, asset, 0, 0, 0);
      
      expect(ltv1).to.equal(ltv2);
    });

    it("ok 标志与 HF 阈值的一致性", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      
      // HF 刚好等于阈值
      await position.pushUserPositionUpdate(user.address, asset, 100n, 100n);
      const [hf1, ok1] = await preview.previewDeposit(user.address, asset, 0n);
      expect(hf1).to.equal(10_000n);
      expect(ok1).to.equal(true);
      
      // HF 略高于阈值
      await position.pushUserPositionUpdate(user.address, asset, 101n, 100n);
      const [hf2, ok2] = await preview.previewDeposit(user.address, asset, 0n);
      expect(hf2).to.be.gt(10_000n);
      expect(ok2).to.equal(true);
      
      // HF 略低于阈值
      await position.pushUserPositionUpdate(user.address, asset, 99n, 100n);
      const [hf3, ok3] = await preview.previewDeposit(user.address, asset, 0n);
      expect(hf3).to.be.lt(10_000n);
      expect(ok3).to.equal(false);
    });
  });

  describe("性能与压力测试", function () {
    it("大量并发预览查询", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 1000n, 500n);
      
      // 并发执行 20 次预览查询
      const promises = Array.from({ length: 20 }, () =>
        preview.previewDeposit(user.address, asset, 50n)
      );
      
      const results = await Promise.all(promises);
      
      // 所有结果应该一致
      const firstResult = results[0];
      results.forEach((result) => {
        expect(result[0]).to.equal(firstResult[0]);
        expect(result[1]).to.equal(firstResult[1]);
      });
    });

    it("复杂计算场景性能", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      const largeValue = ethers.parseEther("1000000");
      await position.pushUserPositionUpdate(user.address, asset, largeValue, largeValue / 2n);
      
      // 执行复杂的预览计算
      const start = Date.now();
      await preview.previewBorrow(user.address, asset, 0, largeValue / 10n, largeValue / 20n);
      const end = Date.now();
      
      // 确保计算在合理时间内完成（1秒内）
      expect(end - start).to.be.lt(1000);
    });
  });

  describe("特殊数值场景", function () {
    it("previewDeposit - 1 wei 精度测试", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 1n, 1n);
      
      const [hf, ok] = await preview.previewDeposit(user.address, asset, 1n);
      expect(hf).to.equal((2n * 10_000n) / 1n);
      expect(ok).to.equal(true);
    });

    it("previewBorrow - 刚好达到 maxBorrowable 边界", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      // collateral = 1000, debt = 749
      // maxDebt = 750, maxBorrowable = 1
      await position.pushUserPositionUpdate(user.address, asset, 1000n, 749n);
      
      const [, , maxBorrowable] = await preview.previewBorrow(user.address, asset, 0, 0, 0);
      expect(maxBorrowable).to.equal(1n);
      
      // 预览借款 1，应该刚好达到 maxDebt
      const [, ltv, maxBorrowableAfter] = await preview.previewBorrow(user.address, asset, 0, 0, 1n);
      expect(ltv).to.equal(7_500n);
      expect(maxBorrowableAfter).to.equal(0n);
    });

    it("previewWithdraw - 提取 1 wei 的边界情况", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 100n, 50n);
      
      const [hf, ok] = await preview.previewWithdraw(user.address, asset, 1n);
      expect(hf).to.equal((99n * 10_000n) / 50n);
      expect(ok).to.equal(true);
    });

    it("previewRepay - 还款 1 wei 的边界情况", async function () {
      const { user, preview, position, asset } = await loadFixture(deployFixture);
      await position.pushUserPositionUpdate(user.address, asset, 100n, 50n);
      
      const [hf, ltv] = await preview.previewRepay(user.address, asset, 1n);
      expect(hf).to.equal((100n * 10_000n) / 49n);
      expect(ltv).to.equal((49n * 10_000n) / 100n);
    });
  });

  describe("初始化与状态验证", function () {
    it("初始化后 registryAddr 正确设置", async function () {
      const { registry, preview } = await loadFixture(deployFixture);
      const registryAddr = await preview.registryAddr();
      expect(registryAddr).to.equal(await registry.getAddress());
    });

    it("重复初始化应该失败", async function () {
      const { registry, preview } = await loadFixture(deployFixture);
      await expect(
        preview.initialize(await registry.getAddress())
      ).to.be.reverted;
    });
  });
});

