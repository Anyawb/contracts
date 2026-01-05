import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;

describe('VaultBusinessLogic – 统计视图联动（最小集）', function () {
  it('deposit/borrow/repay/withdraw 推动统计视图快照变化', async function () {
    const [owner, user] = await ethers.getSigners();

    // 部署 Mock 合约
    const RegistryF = await ethers.getContractFactory('MockRegistry');
    const registry = await RegistryF.deploy();
    await registry.waitForDeployment();

    const CollateralF = await ethers.getContractFactory('MockCollateralManager');
    const cm = await CollateralF.deploy();
    await cm.waitForDeployment();

    const LendingF = await ethers.getContractFactory('MockLendingEngineConcrete');
    const le = await LendingF.deploy();
    await le.waitForDeployment();

    const GuaranteeF = await ethers.getContractFactory('MockGuaranteeFundManager');
    const gf = await GuaranteeF.deploy();
    await gf.waitForDeployment();

    const RewardF = await ethers.getContractFactory('MockRewardManager');
    const rm = await RewardF.deploy();
    await rm.waitForDeployment();

    const AssetWhitelistF = await ethers.getContractFactory('MockAssetWhitelist');
    const aw = await AssetWhitelistF.deploy();
    await aw.waitForDeployment();

    // 使用真实 ERC20 资产，避免非合约地址触发转账失败
    const TokenF = await ethers.getContractFactory('MockERC20');
    const token = await TokenF.deploy('Test Token', 'TT', ethers.parseUnits('1000000', 18));
    await token.waitForDeployment();
    // 给 user 分配足够余额并授权 VBL
    await token.transfer(await user.getAddress(), ethers.parseUnits('1000', 18));
    const LiquidationViewF = await ethers.getContractFactory('MockLiquidationEventsView');
    const lv = await LiquidationViewF.deploy();
    await lv.waitForDeployment();

    const StatsF = await ethers.getContractFactory('MockStatisticsView');
    const stats = await StatsF.deploy();
    await stats.waitForDeployment();

    const VBLF = await ethers.getContractFactory('VaultBusinessLogic');
    const vblImpl = await VBLF.deploy();
    await vblImpl.waitForDeployment();
    const ProxyF = await ethers.getContractFactory('ERC1967Proxy');
    const proxy = await ProxyF.deploy(vblImpl.target, '0x');
    await proxy.waitForDeployment();
    const vbl = VBLF.attach(proxy.target);
    await vbl.initialize(await registry.getAddress(), await owner.getAddress());

    // 注册模块（KEY_STATS 优先链路）
    const KEY_CM = ethers.keccak256(ethers.toUtf8Bytes('COLLATERAL_MANAGER'));
    const KEY_LE = ethers.keccak256(ethers.toUtf8Bytes('LENDING_ENGINE'));
    const KEY_STATS = ethers.keccak256(ethers.toUtf8Bytes('VAULT_STATISTICS'));
    const KEY_GUARANTEE_FUND = ethers.keccak256(ethers.toUtf8Bytes('GUARANTEE_FUND_MANAGER'));
    const KEY_RM = ethers.keccak256(ethers.toUtf8Bytes('REWARD_MANAGER'));
    const KEY_ASSET_WHITELIST = ethers.keccak256(ethers.toUtf8Bytes('ASSET_WHITELIST'));

    await registry.setModule(KEY_CM, await cm.getAddress());
    await registry.setModule(KEY_LE, await le.getAddress());
    await registry.setModule(KEY_STATS, await stats.getAddress());
    await registry.setModule(KEY_GUARANTEE_FUND, await gf.getAddress());
    await registry.setModule(KEY_RM, await rm.getAddress());
    await registry.setModule(KEY_ASSET_WHITELIST, await aw.getAddress());
    await registry.setModule(ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATION_VIEW')), await lv.getAddress());

    // 快速 sanity check：确保 Registry 模块已写入
    expect(await registry.getModule(KEY_CM)).to.equal(await cm.getAddress());
    expect(await registry.getModule(KEY_LE)).to.equal(await le.getAddress());
    expect(await registry.getModule(KEY_STATS)).to.equal(await stats.getAddress());
    expect(await registry.getModule(KEY_GUARANTEE_FUND)).to.equal(await gf.getAddress());
    expect(await registry.getModule(KEY_RM)).to.equal(await rm.getAddress());
    expect(await registry.getModule(KEY_ASSET_WHITELIST)).to.equal(await aw.getAddress());

    // 资产地址
    const asset = await token.getAddress();
    await aw.setAssetAllowed(asset, true);
    await token.connect(user).approve(vbl.target, ethers.parseUnits('1000', 18));

    // 初始快照
    let snap = await stats.getGlobalSnapshot();
    expect(snap.totalCollateral).to.equal(0n);
    expect(snap.totalDebt).to.equal(0n);

    // deposit 推动 collateral 增长
    await vbl.deposit(await user.getAddress(), asset, ethers.parseUnits('10', 18));
    snap = await stats.getGlobalSnapshot();
    expect(snap.totalCollateral).to.equal(ethers.parseUnits('10', 18));

    // borrow 推动 debt 增长
    await vbl.borrow(await user.getAddress(), asset, ethers.parseUnits('5', 18));
    snap = await stats.getGlobalSnapshot();
    expect(snap.totalDebt).to.equal(ethers.parseUnits('5', 18));

    // repay 减少 debt
    await vbl.repay(await user.getAddress(), asset, ethers.parseUnits('3', 18));
    snap = await stats.getGlobalSnapshot();
    expect(snap.totalDebt).to.equal(ethers.parseUnits('2', 18));

    // withdraw 减少 collateral
    await vbl.withdraw(await user.getAddress(), asset, ethers.parseUnits('4', 18));
    snap = await stats.getGlobalSnapshot();
    expect(snap.totalCollateral).to.equal(ethers.parseUnits('6', 18));
  });
});


