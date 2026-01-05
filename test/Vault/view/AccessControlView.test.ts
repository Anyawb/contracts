import { expect } from 'chai';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { ethers, upgrades } from 'hardhat';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
const ACTION_VIEW_USER_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_USER_DATA'));
const CACHE_DURATION = 5 * 60; // 与 ViewConstants.CACHE_DURATION 保持一致

const PermissionLevel = {
  NONE: 0,
  VIEWER: 1,
  OPERATOR: 2,
  ADMIN: 3,
} as const;

describe('AccessControlView', function () {
  async function deployAccessControlViewFixture() {
    const [deployer, admin, alice, bob, charlie] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
    const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();

    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());

    const AccessControlViewFactory = await ethers.getContractFactory('AccessControlView');
    const accessControlView = await upgrades.deployProxy(AccessControlViewFactory, [await registry.getAddress()], {
      kind: 'uups',
    });

    // 预置：admin 具备最高权限，方便测试 onlyAuthorizedFor
    await acm.setUserPermissionLevel(admin.address, PermissionLevel.ADMIN);

    return { accessControlView, acm, registry, admin, alice, bob, charlie };
  }

  async function pushPermission(
    acm: any,
    view: any,
    user: string,
    actionKey: string,
    hasPermission: boolean
  ) {
    await acm.callPushPermissionUpdate(await view.getAddress(), user, actionKey, hasPermission);
  }

  async function pushPermissionLevel(
    acm: any,
    view: any,
    user: string,
    level: number
  ) {
    await acm.callPushPermissionLevelUpdate(await view.getAddress(), user, level);
  }

  describe('初始化', function () {
    it('应正确记录 ACM 地址', async function () {
      const { accessControlView, acm } = await loadFixture(deployAccessControlViewFixture);
      expect(await accessControlView.getACM()).to.equal(await acm.getAddress());
    });

    it('零地址初始化应被拒绝', async function () {
      const AccessControlViewFactory = await ethers.getContractFactory('AccessControlView');
      await expect(upgrades.deployProxy(AccessControlViewFactory, [ZERO_ADDRESS], { kind: 'uups' })).to.be
        .revertedWithCustomError(AccessControlViewFactory, 'AccessControlView__ZeroAddress');
    });

    it('重复初始化应失败', async function () {
      const { accessControlView, registry } = await loadFixture(deployAccessControlViewFixture);
      await expect(accessControlView.initialize(await registry.getAddress())).to.be.revertedWith(
        'Initializable: contract is already initialized'
      );
    });
  });

  describe('推送与缓存', function () {
    it('仅 ACM 可推送权限位缓存', async function () {
      const { accessControlView, acm, alice } = await loadFixture(deployAccessControlViewFixture);

      await expect(
        accessControlView.connect(alice).pushPermissionUpdate(alice.address, ACTION_VIEW_USER_DATA, true)
      ).to.be.revertedWithCustomError(accessControlView, 'AccessControlView__OnlyACM');

      await pushPermission(acm, accessControlView, alice.address, ACTION_VIEW_USER_DATA, true);
      const [hasPermission, isValid] = await accessControlView.connect(alice).getUserPermission(
        alice.address,
        ACTION_VIEW_USER_DATA
      );
      expect(hasPermission).to.equal(true);
      expect(isValid).to.equal(true);
    });

    it('仅 ACM 可推送权限级别缓存', async function () {
      const { accessControlView, acm, alice } = await loadFixture(deployAccessControlViewFixture);

      await expect(
        accessControlView.connect(alice).pushPermissionLevelUpdate(alice.address, PermissionLevel.OPERATOR)
      ).to.be.revertedWithCustomError(accessControlView, 'AccessControlView__OnlyACM');

      await pushPermissionLevel(acm, accessControlView, alice.address, PermissionLevel.OPERATOR);
      const [level, isValid] = await accessControlView.connect(alice).getUserPermissionLevel(alice.address);
      expect(level).to.equal(PermissionLevel.OPERATOR);
      expect(isValid).to.equal(true);
    });

    it('缓存过期后 isValid 变为 false', async function () {
      const { accessControlView, acm, alice } = await loadFixture(deployAccessControlViewFixture);
      await pushPermission(acm, accessControlView, alice.address, ACTION_VIEW_USER_DATA, true);
      await time.increase(CACHE_DURATION + 1);
      const [, isValid] = await accessControlView.connect(alice).getUserPermission(alice.address, ACTION_VIEW_USER_DATA);
      expect(isValid).to.equal(false);
    });
  });

  describe('只读查询授权', function () {
    it('用户可读取自己的权限缓存', async function () {
      const { accessControlView, acm, alice } = await loadFixture(deployAccessControlViewFixture);
      await pushPermission(acm, accessControlView, alice.address, ACTION_VIEW_USER_DATA, true);
      const [hasPermission] = await accessControlView.connect(alice).getUserPermission(alice.address, ACTION_VIEW_USER_DATA);
      expect(hasPermission).to.equal(true);
    });

    it('非管理员读取他人缓存将 revert', async function () {
      const { accessControlView, acm, alice, bob } = await loadFixture(deployAccessControlViewFixture);
      await pushPermission(acm, accessControlView, alice.address, ACTION_VIEW_USER_DATA, true);
      await expect(
        accessControlView.connect(bob).getUserPermission(alice.address, ACTION_VIEW_USER_DATA)
      ).to.be.revertedWithCustomError(accessControlView, 'AccessControlView__Unauthorized');
    });

    it('管理员可读取任何用户缓存', async function () {
      const { accessControlView, acm, admin, alice } = await loadFixture(deployAccessControlViewFixture);
      await pushPermission(acm, accessControlView, alice.address, ACTION_VIEW_USER_DATA, true);
      await expect(accessControlView.connect(admin).getUserPermission(alice.address, ACTION_VIEW_USER_DATA)).to.not.be
        .reverted;
    });
  });

  describe('权限级别缓存', function () {
    it('应返回最新的权限级别', async function () {
      const { accessControlView, acm, alice } = await loadFixture(deployAccessControlViewFixture);
      await pushPermissionLevel(acm, accessControlView, alice.address, PermissionLevel.VIEWER);
      const [level] = await accessControlView.connect(alice).getUserPermissionLevel(alice.address);
      expect(level).to.equal(PermissionLevel.VIEWER);
    });
  });

  describe('辅助函数', function () {
    it('getACM 返回 Registry 中的 AccessControlManager', async function () {
      const { accessControlView, acm } = await loadFixture(deployAccessControlViewFixture);
      expect(await accessControlView.getACM()).to.equal(await acm.getAddress());
    });

    it('registryAddr 返回初始化时的 Registry 地址', async function () {
      const { accessControlView, registry } = await loadFixture(deployAccessControlViewFixture);
      expect(await accessControlView.registryAddr()).to.equal(await registry.getAddress());
    });
  });
});
