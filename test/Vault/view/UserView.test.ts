import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers';
import type {
  UserView,
  MockRegistry,
  MockAccessControlManager,
  MockPositionViewBatch,
  MockHealthViewBatch,
  MockPreviewView,
  MockERC20
} from '../../../types';

const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
const KEY_POSITION_VIEW = ethers.keccak256(ethers.toUtf8Bytes('POSITION_VIEW'));
const KEY_HEALTH_VIEW = ethers.keccak256(ethers.toUtf8Bytes('HEALTH_VIEW'));
const KEY_PREVIEW_VIEW = ethers.keccak256(ethers.toUtf8Bytes('PREVIEW_VIEW'));
const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
const MAX_BATCH_SIZE = 100;

describe('UserView', function () {
  async function deployFixture() {
    const [admin, user, other] = await ethers.getSigners();

    const RegistryF = await ethers.getContractFactory('MockRegistry');
    const registry = (await RegistryF.deploy()) as unknown as MockRegistry;

    const ACMF = await ethers.getContractFactory('MockAccessControlManager');
    const acm = (await ACMF.deploy()) as unknown as MockAccessControlManager;
    await acm.grantRole(ACTION_ADMIN, admin.address);

    const PositionF = await ethers.getContractFactory('MockPositionViewBatch');
    const position = (await PositionF.deploy()) as unknown as MockPositionViewBatch;

    const HealthF = await ethers.getContractFactory('MockHealthViewBatch');
    const health = (await HealthF.deploy()) as unknown as MockHealthViewBatch;

    const PreviewF = await ethers.getContractFactory('MockPreviewView');
    const preview = (await PreviewF.deploy()) as unknown as MockPreviewView;

    const TokenF = await ethers.getContractFactory('MockERC20');
    const token = (await TokenF.deploy(
      'Test Token',
      'TEST',
      ethers.parseUnits('1000000', 18)
    )) as unknown as MockERC20;

    const tokenAddr = await token.getAddress();
    await position.setPosition(user.address, tokenAddr, ethers.parseUnits('100', 18), ethers.parseUnits('40', 18));
    await health.setHealth(user.address, 12_000, true);
    await preview.setPreviewBorrow(user.address, tokenAddr, 12_000, 4_000, ethers.parseUnits('10', 18));
    await preview.setPreviewDeposit(user.address, tokenAddr, 11_000, true);
    await preview.setPreviewRepay(user.address, tokenAddr, 13_000, 3_000);
    await preview.setPreviewWithdraw(user.address, tokenAddr, 10_000, true);

    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(KEY_POSITION_VIEW, await position.getAddress());
    await registry.setModule(KEY_HEALTH_VIEW, await health.getAddress());
    await registry.setModule(KEY_PREVIEW_VIEW, await preview.getAddress());

    const UserViewF = await ethers.getContractFactory('UserView');
    const userView = (await upgrades.deployProxy(UserViewF, [await registry.getAddress()])) as unknown as UserView;

    return { admin, user, other, registry, acm, position, health, preview, token, userView };
  }

  describe('initialize', function () {
    it('reverts on zero registry', async function () {
      const UserViewF = await ethers.getContractFactory('UserView');
      await expect(upgrades.deployProxy(UserViewF, [ethers.ZeroAddress])).to.be.revertedWithCustomError(
        UserViewF,
        'ZeroAddress'
      );
    });

    it('stores registry address', async function () {
      const { userView, registry } = await loadFixture(deployFixture);
      expect(await userView.getRegistry()).to.equal(await registry.getAddress());
    });
  });

  describe('position queries', function () {
    it('returns data from PositionView', async function () {
      const { userView, user, token } = await loadFixture(deployFixture);
      const [c, d] = await userView.getUserPosition(user.address, await token.getAddress());
      expect(c).to.equal(ethers.parseUnits('100', 18));
      expect(d).to.equal(ethers.parseUnits('40', 18));
    });

    it('returns zero when position module missing', async function () {
      const { userView, registry, user, token } = await loadFixture(deployFixture);
      await registry.setModule(KEY_POSITION_VIEW, ethers.ZeroAddress);
      const [c, d] = await userView.getUserPosition(user.address, await token.getAddress());
      expect(c).to.equal(0n);
      expect(d).to.equal(0n);
    });
  });

  describe('health factor', function () {
    it('returns value from HealthView', async function () {
      const { userView, user } = await loadFixture(deployFixture);
      const hf = await userView.getHealthFactor(user.address);
      expect(hf).to.equal(12_000n);
    });

    it('returns zero when health module missing', async function () {
      const { userView, registry, user } = await loadFixture(deployFixture);
      await registry.setModule(KEY_HEALTH_VIEW, ethers.ZeroAddress);
      const hf = await userView.getHealthFactor(user.address);
      expect(hf).to.equal(0n);
    });
  });

  describe('stats aggregation', function () {
    it('calculates stats using view modules', async function () {
      const { userView, user, token } = await loadFixture(deployFixture);
      const stats = await userView.getUserStats(user.address, await token.getAddress());
      expect(stats.collateral).to.equal(ethers.parseUnits('100', 18));
      expect(stats.debt).to.equal(ethers.parseUnits('40', 18));
      expect(stats.hf).to.equal(12_000n);
      expect(stats.ltv).to.be.greaterThan(0n);
    });
  });

  describe('preview calls', function () {
    it('returns preview data when module present', async function () {
      const { userView, user, token } = await loadFixture(deployFixture);
      const [hf, ltv, maxBorrowable] = await userView.previewBorrow(user.address, await token.getAddress(), 0, 0, 0);
      expect(hf).to.equal(12_000n);
      expect(ltv).to.equal(4_000n);
      expect(maxBorrowable).to.equal(ethers.parseUnits('10', 18));
    });

    it('returns zeros when preview module missing', async function () {
      const { userView, registry, user, token } = await loadFixture(deployFixture);
      await registry.setModule(KEY_PREVIEW_VIEW, ethers.ZeroAddress);
      const [hf, ltv, maxBorrowable] = await userView.previewBorrow(user.address, await token.getAddress(), 0, 0, 0);
      expect(hf).to.equal(0n);
      expect(ltv).to.equal(0n);
      expect(maxBorrowable).to.equal(0n);
    });
  });

  describe('batch queries', function () {
    it('returns arrays from position view', async function () {
      const { userView, user, other, token, position } = await loadFixture(deployFixture);
      await position.setPosition(other.address, await token.getAddress(), ethers.parseUnits('1', 18), 0);
      const users = [user.address, other.address];
      const assets = [await token.getAddress(), await token.getAddress()];
      const [collaterals, debts] = await userView.batchGetUserPositions(users, assets);
      expect(collaterals).to.deep.equal([ethers.parseUnits('100', 18), ethers.parseUnits('1', 18)]);
      expect(debts).to.deep.equal([ethers.parseUnits('40', 18), 0n]);
    });

    it('falls back to zero arrays when module missing', async function () {
      const { userView, registry, user, token } = await loadFixture(deployFixture);
      await registry.setModule(KEY_POSITION_VIEW, ethers.ZeroAddress);
      const [collaterals, debts] = await userView.batchGetUserPositions([user.address], [await token.getAddress()]);
      expect(collaterals[0]).to.equal(0n);
      expect(debts[0]).to.equal(0n);
    });

    it('reverts on length mismatch', async function () {
      const { userView, user, token } = await loadFixture(deployFixture);
      await expect(userView.batchGetUserPositions([user.address], [])).to.be.revertedWithCustomError(
        userView,
        'UserView__LengthMismatch'
      );
    });

    it('reverts on oversized batch', async function () {
      const { userView, user, token } = await loadFixture(deployFixture);
      const users = Array(MAX_BATCH_SIZE + 1).fill(user.address);
      const assets = Array(MAX_BATCH_SIZE + 1).fill(await token.getAddress());
      await expect(userView.batchGetUserPositions(users, assets)).to.be.revertedWithCustomError(
        userView,
        'UserView__BatchTooLarge'
      );
    });

    it('returns health factors from module', async function () {
      const { userView, user, other, health } = await loadFixture(deployFixture);
      await health.setHealth(other.address, 9_000, true);
      const factors = await userView.batchGetUserHealthFactors([user.address, other.address]);
      expect(factors).to.deep.equal([12_000n, 9_000n]);
    });

    it('returns zeroed array when health module missing', async function () {
      const { userView, registry, user } = await loadFixture(deployFixture);
      await registry.setModule(KEY_HEALTH_VIEW, ethers.ZeroAddress);
      const factors = await userView.batchGetUserHealthFactors([user.address]);
      expect(factors[0]).to.equal(0n);
    });

    it('reverts on oversized health batch', async function () {
      const { userView, user } = await loadFixture(deployFixture);
      const users = Array(MAX_BATCH_SIZE + 1).fill(user.address);
      await expect(userView.batchGetUserHealthFactors(users)).to.be.revertedWithCustomError(
        userView,
        'UserView__BatchTooLarge'
      );
    });
  });

  describe('upgrade authorization', function () {
    it('requires ACTION_ADMIN role', async function () {
      const { userView, other, acm } = await loadFixture(deployFixture);
      const impl = await (await ethers.getContractFactory('UserView')).deploy();
      await expect(userView.connect(other).upgradeToAndCall(impl.target, '0x')).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('admin can upgrade to a new implementation', async function () {
      const { userView, admin } = await loadFixture(deployFixture);
      const impl = await (await ethers.getContractFactory('UserView')).deploy();
      await expect(userView.connect(admin).upgradeToAndCall(impl.target, '0x')).to.emit(userView, 'Upgraded');
    });
  });
});