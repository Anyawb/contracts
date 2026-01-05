import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';

// 目标：
// 1) 验证 PriceOracle 在移除优雅降级(GD)与DataPush后仍能完成核心功能
// 2) 确认任何“优雅降级路径”的调用在本合约中已不存在（编译期/运行期均不可用）
// 3) 验证通过 Registry + ACM 的权限模型进行价格更新与查询

describe('PriceOracle - 瘦身后核心功能验证 (No GD, No DataPush)', function () {
  this.timeout(60000);

  async function deployFixture() {
    const [governance, updater] = await ethers.getSigners();

    // 1) 部署 AccessControlManager（最小可用权限中心）
    const acmFactory = await ethers.getContractFactory('AccessControlManager');
    const acm = await acmFactory.deploy(governance.address);
    await acm.waitForDeployment();

    // 授予必要权限（注意：ACM 构造器已为 owner 预授予 SET_PARAMETER/UPGRADE_MODULE 等权限，无需重复授予）
    const ACTION_UPDATE_PRICE = ethers.keccak256(ethers.toUtf8Bytes('UPDATE_PRICE'));
    await (await acm.grantRole(ACTION_UPDATE_PRICE, updater.address)).wait();

    // 2) 部署 MockRegistry 并注册 ACM 到 KEY_ACCESS_CONTROL
    const registryFactory = await ethers.getContractFactory('MockRegistry');
    const registry = await registryFactory.deploy();
    await registry.waitForDeployment();

    // 直接计算 KEY_ACCESS_CONTROL 的哈希值（与 ModuleKeys 保持一致）
    const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
    await (await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress())).wait();

    // 3) 部署 PriceOracle（使用 Registry 地址初始化）
    const priceOracleFactory = await ethers.getContractFactory('PriceOracle');
    const priceOracle = await upgrades.deployProxy(priceOracleFactory, [await registry.getAddress()]);
    await priceOracle.waitForDeployment();

    return { governance, updater, acm, registry, priceOracle };
  }

  it('应允许治理配置资产，并允许具备权限的更新者更新价格', async function () {
    const { governance, updater, priceOracle } = await deployFixture();

    const usdc = ethers.Wallet.createRandom().address; // 随机地址模拟资产
    const maxPriceAge = 3600;

    // 配置资产（由治理）
    await expect(
      priceOracle.connect(governance).configureAsset(usdc, 'usd-coin', 8, maxPriceAge)
    ).to.emit(priceOracle, 'AssetConfigUpdated')
     .withArgs(usdc, 'usd-coin', true);

    // 具备 UPDATE_PRICE 权限的更新者更新价格
    const price = ethers.parseUnits('1', 8);
    const ts = await time.latest();
    await expect(
      priceOracle.connect(updater).updatePrice(usdc, price, ts)
    ).to.emit(priceOracle, 'PriceUpdated')
     .withArgs(usdc, price, ts);

    // 查询价格（应成功，且为8位精度）
    const [p, t, d] = await priceOracle.getPrice(usdc);
    expect(p).to.equal(price);
    expect(t).to.equal(ts);
    expect(d).to.equal(8);
  });

  it('应在价格过期时拒绝严格查询，并通过 isPriceValid 返回 false', async function () {
    const { governance, updater, priceOracle } = await deployFixture();
    const asset = ethers.Wallet.createRandom().address;

    await priceOracle.connect(governance).configureAsset(asset, 'asset-x', 8, 1); // 1秒过期
    const price = ethers.parseUnits('2', 8);
    const oldTs = (await time.latest()) - 10; // 过期时间
    await priceOracle.connect(updater).updatePrice(asset, price, oldTs);

    // 严格读取应revert为过期
    await expect(priceOracle.getPrice(asset)).to.be.revertedWithCustomError(priceOracle, 'PriceOracle__StalePrice');

    // isPriceValid 不revert，并给出 false
    expect(await priceOracle.isPriceValid(asset)).to.equal(false);
  });

  it('应拒绝未配置资产的严格查询，且 isPriceValid 返回 false', async function () {
    const { priceOracle } = await deployFixture();
    const unknown = ethers.Wallet.createRandom().address;

    await expect(priceOracle.getPrice(unknown)).to.be.revertedWithCustomError(priceOracle, 'PriceOracle__AssetNotSupported');
    expect(await priceOracle.isPriceValid(unknown)).to.equal(false);
  });

  it('不再暴露任何“优雅降级”相关接口，确保调用失败（编译期/运行期均不可用）', async function () {
    const { priceOracle } = await deployFixture();

    // 运行期防御：尝试通过字符串方式调用已删除的方法应失败
    // 使用低级 call 的方式模拟错误调用（函数选择器不存在 -> call 返回 false）
    const selector = ethers.id('getAssetValueWithFallback(address,uint256)').slice(0, 10); // 4字节选择器
    const targetAsset = ethers.Wallet.createRandom().address;
    const calldata = selector + targetAsset.slice(2).padStart(64, '0') + '0000000000000000000000000000000000000000000000000000000000000001';
    const res = await ethers.provider.call({ to: await priceOracle.getAddress(), data: calldata }).catch(() => '0x');
    // 期望不是有效返回（通常为 0x 或 revert），这里只要不是非空的有效编码即可认为不存在
    expect(res).to.satisfy((ret: string) => ret === '0x' || ret.length < 10);
  });

  it('资产管理：configureAsset 不重复添加，setAssetActive 切换状态，getSupportedAssets 与计数一致', async function () {
    const { governance, priceOracle } = await deployFixture();
    const a1 = ethers.Wallet.createRandom().address;

    await priceOracle.connect(governance).configureAsset(a1, 'a1', 8, 3600);
    await priceOracle.connect(governance).configureAsset(a1, 'a1', 8, 3600); // 再次配置不应重复添加

    const assets = await priceOracle.getSupportedAssets();
    expect(assets.length).to.equal(1);
    expect(await priceOracle.getAssetCount()).to.equal(1n);
    expect((await priceOracle.getAssetConfig(a1)).isActive).to.equal(true);

    // 停用
    await priceOracle.connect(governance).setAssetActive(a1, false);
    expect((await priceOracle.getAssetConfig(a1)).isActive).to.equal(false);

    // 再启用
    await priceOracle.connect(governance).setAssetActive(a1, true);
    expect((await priceOracle.getAssetConfig(a1)).isActive).to.equal(true);
  });

  it('价格查询与批量查询：getPriceData/getPrices/isPriceValid 的组合路径', async function () {
    const { governance, updater, priceOracle } = await deployFixture();
    const a1 = ethers.Wallet.createRandom().address;
    const a2 = ethers.Wallet.createRandom().address;
    await priceOracle.connect(governance).configureAsset(a1, 'a1', 8, 3600);
    await priceOracle.connect(governance).configureAsset(a2, 'a2', 8, 3600);

    const ts = await time.latest();
    await priceOracle.connect(updater).updatePrice(a1, ethers.parseUnits('10', 8), ts);
    await priceOracle.connect(updater).updatePrice(a2, ethers.parseUnits('20', 8), ts);

    // getPriceData：应返回结构体，不revert
    const pd = await priceOracle.getPriceData(a1);
    expect(pd.price).to.equal(ethers.parseUnits('10', 8));
    expect(pd.timestamp).to.equal(ts);
    expect(pd.decimals).to.equal(8);
    expect(pd.isValid).to.equal(true);

    // 批量
    const [prices, timestamps, decimals] = await priceOracle.getPrices([a1, a2]);
    expect(prices[0]).to.equal(ethers.parseUnits('10', 8));
    expect(prices[1]).to.equal(ethers.parseUnits('20', 8));
    expect(timestamps[0]).to.equal(ts);
    expect(decimals[1]).to.equal(8);

    // 有效性
    expect(await priceOracle.isPriceValid(a1)).to.equal(true);
  });

  it('批量更新价格：长度不匹配报错、零地址报错、零价格报错', async function () {
    const { governance, updater, priceOracle } = await deployFixture();
    const a1 = ethers.Wallet.createRandom().address;
    const a2 = ethers.Wallet.createRandom().address;
    await priceOracle.connect(governance).configureAsset(a1, 'a1', 8, 3600);
    await priceOracle.connect(governance).configureAsset(a2, 'a2', 8, 3600);

    const ts = await time.latest();
    await expect(
      priceOracle.connect(updater).updatePrices([a1], [ethers.parseUnits('1', 8), ethers.parseUnits('2', 8)], [ts])
    ).to.be.revertedWithCustomError(priceOracle, 'AmountMismatch');

    await expect(
      priceOracle.connect(updater).updatePrices([ethers.ZeroAddress], [ethers.parseUnits('1', 8)], [ts])
    ).to.be.revertedWithCustomError(priceOracle, 'ZeroAddress');

    await expect(
      priceOracle.connect(updater).updatePrices([a1], [0], [ts])
    ).to.be.revertedWithCustomError(priceOracle, 'PriceOracle__InvalidPrice');
  });

  it('边界：ZeroAddress 参数与未设置价格的行为', async function () {
    const { governance, priceOracle } = await deployFixture();
    const a1 = ethers.Wallet.createRandom().address;
    await priceOracle.connect(governance).configureAsset(a1, 'a1', 8, 3600);

    await expect(priceOracle.getPrice(ethers.ZeroAddress)).to.be.revertedWithCustomError(priceOracle, 'ZeroAddress');
    await expect(priceOracle.connect(governance).configureAsset(ethers.ZeroAddress, 'z', 8, 1)).to.be.revertedWithCustomError(priceOracle, 'ZeroAddress');

    // 未设置价格时：严格查询应 InvalidPrice
    await expect(priceOracle.getPrice(a1)).to.be.revertedWithCustomError(priceOracle, 'PriceOracle__InvalidPrice');
  });

  it('UUPS 升级：具备权限者可升级，不具备权限者拒绝', async function () {
    const { governance, updater, priceOracle } = await deployFixture();
    const factory = await ethers.getContractFactory('PriceOracle');
    await expect(upgrades.upgradeProxy(await priceOracle.getAddress(), factory.connect(governance))).to.not.be.reverted;
    await expect(upgrades.upgradeProxy(await priceOracle.getAddress(), factory.connect(updater))).to.be.reverted;
  });
});


