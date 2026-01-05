import { expect } from 'chai';
import * as hardhat from 'hardhat';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
const { ethers, upgrades } = hardhat;
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import type { ViewCache, MockAccessControlManager, MockRegistry } from '../../../types';

const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
const ACTION_VIEW_SYSTEM_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_SYSTEM_DATA'));
const MAX_BATCH_SIZE = 100n; // ViewConstants.MAX_BATCH_SIZE
const CACHE_DURATION = 5 * 60; // ViewConstants.CACHE_DURATION = 5 minutes

describe('ViewCache – system snapshot cache (view layer)', function () {
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let viewCache: ViewCache;
  let registry: MockRegistry;
  let acm: MockAccessControlManager;
  let ASSET: string;

  async function deployFixture() {
    [owner, alice] = await ethers.getSigners();
    ASSET = ethers.Wallet.createRandom().address;

    const MockAccessControlManagerF = await ethers.getContractFactory('MockAccessControlManager');
    acm = await MockAccessControlManagerF.deploy();

    const MockRegistryF = await ethers.getContractFactory('MockRegistry');
    registry = await MockRegistryF.deploy();

    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());

    const ViewCacheF = await ethers.getContractFactory('ViewCache');
    viewCache = await upgrades.deployProxy(ViewCacheF, [await registry.getAddress()], { kind: 'uups' });

    await acm.grantRole(ACTION_ADMIN, owner.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, owner.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, await viewCache.getAddress());

    return { owner, alice, viewCache, registry, acm, ASSET };
  }

  beforeEach(async function () {
    ({ owner, alice, viewCache, registry, acm, ASSET } = await deployFixture());
  });

  describe('初始化', function () {
    it('应拒绝零地址初始化', async function () {
      const ViewCacheF = await ethers.getContractFactory('ViewCache');
      await expect(upgrades.deployProxy(ViewCacheF, [ethers.ZeroAddress], { kind: 'uups' })).to.be.revertedWithCustomError(
        ViewCacheF,
        'ViewCache__ZeroAddress'
      );
    });

    it('应记录 registry 地址且 getter 一致', async function () {
      expect(await viewCache.registryAddr()).to.equal(await registry.getAddress());
      expect(await viewCache.registryAddrVar()).to.equal(await registry.getAddress());
    });
  });

  describe('权限与写入', function () {
    it('无 VIEW_SYSTEM_DATA 权限调用 setSystemStatus 应被拒绝', async function () {
      await expect(viewCache.connect(alice).setSystemStatus(ASSET, 1, 2, 3)).to.be.revertedWith('Insufficient permissions');
    });

    it('无 ADMIN 权限调用 clearSystemCache 应被拒绝', async function () {
      await expect(viewCache.connect(alice).clearSystemCache(ASSET)).to.be.revertedWith('Insufficient permissions');
    });

    it('asset 为零地址应 revert', async function () {
      await expect(viewCache.connect(owner).setSystemStatus(ethers.ZeroAddress, 1, 2, 3)).to.be.revertedWithCustomError(
        viewCache,
        'ViewCache__InvalidCacheData'
      );
    });

    it('应成功写入并返回有效快照', async function () {
      await viewCache.connect(owner).setSystemStatus(ASSET, 1000n, 500n, 1_000_000_000_000_000_000n);
      const [status, isValid] = await viewCache.getSystemStatus(ASSET);
      expect(status.totalCollateral).to.equal(1000n);
      expect(status.totalDebt).to.equal(500n);
      expect(status.utilizationRate).to.equal(1_000_000_000_000_000_000n);
      expect(isValid).to.equal(true);
    });

    it('应支持零值输入', async function () {
      await viewCache.connect(owner).setSystemStatus(ASSET, 0n, 0n, 0n);
      const [status, isValid] = await viewCache.getSystemStatus(ASSET);
      expect(status.totalCollateral).to.equal(0n);
      expect(status.totalDebt).to.equal(0n);
      expect(status.utilizationRate).to.equal(0n);
      expect(isValid).to.equal(true);
    });

    it('应支持极大值输入', async function () {
      const maxUint256 = ethers.MaxUint256;
      await viewCache.connect(owner).setSystemStatus(ASSET, maxUint256, maxUint256, maxUint256);
      const [status, isValid] = await viewCache.getSystemStatus(ASSET);
      expect(status.totalCollateral).to.equal(maxUint256);
      expect(status.totalDebt).to.equal(maxUint256);
      expect(status.utilizationRate).to.equal(maxUint256);
      expect(isValid).to.equal(true);
    });

    it('应支持覆盖已存在的缓存', async function () {
      await viewCache.connect(owner).setSystemStatus(ASSET, 100n, 50n, 1000n);
      await viewCache.connect(owner).setSystemStatus(ASSET, 200n, 100n, 2000n);
      const [status, isValid] = await viewCache.getSystemStatus(ASSET);
      expect(status.totalCollateral).to.equal(200n);
      expect(status.totalDebt).to.equal(100n);
      expect(status.utilizationRate).to.equal(2000n);
      expect(isValid).to.equal(true);
    });

    it('应正确记录时间戳', async function () {
      const tx = await viewCache.connect(owner).setSystemStatus(ASSET, 100n, 50n, 1000n);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);
      const [status] = await viewCache.getSystemStatus(ASSET);
      expect(status.timestamp).to.equal(block!.timestamp);
    });

    it('应正确设置 isValid 标志', async function () {
      await viewCache.connect(owner).setSystemStatus(ASSET, 100n, 50n, 1000n);
      const [status] = await viewCache.getSystemStatus(ASSET);
      expect(status.isValid).to.equal(true);
    });
  });

  describe('缓存有效期', function () {
    it('超过 CACHE_DURATION 后应被视为无效', async function () {
      await viewCache.connect(owner).setSystemStatus(ASSET, 1, 2, 3);
      await ethers.provider.send('evm_increaseTime', [CACHE_DURATION + 1]);
      await ethers.provider.send('evm_mine', []);
      const [, isValid] = await viewCache.getSystemStatus(ASSET);
      expect(isValid).to.equal(false);
    });

    it('正好在 CACHE_DURATION 边界应仍有效', async function () {
      await viewCache.connect(owner).setSystemStatus(ASSET, 1, 2, 3);
      await ethers.provider.send('evm_increaseTime', [CACHE_DURATION]);
      await ethers.provider.send('evm_mine', []);
      const [, isValid] = await viewCache.getSystemStatus(ASSET);
      expect(isValid).to.equal(true);
    });

    it('未写入的资产应返回无效', async function () {
      const uninitializedAsset = ethers.Wallet.createRandom().address;
      const [status, isValid] = await viewCache.getSystemStatus(uninitializedAsset);
      expect(status.totalCollateral).to.equal(0n);
      expect(status.totalDebt).to.equal(0n);
      expect(status.utilizationRate).to.equal(0n);
      expect(status.timestamp).to.equal(0n);
      expect(status.isValid).to.equal(false);
      expect(isValid).to.equal(false);
    });

    it('时间戳为0的缓存应无效', async function () {
      // 通过清理缓存创建时间戳为0的状态
      await viewCache.connect(owner).setSystemStatus(ASSET, 1, 2, 3);
      await viewCache.connect(owner).clearSystemCache(ASSET);
      const [, isValid] = await viewCache.getSystemStatus(ASSET);
      expect(isValid).to.equal(false);
    });
  });

  describe('清理缓存', function () {
    it('清理后应返回无效快照', async function () {
      await viewCache.connect(owner).setSystemStatus(ASSET, 10, 5, 123);
      await viewCache.connect(owner).clearSystemCache(ASSET);
      const [status, isValid] = await viewCache.getSystemStatus(ASSET);
      expect(status.totalCollateral).to.equal(0);
      expect(status.totalDebt).to.equal(0);
      expect(status.utilizationRate).to.equal(0);
      expect(isValid).to.equal(false);
    });

    it('清理不存在的缓存不应报错', async function () {
      const uninitializedAsset = ethers.Wallet.createRandom().address;
      await expect(viewCache.connect(owner).clearSystemCache(uninitializedAsset)).to.not.be.reverted;
      const [status, isValid] = await viewCache.getSystemStatus(uninitializedAsset);
      expect(status.totalCollateral).to.equal(0n);
      expect(isValid).to.equal(false);
    });

    it('清理后可以重新写入', async function () {
      await viewCache.connect(owner).setSystemStatus(ASSET, 10, 5, 123);
      await viewCache.connect(owner).clearSystemCache(ASSET);
      await viewCache.connect(owner).setSystemStatus(ASSET, 20, 10, 456);
      const [status, isValid] = await viewCache.getSystemStatus(ASSET);
      expect(status.totalCollateral).to.equal(20n);
      expect(status.totalDebt).to.equal(10n);
      expect(status.utilizationRate).to.equal(456n);
      expect(isValid).to.equal(true);
    });

    it('清理应更新时间戳', async function () {
      await viewCache.connect(owner).setSystemStatus(ASSET, 10, 5, 123);
      const tx = await viewCache.connect(owner).clearSystemCache(ASSET);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);
      const [status] = await viewCache.getSystemStatus(ASSET);
      // 清理后时间戳应该被删除（为0），但事件中会记录清理时间
      expect(status.timestamp).to.equal(0n);
    });
  });

  describe('批量读取', function () {
    it('空数组应 revert', async function () {
      await expect(viewCache.connect(owner).batchGetSystemStatus([])).to.be.revertedWithCustomError(viewCache, 'ViewCache__EmptyArray');
    });

    it('超过批量上限应 revert', async function () {
      const oversized = Array(Number(MAX_BATCH_SIZE) + 1).fill(ASSET);
      await expect(viewCache.connect(owner).batchGetSystemStatus(oversized)).to.be.revertedWithCustomError(
        viewCache,
        'ViewCache__BatchTooLarge'
      );
    });

    it('应返回批量快照与有效标记', async function () {
      const asset2 = ethers.Wallet.createRandom().address;
      await viewCache.connect(owner).setSystemStatus(ASSET, 10, 1, 100);
      await viewCache.connect(owner).setSystemStatus(asset2, 20, 2, 200);

      const [statuses, validFlags] = await viewCache.connect(owner).batchGetSystemStatus([ASSET, asset2]);
      expect(statuses.length).to.equal(2);
      expect(validFlags.length).to.equal(2);
      expect(statuses[0].totalCollateral).to.equal(10);
      expect(statuses[1].totalCollateral).to.equal(20);
      expect(validFlags[0]).to.equal(true);
      expect(validFlags[1]).to.equal(true);
    });

    it('应处理最大批量大小（100个资产）', async function () {
      const assets = Array(Number(MAX_BATCH_SIZE)).fill(null).map(() => ethers.Wallet.createRandom().address);
      // 为所有资产设置缓存
      for (let i = 0; i < assets.length; i++) {
        await viewCache.connect(owner).setSystemStatus(assets[i], BigInt(i + 1) * 100n, BigInt(i + 1) * 50n, BigInt(i + 1) * 10n);
      }
      const [statuses, validFlags] = await viewCache.connect(owner).batchGetSystemStatus(assets);
      expect(statuses.length).to.equal(Number(MAX_BATCH_SIZE));
      expect(validFlags.length).to.equal(Number(MAX_BATCH_SIZE));
      expect(statuses[0].totalCollateral).to.equal(100n);
      expect(statuses[99].totalCollateral).to.equal(10000n);
      expect(validFlags[0]).to.equal(true);
      expect(validFlags[99]).to.equal(true);
    });

    it('应处理部分资产有缓存的情况', async function () {
      const asset1 = ethers.Wallet.createRandom().address;
      const asset2 = ethers.Wallet.createRandom().address;
      const asset3 = ethers.Wallet.createRandom().address;
      await viewCache.connect(owner).setSystemStatus(asset1, 100n, 50n, 1000n);
      // asset2 和 asset3 不设置缓存
      const [statuses, validFlags] = await viewCache.connect(owner).batchGetSystemStatus([asset1, asset2, asset3]);
      expect(statuses.length).to.equal(3);
      expect(validFlags.length).to.equal(3);
      expect(statuses[0].totalCollateral).to.equal(100n);
      expect(validFlags[0]).to.equal(true);
      expect(statuses[1].totalCollateral).to.equal(0n);
      expect(validFlags[1]).to.equal(false);
      expect(statuses[2].totalCollateral).to.equal(0n);
      expect(validFlags[2]).to.equal(false);
    });

    it('应处理部分缓存过期的情况', async function () {
      const asset1 = ethers.Wallet.createRandom().address;
      const asset2 = ethers.Wallet.createRandom().address;
      await viewCache.connect(owner).setSystemStatus(asset1, 100n, 50n, 1000n);
      // 让 asset1 过期
      await ethers.provider.send('evm_increaseTime', [CACHE_DURATION + 1]);
      await ethers.provider.send('evm_mine', []);
      // asset2 在时间推进后写入，所以仍然有效
      await viewCache.connect(owner).setSystemStatus(asset2, 200n, 100n, 2000n);
      const [statuses, validFlags] = await viewCache.connect(owner).batchGetSystemStatus([asset1, asset2]);
      expect(statuses.length).to.equal(2);
      expect(statuses[0].totalCollateral).to.equal(100n);
      expect(validFlags[0]).to.equal(false); // 过期
      expect(statuses[1].totalCollateral).to.equal(200n);
      expect(validFlags[1]).to.equal(true); // 仍然有效
    });

    it('应处理混合有效和无效的缓存', async function () {
      const asset1 = ethers.Wallet.createRandom().address;
      const asset2 = ethers.Wallet.createRandom().address;
      const asset3 = ethers.Wallet.createRandom().address;
      await viewCache.connect(owner).setSystemStatus(asset1, 100n, 50n, 1000n);
      await viewCache.connect(owner).setSystemStatus(asset2, 200n, 100n, 2000n);
      // asset3 不设置，asset2 过期
      await ethers.provider.send('evm_increaseTime', [CACHE_DURATION + 1]);
      await ethers.provider.send('evm_mine', []);
      const [statuses, validFlags] = await viewCache.connect(owner).batchGetSystemStatus([asset1, asset2, asset3]);
      expect(validFlags[0]).to.equal(false); // asset1 过期
      expect(validFlags[1]).to.equal(false); // asset2 过期
      expect(validFlags[2]).to.equal(false); // asset3 未初始化
    });

    it('批量查询应保持数组顺序', async function () {
      const assets = [];
      for (let i = 0; i < 5; i++) {
        const asset = ethers.Wallet.createRandom().address;
        assets.push(asset);
        await viewCache.connect(owner).setSystemStatus(asset, BigInt(i + 1) * 100n, BigInt(i + 1) * 50n, BigInt(i + 1) * 10n);
      }
      const [statuses, validFlags] = await viewCache.connect(owner).batchGetSystemStatus(assets);
      for (let i = 0; i < 5; i++) {
        expect(statuses[i].totalCollateral).to.equal(BigInt(i + 1) * 100n);
        expect(validFlags[i]).to.equal(true);
      }
    });
  });

  describe('事件', function () {
    it('setSystemStatus 应发出 CacheUpdated', async function () {
      await expect(viewCache.connect(owner).setSystemStatus(ASSET, 1, 2, 3))
        .to.emit(viewCache, 'CacheUpdated')
        .withArgs(ASSET, owner.address, anyValue);
    });

    it('clearSystemCache 应发出 CacheUpdated', async function () {
      await viewCache.connect(owner).setSystemStatus(ASSET, 1, 2, 3);
      await expect(viewCache.connect(owner).clearSystemCache(ASSET))
        .to.emit(viewCache, 'CacheUpdated')
        .withArgs(ASSET, owner.address, anyValue);
    });

    it('覆盖缓存时应发出新的事件', async function () {
      await viewCache.connect(owner).setSystemStatus(ASSET, 1, 2, 3);
      await expect(viewCache.connect(owner).setSystemStatus(ASSET, 10, 20, 30))
        .to.emit(viewCache, 'CacheUpdated')
        .withArgs(ASSET, owner.address, anyValue);
    });

    it('事件应包含正确的时间戳', async function () {
      const tx = await viewCache.connect(owner).setSystemStatus(ASSET, 1, 2, 3);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);
      await expect(tx)
        .to.emit(viewCache, 'CacheUpdated')
        .withArgs(ASSET, owner.address, block!.timestamp);
    });
  });

  describe('权限边界', function () {
    it('有 VIEW_SYSTEM_DATA 权限的用户可以写入', async function () {
      await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, alice.address);
      await expect(viewCache.connect(alice).setSystemStatus(ASSET, 1, 2, 3)).to.not.be.reverted;
      const [status] = await viewCache.getSystemStatus(ASSET);
      expect(status.totalCollateral).to.equal(1n);
    });

    it('有 ADMIN 权限的用户可以清理', async function () {
      await viewCache.connect(owner).setSystemStatus(ASSET, 1, 2, 3);
      await acm.grantRole(ACTION_ADMIN, alice.address);
      await expect(viewCache.connect(alice).clearSystemCache(ASSET)).to.not.be.reverted;
      const [, isValid] = await viewCache.getSystemStatus(ASSET);
      expect(isValid).to.equal(false);
    });

    it('撤销权限后应无法写入', async function () {
      await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, alice.address);
      await viewCache.connect(alice).setSystemStatus(ASSET, 1, 2, 3);
      await acm.revokeRole(ACTION_VIEW_SYSTEM_DATA, alice.address);
      await expect(viewCache.connect(alice).setSystemStatus(ASSET, 10, 20, 30)).to.be.revertedWith('Insufficient permissions');
    });
  });

  describe('数据完整性', function () {
    it('应正确存储所有字段', async function () {
      const collateral = 123456789n;
      const debt = 987654321n;
      const utilization = 555555555555555555n;
      await viewCache.connect(owner).setSystemStatus(ASSET, collateral, debt, utilization);
      const [status] = await viewCache.getSystemStatus(ASSET);
      expect(status.totalCollateral).to.equal(collateral);
      expect(status.totalDebt).to.equal(debt);
      expect(status.utilizationRate).to.equal(utilization);
      expect(status.timestamp).to.be.a('bigint');
      expect(status.timestamp).to.be.gt(0n);
      expect(status.isValid).to.equal(true);
    });

    it('批量查询应返回完整数据', async function () {
      const asset1 = ethers.Wallet.createRandom().address;
      const asset2 = ethers.Wallet.createRandom().address;
      await viewCache.connect(owner).setSystemStatus(asset1, 100n, 50n, 1000n);
      await viewCache.connect(owner).setSystemStatus(asset2, 200n, 100n, 2000n);
      const [statuses, validFlags] = await viewCache.connect(owner).batchGetSystemStatus([asset1, asset2]);
      expect(statuses[0].totalCollateral).to.equal(100n);
      expect(statuses[0].totalDebt).to.equal(50n);
      expect(statuses[0].utilizationRate).to.equal(1000n);
      expect(statuses[1].totalCollateral).to.equal(200n);
      expect(statuses[1].totalDebt).to.equal(100n);
      expect(statuses[1].utilizationRate).to.equal(2000n);
      expect(validFlags[0]).to.equal(true);
      expect(validFlags[1]).to.equal(true);
    });
  });

  describe('集成场景', function () {
    it('应支持多个资产同时操作', async function () {
      const assets = [];
      for (let i = 0; i < 10; i++) {
        assets.push(ethers.Wallet.createRandom().address);
      }
      // 写入所有资产
      for (let i = 0; i < assets.length; i++) {
        await viewCache.connect(owner).setSystemStatus(assets[i], BigInt(i + 1) * 100n, BigInt(i + 1) * 50n, BigInt(i + 1) * 10n);
      }
      // 批量查询
      const [statuses, validFlags] = await viewCache.connect(owner).batchGetSystemStatus(assets);
      expect(statuses.length).to.equal(10);
      // 单个查询验证
      const [status0] = await viewCache.getSystemStatus(assets[0]);
      expect(status0.totalCollateral).to.equal(100n);
      // 清理部分资产
      await viewCache.connect(owner).clearSystemCache(assets[5]);
      const [, isValid5] = await viewCache.getSystemStatus(assets[5]);
      expect(isValid5).to.equal(false);
    });

    it('应支持批量操作后单个查询', async function () {
      const assets = [];
      for (let i = 0; i < 5; i++) {
        assets.push(ethers.Wallet.createRandom().address);
        await viewCache.connect(owner).setSystemStatus(assets[i], BigInt(i + 1) * 100n, BigInt(i + 1) * 50n, BigInt(i + 1) * 10n);
      }
      // 批量查询
      const [statuses] = await viewCache.connect(owner).batchGetSystemStatus(assets);
      // 单个查询验证一致性
      for (let i = 0; i < 5; i++) {
        const [status] = await viewCache.getSystemStatus(assets[i]);
        expect(status.totalCollateral).to.equal(statuses[i].totalCollateral);
        expect(status.totalDebt).to.equal(statuses[i].totalDebt);
        expect(status.utilizationRate).to.equal(statuses[i].utilizationRate);
      }
    });

    it('应支持多次更新和查询', async function () {
      const asset = ethers.Wallet.createRandom().address;
      // 第一次写入
      await viewCache.connect(owner).setSystemStatus(asset, 100n, 50n, 1000n);
      let [status] = await viewCache.getSystemStatus(asset);
      expect(status.totalCollateral).to.equal(100n);
      // 第二次更新
      await viewCache.connect(owner).setSystemStatus(asset, 200n, 100n, 2000n);
      [status] = await viewCache.getSystemStatus(asset);
      expect(status.totalCollateral).to.equal(200n);
      // 第三次更新
      await viewCache.connect(owner).setSystemStatus(asset, 300n, 150n, 3000n);
      [status] = await viewCache.getSystemStatus(asset);
      expect(status.totalCollateral).to.equal(300n);
    });

    it('应支持清理后重新写入', async function () {
      const asset = ethers.Wallet.createRandom().address;
      await viewCache.connect(owner).setSystemStatus(asset, 100n, 50n, 1000n);
      await viewCache.connect(owner).clearSystemCache(asset);
      await viewCache.connect(owner).setSystemStatus(asset, 200n, 100n, 2000n);
      const [status, isValid] = await viewCache.getSystemStatus(asset);
      expect(status.totalCollateral).to.equal(200n);
      expect(isValid).to.equal(true);
    });

    it('应支持多用户并发操作不同资产', async function () {
      await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, alice.address);
      const asset1 = ethers.Wallet.createRandom().address;
      const asset2 = ethers.Wallet.createRandom().address;
      // owner 和 alice 同时操作不同资产
      await viewCache.connect(owner).setSystemStatus(asset1, 100n, 50n, 1000n);
      await viewCache.connect(alice).setSystemStatus(asset2, 200n, 100n, 2000n);
      // 验证两个资产都正确写入
      const [status1] = await viewCache.getSystemStatus(asset1);
      const [status2] = await viewCache.getSystemStatus(asset2);
      expect(status1.totalCollateral).to.equal(100n);
      expect(status2.totalCollateral).to.equal(200n);
      // 批量查询验证
      const [statuses, validFlags] = await viewCache.connect(owner).batchGetSystemStatus([asset1, asset2]);
      expect(statuses[0].totalCollateral).to.equal(100n);
      expect(statuses[1].totalCollateral).to.equal(200n);
      expect(validFlags[0]).to.equal(true);
      expect(validFlags[1]).to.equal(true);
    });

    it('应支持时间推进与缓存过期混合场景', async function () {
      const assets = [];
      for (let i = 0; i < 5; i++) {
        assets.push(ethers.Wallet.createRandom().address);
        await viewCache.connect(owner).setSystemStatus(assets[i], BigInt(i + 1) * 100n, BigInt(i + 1) * 50n, BigInt(i + 1) * 10n);
      }
      // 推进时间，让前3个资产过期
      await ethers.provider.send('evm_increaseTime', [CACHE_DURATION + 1]);
      await ethers.provider.send('evm_mine', []);
      // 更新后2个资产，使其仍然有效
      await viewCache.connect(owner).setSystemStatus(assets[3], 400n, 200n, 4000n);
      await viewCache.connect(owner).setSystemStatus(assets[4], 500n, 250n, 5000n);
      // 批量查询验证混合状态
      const [statuses, validFlags] = await viewCache.connect(owner).batchGetSystemStatus(assets);
      expect(validFlags[0]).to.equal(false); // 过期
      expect(validFlags[1]).to.equal(false); // 过期
      expect(validFlags[2]).to.equal(false); // 过期
      expect(validFlags[3]).to.equal(true); // 有效
      expect(validFlags[4]).to.equal(true); // 有效
      expect(statuses[3].totalCollateral).to.equal(400n);
      expect(statuses[4].totalCollateral).to.equal(500n);
    });

    it('应支持批量写入、查询、清理的混合操作', async function () {
      const assets = [];
      for (let i = 0; i < 10; i++) {
        assets.push(ethers.Wallet.createRandom().address);
      }
      // 批量写入
      for (let i = 0; i < assets.length; i++) {
        await viewCache.connect(owner).setSystemStatus(assets[i], BigInt(i + 1) * 100n, BigInt(i + 1) * 50n, BigInt(i + 1) * 10n);
      }
      // 批量查询验证
      const [statuses1] = await viewCache.connect(owner).batchGetSystemStatus(assets);
      expect(statuses1.length).to.equal(10);
      // 清理部分资产（索引 2, 5, 8）
      await viewCache.connect(owner).clearSystemCache(assets[2]);
      await viewCache.connect(owner).clearSystemCache(assets[5]);
      await viewCache.connect(owner).clearSystemCache(assets[8]);
      // 再次批量查询验证
      const [statuses2, validFlags2] = await viewCache.connect(owner).batchGetSystemStatus(assets);
      expect(validFlags2[2]).to.equal(false);
      expect(validFlags2[5]).to.equal(false);
      expect(validFlags2[8]).to.equal(false);
      // 重新写入被清理的资产
      await viewCache.connect(owner).setSystemStatus(assets[2], 300n, 150n, 3000n);
      await viewCache.connect(owner).setSystemStatus(assets[5], 600n, 300n, 6000n);
      // 最终批量查询验证
      const [statuses3, validFlags3] = await viewCache.connect(owner).batchGetSystemStatus(assets);
      expect(validFlags3[2]).to.equal(true);
      expect(validFlags3[5]).to.equal(true);
      expect(validFlags3[8]).to.equal(false); // 仍然未写入
      expect(statuses3[2].totalCollateral).to.equal(300n);
      expect(statuses3[5].totalCollateral).to.equal(600n);
    });

    it('应支持不同权限用户的操作场景', async function () {
      await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, alice.address);
      await acm.grantRole(ACTION_ADMIN, alice.address);
      const asset1 = ethers.Wallet.createRandom().address;
      const asset2 = ethers.Wallet.createRandom().address;
      // owner 写入 asset1
      await viewCache.connect(owner).setSystemStatus(asset1, 100n, 50n, 1000n);
      // alice 写入 asset2
      await viewCache.connect(alice).setSystemStatus(asset2, 200n, 100n, 2000n);
      // alice 清理 asset1（有 ADMIN 权限）
      await viewCache.connect(alice).clearSystemCache(asset1);
      // owner 重新写入 asset1
      await viewCache.connect(owner).setSystemStatus(asset1, 150n, 75n, 1500n);
      // 验证最终状态
      const [status1, isValid1] = await viewCache.getSystemStatus(asset1);
      const [status2, isValid2] = await viewCache.getSystemStatus(asset2);
      expect(status1.totalCollateral).to.equal(150n);
      expect(isValid1).to.equal(true);
      expect(status2.totalCollateral).to.equal(200n);
      expect(isValid2).to.equal(true);
    });

    it('应支持大量资产的连续操作', async function () {
      const assets = [];
      for (let i = 0; i < 50; i++) {
        assets.push(ethers.Wallet.createRandom().address);
      }
      // 分批写入
      for (let i = 0; i < 50; i++) {
        await viewCache.connect(owner).setSystemStatus(assets[i], BigInt(i + 1) * 100n, BigInt(i + 1) * 50n, BigInt(i + 1) * 10n);
      }
      // 分批查询验证
      const [statuses, validFlags] = await viewCache.connect(owner).batchGetSystemStatus(assets);
      expect(statuses.length).to.equal(50);
      expect(validFlags.every((flag) => flag === true)).to.equal(true);
      // 更新部分资产
      for (let i = 0; i < 10; i++) {
        await viewCache.connect(owner).setSystemStatus(assets[i * 5], BigInt(i + 1) * 1000n, BigInt(i + 1) * 500n, BigInt(i + 1) * 100n);
      }
      // 再次批量查询验证更新
      const [statuses2, validFlags2] = await viewCache.connect(owner).batchGetSystemStatus(assets);
      expect(statuses2[0].totalCollateral).to.equal(1000n); // 已更新
      expect(statuses2[1].totalCollateral).to.equal(200n); // 未更新
      expect(validFlags2.every((flag) => flag === true)).to.equal(true);
    });

    it('应支持缓存过期后的重新写入场景', async function () {
      const asset = ethers.Wallet.createRandom().address;
      // 初始写入
      await viewCache.connect(owner).setSystemStatus(asset, 100n, 50n, 1000n);
      let [status, isValid] = await viewCache.getSystemStatus(asset);
      expect(isValid).to.equal(true);
      // 推进时间使缓存过期
      await ethers.provider.send('evm_increaseTime', [CACHE_DURATION + 1]);
      await ethers.provider.send('evm_mine', []);
      [status, isValid] = await viewCache.getSystemStatus(asset);
      expect(isValid).to.equal(false);
      // 重新写入使缓存有效
      await viewCache.connect(owner).setSystemStatus(asset, 200n, 100n, 2000n);
      [status, isValid] = await viewCache.getSystemStatus(asset);
      expect(isValid).to.equal(true);
      expect(status.totalCollateral).to.equal(200n);
    });

    it('应支持部分清理和部分更新的混合场景', async function () {
      const assets = [];
      for (let i = 0; i < 8; i++) {
        assets.push(ethers.Wallet.createRandom().address);
        await viewCache.connect(owner).setSystemStatus(assets[i], BigInt(i + 1) * 100n, BigInt(i + 1) * 50n, BigInt(i + 1) * 10n);
      }
      // 清理偶数索引的资产
      for (let i = 0; i < 8; i += 2) {
        await viewCache.connect(owner).clearSystemCache(assets[i]);
      }
      // 更新奇数索引的资产
      for (let i = 1; i < 8; i += 2) {
        await viewCache.connect(owner).setSystemStatus(assets[i], BigInt(i + 1) * 200n, BigInt(i + 1) * 100n, BigInt(i + 1) * 20n);
      }
      // 批量查询验证
      const [statuses, validFlags] = await viewCache.connect(owner).batchGetSystemStatus(assets);
      for (let i = 0; i < 8; i += 2) {
        expect(validFlags[i]).to.equal(false); // 被清理
      }
      for (let i = 1; i < 8; i += 2) {
        expect(validFlags[i]).to.equal(true); // 已更新
        expect(statuses[i].totalCollateral).to.equal(BigInt(i + 1) * 200n);
      }
    });

    it('应支持事件验证的集成场景', async function () {
      const assets = [];
      for (let i = 0; i < 5; i++) {
        assets.push(ethers.Wallet.createRandom().address);
      }
      // 验证每个写入操作都发出事件
      for (let i = 0; i < assets.length; i++) {
        await expect(viewCache.connect(owner).setSystemStatus(assets[i], BigInt(i + 1) * 100n, BigInt(i + 1) * 50n, BigInt(i + 1) * 10n))
          .to.emit(viewCache, 'CacheUpdated')
          .withArgs(assets[i], owner.address, anyValue);
      }
      // 验证清理操作也发出事件
      await expect(viewCache.connect(owner).clearSystemCache(assets[0]))
        .to.emit(viewCache, 'CacheUpdated')
        .withArgs(assets[0], owner.address, anyValue);
      // 验证重新写入也发出事件
      await expect(viewCache.connect(owner).setSystemStatus(assets[0], 1000n, 500n, 10000n))
        .to.emit(viewCache, 'CacheUpdated')
        .withArgs(assets[0], owner.address, anyValue);
    });

    it('应支持数据一致性的复杂验证', async function () {
      const assets = [];
      for (let i = 0; i < 20; i++) {
        assets.push(ethers.Wallet.createRandom().address);
      }
      // 写入所有资产
      const expectedValues = [];
      for (let i = 0; i < assets.length; i++) {
        const collateral = BigInt(i + 1) * 100n;
        const debt = BigInt(i + 1) * 50n;
        const utilization = BigInt(i + 1) * 10n;
        expectedValues.push({ collateral, debt, utilization });
        await viewCache.connect(owner).setSystemStatus(assets[i], collateral, debt, utilization);
      }
      // 批量查询
      const [statuses, validFlags] = await viewCache.connect(owner).batchGetSystemStatus(assets);
      // 验证批量查询与单个查询的一致性
      for (let i = 0; i < assets.length; i++) {
        const [status] = await viewCache.getSystemStatus(assets[i]);
        expect(status.totalCollateral).to.equal(statuses[i].totalCollateral);
        expect(status.totalDebt).to.equal(statuses[i].totalDebt);
        expect(status.utilizationRate).to.equal(statuses[i].utilizationRate);
        expect(status.totalCollateral).to.equal(expectedValues[i].collateral);
        expect(status.totalDebt).to.equal(expectedValues[i].debt);
        expect(status.utilizationRate).to.equal(expectedValues[i].utilization);
        expect(validFlags[i]).to.equal(true);
      }
    });

    it('应支持实际业务场景模拟：资产状态变化', async function () {
      const asset = ethers.Wallet.createRandom().address;
      // 模拟资产状态变化：初始 -> 增长 -> 峰值 -> 下降 -> 清理
      // 初始状态
      await viewCache.connect(owner).setSystemStatus(asset, 1000n, 500n, 10000n);
      let [status] = await viewCache.getSystemStatus(asset);
      expect(status.totalCollateral).to.equal(1000n);
      // 增长阶段
      await viewCache.connect(owner).setSystemStatus(asset, 2000n, 1000n, 20000n);
      [status] = await viewCache.getSystemStatus(asset);
      expect(status.totalCollateral).to.equal(2000n);
      // 峰值阶段
      await viewCache.connect(owner).setSystemStatus(asset, 5000n, 2500n, 50000n);
      [status] = await viewCache.getSystemStatus(asset);
      expect(status.totalCollateral).to.equal(5000n);
      // 下降阶段
      await viewCache.connect(owner).setSystemStatus(asset, 3000n, 1500n, 30000n);
      [status] = await viewCache.getSystemStatus(asset);
      expect(status.totalCollateral).to.equal(3000n);
      // 清理
      await viewCache.connect(owner).clearSystemCache(asset);
      const [, isValid] = await viewCache.getSystemStatus(asset);
      expect(isValid).to.equal(false);
    });

    it('应支持批量操作中的时间推进场景', async function () {
      const assets = [];
      for (let i = 0; i < 10; i++) {
        assets.push(ethers.Wallet.createRandom().address);
      }
      // 写入前5个资产
      for (let i = 0; i < 5; i++) {
        await viewCache.connect(owner).setSystemStatus(assets[i], BigInt(i + 1) * 100n, BigInt(i + 1) * 50n, BigInt(i + 1) * 10n);
      }
      // 推进时间
      await ethers.provider.send('evm_increaseTime', [CACHE_DURATION + 1]);
      await ethers.provider.send('evm_mine', []);
      // 写入后5个资产（仍然有效）
      for (let i = 5; i < 10; i++) {
        await viewCache.connect(owner).setSystemStatus(assets[i], BigInt(i + 1) * 100n, BigInt(i + 1) * 50n, BigInt(i + 1) * 10n);
      }
      // 批量查询验证：前5个过期，后5个有效
      const [statuses, validFlags] = await viewCache.connect(owner).batchGetSystemStatus(assets);
      for (let i = 0; i < 5; i++) {
        expect(validFlags[i]).to.equal(false);
      }
      for (let i = 5; i < 10; i++) {
        expect(validFlags[i]).to.equal(true);
        expect(statuses[i].totalCollateral).to.equal(BigInt(i + 1) * 100n);
      }
    });

    it('应支持多轮更新和查询的复杂场景', async function () {
      const assets = [];
      for (let i = 0; i < 5; i++) {
        assets.push(ethers.Wallet.createRandom().address);
      }
      // 第一轮：写入所有资产
      for (let i = 0; i < assets.length; i++) {
        await viewCache.connect(owner).setSystemStatus(assets[i], BigInt(i + 1) * 100n, BigInt(i + 1) * 50n, BigInt(i + 1) * 10n);
      }
      let [statuses1] = await viewCache.connect(owner).batchGetSystemStatus(assets);
      // 第二轮：更新所有资产
      for (let i = 0; i < assets.length; i++) {
        await viewCache.connect(owner).setSystemStatus(assets[i], BigInt(i + 1) * 200n, BigInt(i + 1) * 100n, BigInt(i + 1) * 20n);
      }
      let [statuses2] = await viewCache.connect(owner).batchGetSystemStatus(assets);
      // 第三轮：清理部分，更新部分
      await viewCache.connect(owner).clearSystemCache(assets[0]);
      await viewCache.connect(owner).clearSystemCache(assets[2]);
      for (let i = 1; i < assets.length; i += 2) {
        await viewCache.connect(owner).setSystemStatus(assets[i], BigInt(i + 1) * 300n, BigInt(i + 1) * 150n, BigInt(i + 1) * 30n);
      }
      let [statuses3, validFlags3] = await viewCache.connect(owner).batchGetSystemStatus(assets);
      // 验证最终状态
      expect(validFlags3[0]).to.equal(false); // 被清理
      expect(validFlags3[1]).to.equal(true); // 已更新
      expect(validFlags3[2]).to.equal(false); // 被清理
      expect(validFlags3[3]).to.equal(true); // 已更新
      expect(validFlags3[4]).to.equal(true); // 保持第二轮的值
      expect(statuses3[1].totalCollateral).to.equal(600n); // 300 * 2
      expect(statuses3[3].totalCollateral).to.equal(1200n); // 300 * 4
    });
  });

  describe('边界情况', function () {
    it('批量查询边界值：正好100个资产', async function () {
      const assets = Array(Number(MAX_BATCH_SIZE)).fill(null).map(() => ethers.Wallet.createRandom().address);
      for (let i = 0; i < assets.length; i++) {
        await viewCache.connect(owner).setSystemStatus(assets[i], BigInt(i + 1), BigInt(i + 1), BigInt(i + 1));
      }
      const [statuses, validFlags] = await viewCache.connect(owner).batchGetSystemStatus(assets);
      expect(statuses.length).to.equal(Number(MAX_BATCH_SIZE));
      expect(validFlags.every((flag) => flag === true)).to.equal(true);
    });

    it('应处理相同资产多次写入', async function () {
      for (let i = 0; i < 5; i++) {
        await viewCache.connect(owner).setSystemStatus(ASSET, BigInt(i + 1) * 100n, BigInt(i + 1) * 50n, BigInt(i + 1) * 10n);
      }
      const [status] = await viewCache.getSystemStatus(ASSET);
      expect(status.totalCollateral).to.equal(500n); // 最后一次的值
      expect(status.totalDebt).to.equal(250n);
      expect(status.utilizationRate).to.equal(50n);
    });

    it('应处理批量查询中包含相同资产', async function () {
      const asset2 = ethers.Wallet.createRandom().address;
      await viewCache.connect(owner).setSystemStatus(ASSET, 100n, 50n, 1000n);
      await viewCache.connect(owner).setSystemStatus(asset2, 200n, 100n, 2000n);
      const [statuses, validFlags] = await viewCache.connect(owner).batchGetSystemStatus([ASSET, asset2, ASSET]);
      expect(statuses.length).to.equal(3);
      expect(statuses[0].totalCollateral).to.equal(100n);
      expect(statuses[1].totalCollateral).to.equal(200n);
      expect(statuses[2].totalCollateral).to.equal(100n); // 重复资产
      expect(validFlags[0]).to.equal(true);
      expect(validFlags[1]).to.equal(true);
      expect(validFlags[2]).to.equal(true);
    });
  });
});

