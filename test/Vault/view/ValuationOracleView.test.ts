import { expect } from 'chai';
import * as hardhat from 'hardhat';
const { ethers, upgrades } = hardhat;
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import type {
  ValuationOracleView,
  MockAccessControlManager,
  MockRegistry,
  MockPriceOracle
} from '../../../types';

const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
const KEY_PRICE_ORACLE = ethers.keccak256(ethers.toUtf8Bytes('PRICE_ORACLE'));
const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
const ACTION_VIEW_SYSTEM_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_SYSTEM_DATA'));
const MAX_BATCH_SIZE = 100n; // ViewConstants.MAX_BATCH_SIZE

describe('ValuationOracleView – view-only price oracle facade', function () {
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let valuationOracleView: ValuationOracleView;
  let registry: MockRegistry;
  let acm: MockAccessControlManager;
  let priceOracle: MockPriceOracle;
  let ASSET: string;

  async function deployFixture() {
    [owner, alice] = await ethers.getSigners();
    ASSET = ethers.Wallet.createRandom().address;

    const MockAccessControlManagerF = await ethers.getContractFactory('MockAccessControlManager');
    acm = await MockAccessControlManagerF.deploy();

    const MockRegistryF = await ethers.getContractFactory('MockRegistry');
    registry = await MockRegistryF.deploy();

    const MockPriceOracleF = await ethers.getContractFactory('MockPriceOracle');
    priceOracle = await MockPriceOracleF.deploy();
    await priceOracle.setPrice(ASSET, 1_234_567n, 1111n, 8);
    await priceOracle.configureAsset(ASSET, 'asset', 8, 3600);

    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(KEY_PRICE_ORACLE, await priceOracle.getAddress());

    const ValuationOracleViewF = await ethers.getContractFactory('ValuationOracleView');
    valuationOracleView = await upgrades.deployProxy(ValuationOracleViewF, [await registry.getAddress()], {
      kind: 'uups'
    });

    await acm.grantRole(ACTION_ADMIN, owner.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, owner.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, await valuationOracleView.getAddress());

    return { owner, alice, valuationOracleView, registry, acm, priceOracle, ASSET };
  }

  beforeEach(async function () {
    ({ owner, alice, valuationOracleView, registry, acm, priceOracle, ASSET } = await deployFixture());
  });

  describe('初始化', function () {
    it('应拒绝零地址初始化', async function () {
      const ValuationOracleViewF = await ethers.getContractFactory('ValuationOracleView');
      await expect(upgrades.deployProxy(ValuationOracleViewF, [ethers.ZeroAddress], { kind: 'uups' })).to.be.revertedWithCustomError(
        ValuationOracleViewF,
        'ZeroAddress'
      );
    });

    it('应记录 registry 地址', async function () {
      expect(await valuationOracleView.registryAddrVar()).to.equal(await registry.getAddress());
    });

    it('registryAddr() 和 registryAddrVar() 应返回相同值', async function () {
      expect(await valuationOracleView.registryAddr()).to.equal(await valuationOracleView.registryAddrVar());
      expect(await valuationOracleView.registryAddr()).to.equal(await registry.getAddress());
    });
  });

  describe('访问控制', function () {
    it('缺少 VIEW_SYSTEM_DATA 权限应被拒绝', async function () {
      await expect(valuationOracleView.connect(alice).getAssetPrice(ASSET)).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('缺少权限时批量查询应被拒绝', async function () {
      await expect(valuationOracleView.connect(alice).getAssetPrices([ASSET])).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('缺少权限时健康检查应被拒绝', async function () {
      await expect(valuationOracleView.connect(alice).checkPriceOracleHealth(ASSET)).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('缺少权限时价格有效性检查应被拒绝', async function () {
      await expect(valuationOracleView.connect(alice).isPriceValid(ASSET)).to.be.revertedWithCustomError(acm, 'MissingRole');
    });
  });

  describe('价格查询', function () {
    it('应返回单资产价格与时间戳', async function () {
      const [price, timestamp] = await valuationOracleView.connect(owner).getAssetPrice(ASSET);
      expect(price).to.equal(1_234_567n);
      expect(timestamp).to.equal(1111n);
    });

    it('应返回批量价格并校验长度', async function () {
      const assets = [ASSET, ethers.Wallet.createRandom().address];
      await priceOracle.setPrice(assets[1], 9_999n, 2222n, 8);
      const [prices, timestamps] = await valuationOracleView.connect(owner).getAssetPrices(assets);
      expect(prices[0]).to.equal(1_234_567n);
      expect(prices[1]).to.equal(9_999n);
      expect(timestamps[1]).to.equal(2222n);
    });

    it('空数组应 revert', async function () {
      await expect(valuationOracleView.connect(owner).getAssetPrices([])).to.be.revertedWithCustomError(
        valuationOracleView,
        'ValuationOracleView__EmptyAssets'
      );
    });

    it('超过批量上限应 revert', async function () {
      const oversized = Array(Number(MAX_BATCH_SIZE) + 1).fill(ASSET);
      await expect(valuationOracleView.connect(owner).getAssetPrices(oversized)).to.be.revertedWithCustomError(
        valuationOracleView,
        'ValuationOracleView__BatchTooLarge'
      );
    });

    it('Oracle 回退路径：预言机报错时返回零值', async function () {
      await priceOracle.setShouldFail(true);
      const [price, timestamp] = await valuationOracleView.connect(owner).getAssetPrice(ASSET);
      expect(price).to.equal(0n);
      expect(timestamp).to.equal(0n);

      const [prices, timestamps] = await valuationOracleView.connect(owner).getAssetPrices([ASSET]);
      expect(prices[0]).to.equal(0n);
      expect(timestamps[0]).to.equal(0n);

      const isValid = await valuationOracleView.connect(owner).isPriceValid(ASSET);
      expect(isValid).to.equal(false);
    });

    it('应处理零地址资产的价格查询', async function () {
      const [price, timestamp] = await valuationOracleView.connect(owner).getAssetPrice(ethers.ZeroAddress);
      // 零地址资产通常没有价格，应该返回零值或由预言机处理
      expect(price).to.be.a('bigint');
      expect(timestamp).to.be.a('bigint');
    });

    it('应处理未配置资产的价格查询', async function () {
      const unconfiguredAsset = ethers.Wallet.createRandom().address;
      const [price, timestamp] = await valuationOracleView.connect(owner).getAssetPrice(unconfiguredAsset);
      // 未配置资产可能返回零值
      expect(price).to.be.a('bigint');
      expect(timestamp).to.be.a('bigint');
    });

    it('应处理价格为零的资产', async function () {
      const zeroPriceAsset = ethers.Wallet.createRandom().address;
      await priceOracle.setPrice(zeroPriceAsset, 0n, 9999n, 8);
      const [price, timestamp] = await valuationOracleView.connect(owner).getAssetPrice(zeroPriceAsset);
      expect(price).to.equal(0n);
      expect(timestamp).to.equal(9999n);
    });

    it('批量查询应处理最大边界值（100个资产）', async function () {
      const maxAssets = Array(Number(MAX_BATCH_SIZE)).fill(null).map(() => ethers.Wallet.createRandom().address);
      // 为所有资产设置价格
      for (let i = 0; i < maxAssets.length; i++) {
        await priceOracle.setPrice(maxAssets[i], BigInt(i + 1) * 1000n, BigInt(i + 1000), 8);
      }
      const [prices, timestamps] = await valuationOracleView.connect(owner).getAssetPrices(maxAssets);
      expect(prices.length).to.equal(Number(MAX_BATCH_SIZE));
      expect(timestamps.length).to.equal(Number(MAX_BATCH_SIZE));
      expect(prices[0]).to.equal(1000n);
      expect(timestamps[0]).to.equal(1000n);
    });

    it('批量查询应处理部分成功场景', async function () {
      const asset1 = ethers.Wallet.createRandom().address;
      const asset2 = ethers.Wallet.createRandom().address;
      await priceOracle.setPrice(asset1, 1000n, 2000n, 8);
      // asset2 不设置价格，可能返回零值
      const [prices, timestamps] = await valuationOracleView.connect(owner).getAssetPrices([asset1, asset2]);
      expect(prices.length).to.equal(2);
      expect(prices[0]).to.equal(1000n);
      expect(timestamps[0]).to.equal(2000n);
    });

    it('批量查询应处理全部失败场景', async function () {
      await priceOracle.setShouldFail(true);
      const assets = [ASSET, ethers.Wallet.createRandom().address];
      const [prices, timestamps] = await valuationOracleView.connect(owner).getAssetPrices(assets);
      expect(prices.length).to.equal(2);
      expect(timestamps.length).to.equal(2);
      expect(prices[0]).to.equal(0n);
      expect(prices[1]).to.equal(0n);
    });

    it('价格有效性检查：有效价格应返回 true', async function () {
      const isValid = await valuationOracleView.connect(owner).isPriceValid(ASSET);
      expect(isValid).to.equal(true);
    });

    it('价格有效性检查：零价格应返回 false', async function () {
      const zeroPriceAsset = ethers.Wallet.createRandom().address;
      await priceOracle.setPrice(zeroPriceAsset, 0n, 9999n, 8);
      const isValid = await valuationOracleView.connect(owner).isPriceValid(zeroPriceAsset);
      expect(isValid).to.equal(false);
    });

    it('价格有效性检查：未配置资产应返回 false', async function () {
      const unconfiguredAsset = ethers.Wallet.createRandom().address;
      const isValid = await valuationOracleView.connect(owner).isPriceValid(unconfiguredAsset);
      expect(isValid).to.equal(false);
    });
  });

  describe('健康检查', function () {
    it('应返回健康检查结果', async function () {
      const [healthy, details] = await valuationOracleView.connect(owner).checkPriceOracleHealth(ASSET);
      expect(healthy).to.equal(true);
      expect(details).to.equal('Healthy');
    });

    it('批量健康检查应遵守长度限制并容忍失败', async function () {
      const assets = [ASSET, ethers.Wallet.createRandom().address];
      const [statuses, details] = await valuationOracleView.connect(owner).batchCheckPriceOracleHealth(assets);
      expect(statuses.length).to.equal(2);
      expect(details.length).to.equal(2);
      expect(statuses[0]).to.equal(true);
      expect(statuses[1]).to.equal(false);
    });

    it('预言机报错时批量健康检查应返回失败标记', async function () {
      await priceOracle.setShouldFail(true);
      const [statuses, details] = await valuationOracleView.connect(owner).batchCheckPriceOracleHealth([ASSET]);
      expect(statuses[0]).to.equal(false);
      expect(details[0]).to.equal('oracle call failed');
    });

    it('应处理零地址资产的健康检查', async function () {
      const [healthy, details] = await valuationOracleView.connect(owner).checkPriceOracleHealth(ethers.ZeroAddress);
      expect(healthy).to.equal(false);
      expect(details).to.equal('Zero address');
    });

    it('应处理未配置资产的健康检查', async function () {
      const unconfiguredAsset = ethers.Wallet.createRandom().address;
      const [healthy, details] = await valuationOracleView.connect(owner).checkPriceOracleHealth(unconfiguredAsset);
      expect(healthy).to.equal(false);
      expect(details).to.equal('Asset not supported');
    });

    it('批量健康检查应处理最大边界值（100个资产）', async function () {
      const maxAssets = Array(Number(MAX_BATCH_SIZE)).fill(null).map(() => ethers.Wallet.createRandom().address);
      // 为部分资产设置价格
      for (let i = 0; i < 50; i++) {
        await priceOracle.setPrice(maxAssets[i], BigInt(i + 1) * 1000n, BigInt(i + 1000), 8);
        await priceOracle.configureAsset(maxAssets[i], `asset${i}`, 8, 3600);
      }
      const [statuses, details] = await valuationOracleView.connect(owner).batchCheckPriceOracleHealth(maxAssets);
      expect(statuses.length).to.equal(Number(MAX_BATCH_SIZE));
      expect(details.length).to.equal(Number(MAX_BATCH_SIZE));
      expect(statuses[0]).to.equal(true);
      expect(statuses[50]).to.equal(false); // 未配置的资产
    });

    it('批量健康检查应处理部分成功场景', async function () {
      const asset1 = ethers.Wallet.createRandom().address;
      const asset2 = ethers.Wallet.createRandom().address;
      await priceOracle.setPrice(asset1, 1000n, 2000n, 8);
      await priceOracle.configureAsset(asset1, 'asset1', 8, 3600);
      // asset2 不配置
      const [statuses, details] = await valuationOracleView.connect(owner).batchCheckPriceOracleHealth([asset1, asset2]);
      expect(statuses.length).to.equal(2);
      expect(statuses[0]).to.equal(true);
      expect(statuses[1]).to.equal(false);
    });

    it('批量健康检查应处理全部失败场景', async function () {
      await priceOracle.setShouldFail(true);
      const assets = [ASSET, ethers.Wallet.createRandom().address];
      const [statuses, details] = await valuationOracleView.connect(owner).batchCheckPriceOracleHealth(assets);
      expect(statuses.length).to.equal(2);
      expect(details.length).to.equal(2);
      expect(statuses[0]).to.equal(false);
      expect(statuses[1]).to.equal(false);
      expect(details[0]).to.equal('oracle call failed');
      expect(details[1]).to.equal('oracle call failed');
    });

    it('批量健康检查空数组应 revert', async function () {
      await expect(valuationOracleView.connect(owner).batchCheckPriceOracleHealth([])).to.be.revertedWithCustomError(
        valuationOracleView,
        'ValuationOracleView__EmptyAssets'
      );
    });

    it('批量健康检查超过上限应 revert', async function () {
      const oversized = Array(Number(MAX_BATCH_SIZE) + 1).fill(ASSET);
      await expect(valuationOracleView.connect(owner).batchCheckPriceOracleHealth(oversized)).to.be.revertedWithCustomError(
        valuationOracleView,
        'ValuationOracleView__BatchTooLarge'
      );
    });
  });

  describe('Registry 管理', function () {
    it('非管理员不可更新 registry', async function () {
      const newRegistryAddr = ethers.Wallet.createRandom().address;
      await expect(valuationOracleView.connect(alice).setRegistry(newRegistryAddr)).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('管理员可以更新 registry', async function () {
      const newRegistryAddr = ethers.Wallet.createRandom().address;
      await valuationOracleView.connect(owner).setRegistry(newRegistryAddr);
      expect(await valuationOracleView.registryAddrVar()).to.equal(newRegistryAddr);
    });

    it('更新 registry 时零地址应 revert', async function () {
      await expect(valuationOracleView.connect(owner).setRegistry(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        valuationOracleView,
        'ZeroAddress'
      );
    });

    it('getRegistry 应要求管理员权限', async function () {
      await expect(valuationOracleView.connect(alice).getRegistry()).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('管理员可以获取 registry 地址', async function () {
      const registryAddr = await valuationOracleView.connect(owner).getRegistry();
      expect(registryAddr).to.equal(await registry.getAddress());
    });

    it('更新 registry 应发出事件', async function () {
      const newRegistryAddr = ethers.Wallet.createRandom().address;
      const oldRegistryAddr = await registry.getAddress();
      // 验证事件被发出（不验证所有参数细节）
      await expect(valuationOracleView.connect(owner).setRegistry(newRegistryAddr))
        .to.emit(valuationOracleView, 'ModuleAddressUpdated');
    });
  });

  describe('版本和权限信息', function () {
    it('getVersionInfo 应返回版本信息', async function () {
      const [apiVersion, schemaVersion, implementation] = await valuationOracleView.connect(alice).getVersionInfo();
      expect(apiVersion).to.equal(1n);
      expect(schemaVersion).to.equal(1n);
      // When called through proxy, implementation is the logic contract address.
      expect(implementation).to.not.equal(ethers.ZeroAddress);
    });

    it('hasUpgradePermission 应检查升级权限', async function () {
      const ACTION_UPGRADE_MODULE = ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE'));
      
      // owner 没有升级权限
      let hasPermission = await valuationOracleView.connect(owner).hasUpgradePermission(owner.address);
      expect(hasPermission).to.equal(false);

      // 授予升级权限
      await acm.grantRole(ACTION_UPGRADE_MODULE, owner.address);
      hasPermission = await valuationOracleView.connect(owner).hasUpgradePermission(owner.address);
      expect(hasPermission).to.equal(true);
    });

    it('hasUpgradePermission 应检查其他用户权限', async function () {
      const ACTION_UPGRADE_MODULE = ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE'));
      
      // alice 没有升级权限
      let hasPermission = await valuationOracleView.connect(owner).hasUpgradePermission(alice.address);
      expect(hasPermission).to.equal(false);

      // 授予 alice 升级权限
      await acm.grantRole(ACTION_UPGRADE_MODULE, alice.address);
      hasPermission = await valuationOracleView.connect(owner).hasUpgradePermission(alice.address);
      expect(hasPermission).to.equal(true);
    });
  });

  describe('Registry 错误处理', function () {
    it('Registry 未配置价格预言机时应回退', async function () {
      // 创建一个新的 registry，不配置价格预言机
      const newRegistry = await (await ethers.getContractFactory('MockRegistry')).deploy();
      await newRegistry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
      // 不设置 KEY_PRICE_ORACLE

      const ValuationOracleViewF = await ethers.getContractFactory('ValuationOracleView');
      const newView = await upgrades.deployProxy(ValuationOracleViewF, [await newRegistry.getAddress()], {
        kind: 'uups'
      });
      await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, owner.address);
      await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, await newView.getAddress());

      // 调用应失败，因为 Registry.getModuleOrRevert 会 revert
      await expect(newView.connect(owner).getAssetPrice(ASSET)).to.be.revertedWith('MockRegistry: module not found');
    });
  });

  describe('边界情况和集成', function () {
    it('应正确处理多个资产的价格查询', async function () {
      const assets = [];
      const expectedPrices = [];
      const expectedTimestamps = [];

      for (let i = 0; i < 10; i++) {
        const asset = ethers.Wallet.createRandom().address;
        const price = BigInt(i + 1) * 1000000n;
        const timestamp = BigInt(1000 + i);
        assets.push(asset);
        expectedPrices.push(price);
        expectedTimestamps.push(timestamp);
        await priceOracle.setPrice(asset, price, timestamp, 8);
      }

      const [prices, timestamps] = await valuationOracleView.connect(owner).getAssetPrices(assets);
      expect(prices.length).to.equal(10);
      expect(timestamps.length).to.equal(10);
      for (let i = 0; i < 10; i++) {
        expect(prices[i]).to.equal(expectedPrices[i]);
        expect(timestamps[i]).to.equal(expectedTimestamps[i]);
      }
    });

    it('应正确处理混合健康状态的批量健康检查', async function () {
      const assets = [];
      const expectedStatuses = [];

      // 创建5个健康资产
      for (let i = 0; i < 5; i++) {
        const asset = ethers.Wallet.createRandom().address;
        assets.push(asset);
        expectedStatuses.push(true);
        await priceOracle.setPrice(asset, BigInt(i + 1) * 1000n, BigInt(1000 + i), 8);
        await priceOracle.configureAsset(asset, `asset${i}`, 8, 3600);
      }

      // 创建5个不健康资产（零地址、未配置等）
      assets.push(ethers.ZeroAddress);
      expectedStatuses.push(false);
      for (let i = 0; i < 4; i++) {
        const asset = ethers.Wallet.createRandom().address;
        assets.push(asset);
        expectedStatuses.push(false);
      }

      const [statuses, details] = await valuationOracleView.connect(owner).batchCheckPriceOracleHealth(assets);
      expect(statuses.length).to.equal(10);
      expect(details.length).to.equal(10);
      for (let i = 0; i < 5; i++) {
        expect(statuses[i]).to.equal(expectedStatuses[i]);
      }
      for (let i = 5; i < 10; i++) {
        expect(statuses[i]).to.equal(false);
      }
    });
  });
});

