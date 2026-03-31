import { expect } from 'chai';
import { loadFixture, mine } from '@nomicfoundation/hardhat-network-helpers';
import { ethers, upgrades } from 'hardhat';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
const ACTION_VIEW_USER_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_USER_DATA'));
const CACHE_DURATION_BLOCKS = 150; // 与 ViewConstants.CACHE_DURATION_BLOCKS 保持一致

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

    // Scheme U read gating is role-based (VIEW_USER_DATA or ADMIN).
    // Pre-grant ADMIN role to `admin` so it can read other users' cached data.
    await acm.grantRole(ACTION_ADMIN, admin.address);

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
        .revertedWithCustomError(AccessControlViewFactory, 'ZeroAddress');
    });

    it('重复初始化应失败', async function () {
      const { accessControlView, registry } = await loadFixture(deployAccessControlViewFixture);
      await expect(accessControlView.initialize(await registry.getAddress())).to.be.revertedWithCustomError(
        accessControlView,
        'InvalidInitialization'
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
      const [hasPermission, isValid] = await accessControlView.connect(alice).getUserPermissionWithMeta(
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
      const [level, isValid] = await accessControlView.connect(alice).getUserPermissionLevelWithMeta(alice.address);
      expect(level).to.equal(PermissionLevel.OPERATOR);
      expect(isValid).to.equal(true);
    });

    it('缓存过期后 isValid 变为 false', async function () {
      const { accessControlView, acm, alice } = await loadFixture(deployAccessControlViewFixture);
      await pushPermission(acm, accessControlView, alice.address, ACTION_VIEW_USER_DATA, true);
      await mine(CACHE_DURATION_BLOCKS + 1);
      const [, isValid] = await accessControlView
        .connect(alice)
        .getUserPermissionWithMeta(alice.address, ACTION_VIEW_USER_DATA);
      expect(isValid).to.equal(false);
    });
  });

  describe('只读查询授权', function () {
    it('用户可读取自己的权限缓存', async function () {
      const { accessControlView, acm, alice } = await loadFixture(deployAccessControlViewFixture);
      await pushPermission(acm, accessControlView, alice.address, ACTION_VIEW_USER_DATA, true);
      const [hasPermission] = await accessControlView
        .connect(alice)
        .getUserPermissionWithMeta(alice.address, ACTION_VIEW_USER_DATA);
      expect(hasPermission).to.equal(true);
    });

    it('用户读取自己权限缓存不需要 VIEW_USER_DATA 角色（Scheme U self-read）', async function () {
      const { accessControlView, acm, alice } = await loadFixture(deployAccessControlViewFixture);
      await pushPermission(acm, accessControlView, alice.address, ACTION_VIEW_USER_DATA, true);

      // Ensure caller has no viewer/admin roles; self-read must still work.
      await acm.revokeRole(ACTION_VIEW_USER_DATA, alice.address);
      await acm.revokeRole(ACTION_ADMIN, alice.address);

      const [hasPermission] = await accessControlView
        .connect(alice)
        .getUserPermissionWithMeta(alice.address, ACTION_VIEW_USER_DATA);
      expect(hasPermission).to.equal(true);
    });

    it('非管理员读取他人缓存将 revert', async function () {
      const { accessControlView, acm, alice, bob } = await loadFixture(deployAccessControlViewFixture);
      await pushPermission(acm, accessControlView, alice.address, ACTION_VIEW_USER_DATA, true);
      await expect(
        accessControlView.connect(bob).getUserPermissionWithMeta(alice.address, ACTION_VIEW_USER_DATA)
      ).to.be.revertedWithCustomError(accessControlView, 'MissingRole');
    });

    it('拥有 VIEW_USER_DATA 角色可读取他人缓存（Scheme U ops read）', async function () {
      const { accessControlView, acm, alice, bob } = await loadFixture(deployAccessControlViewFixture);
      await pushPermission(acm, accessControlView, alice.address, ACTION_VIEW_USER_DATA, true);

      await acm.grantRole(ACTION_VIEW_USER_DATA, bob.address);

      const [hasPermission] = await accessControlView
        .connect(bob)
        .getUserPermissionWithMeta(alice.address, ACTION_VIEW_USER_DATA);
      expect(hasPermission).to.equal(true);
    });

    it('管理员可读取任何用户缓存', async function () {
      const { accessControlView, acm, admin, alice } = await loadFixture(deployAccessControlViewFixture);
      await pushPermission(acm, accessControlView, alice.address, ACTION_VIEW_USER_DATA, true);
      await expect(accessControlView.connect(admin).getUserPermissionWithMeta(alice.address, ACTION_VIEW_USER_DATA)).to.not.be
        .reverted;
    });
  });

  describe('权限级别缓存', function () {
    it('应返回最新的权限级别', async function () {
      const { accessControlView, acm, alice } = await loadFixture(deployAccessControlViewFixture);
      await pushPermissionLevel(acm, accessControlView, alice.address, PermissionLevel.VIEWER);
      const [level] = await accessControlView.connect(alice).getUserPermissionLevelWithMeta(alice.address);
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
      expect(await accessControlView.registryAddrVar()).to.equal(await registry.getAddress());
    });
  });

  describe('SSOT callsite assertions (trap ACM)', function () {
    it('user-dimensional gate MUST use hasRole (must not call ACM.requireRole)', async function () {
      const [, admin, alice, bob] = await ethers.getSigners();

      const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
      const acm = await (await ethers.getContractFactory('MockAccessControlManagerTrapRequireRole')).deploy();
      await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());

      const AccessControlViewFactory = await ethers.getContractFactory('AccessControlView');
      const accessControlView = await upgrades.deployProxy(AccessControlViewFactory, [await registry.getAddress()], {
        kind: 'uups',
      });

      // Non-self + no roles should be rejected by the view without touching ACM.requireRole().
      await expect(accessControlView.connect(bob).getUserPermissionWithMeta(alice.address, ACTION_VIEW_USER_DATA)).to.be
        .revertedWithCustomError(accessControlView, 'MissingRole');
    });
  });
});
