import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers, upgrades } = hardhat;

/**
 * 统计快照的更新来源已迁移为 VaultRouter 的 best-effort push（由 VaultCore 推送 position delta 时触发）。
 * 因此这里用 VaultRouter + MockStatisticsView 的最小集成来验证：collateral/debt 的增减能反映到快照里。
 */
describe('VaultRouter → StatisticsView – 统计视图联动（最小集）', function () {
  it('deposit/borrow/repay/withdraw 的 delta 推动统计视图快照变化', async function () {
    const [owner, user] = await ethers.getSigners();

    const RegistryF = await ethers.getContractFactory('MockRegistry');
    const registry = await RegistryF.deploy();
    await registry.waitForDeployment();

    // AccessControlManager：owner 默认持有 ACTION_SET_PARAMETER，可开启 testingMode
    const ACMF = await ethers.getContractFactory('AccessControlManager');
    const acm = await ACMF.deploy(await owner.getAddress());
    await acm.waitForDeployment();

    const StatsF = await ethers.getContractFactory('MockStatisticsView');
    const stats = await StatsF.deploy();
    await stats.waitForDeployment();

    const AssetWhitelistF = await ethers.getContractFactory('MockAssetWhitelist');
    const aw = await AssetWhitelistF.deploy();
    await aw.waitForDeployment();

    const PriceOracleF = await ethers.getContractFactory('MockPriceOracle');
    const po = await PriceOracleF.deploy();
    await po.waitForDeployment();

    const TokenF = await ethers.getContractFactory('MockERC20');
    const settlementToken = await TokenF.deploy('Settlement', 'SET', ethers.parseUnits('1000000', 18));
    await settlementToken.waitForDeployment();

    const RouterF = await ethers.getContractFactory('VaultRouter');
    const router = await upgrades.deployProxy(
      RouterF,
      [
        await registry.getAddress(),
        await aw.getAddress(),
        await po.getAddress(),
        await settlementToken.getAddress(),
        await owner.getAddress(), // initialOwner
      ],
      { kind: 'uups', initializer: 'initialize' }
    );
    await router.waitForDeployment();

    // Registry wiring（VaultRouter._tryPushUserStatsUpdateFromDelta 只依赖 KEY_STATS；setTestingMode 依赖 KEY_ACCESS_CONTROL）
    const KEY_STATS = ethers.keccak256(ethers.toUtf8Bytes('VAULT_STATISTICS'));
    const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
    await registry.setModule(KEY_STATS, await stats.getAddress());
    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());

    // 开启 testingMode，绕过 onlyVaultCore 限制（且不配置 PositionView）
    await router.connect(owner).setTestingMode(true);

    const asset = await settlementToken.getAddress();
    const userAddr = await user.getAddress();

    let snap = await stats.getGlobalSnapshot();
    expect(snap.totalCollateral).to.equal(0n);
    expect(snap.totalDebt).to.equal(0n);

    // deposit: +10 collateral (选择明确的重载签名，避免 ethers v6 "ambiguous function" 报错)
    await router['pushUserPositionUpdateDelta(address,address,int256,int256)'](
      userAddr,
      asset,
      ethers.parseUnits('10', 18),
      0
    );
    snap = await stats.getGlobalSnapshot();
    expect(snap.totalCollateral).to.equal(ethers.parseUnits('10', 18));

    // borrow: +5 debt
    await router['pushUserPositionUpdateDelta(address,address,int256,int256)'](
      userAddr,
      asset,
      0,
      ethers.parseUnits('5', 18)
    );
    snap = await stats.getGlobalSnapshot();
    expect(snap.totalDebt).to.equal(ethers.parseUnits('5', 18));

    // repay: -3 debt
    await router['pushUserPositionUpdateDelta(address,address,int256,int256)'](
      userAddr,
      asset,
      0,
      -ethers.parseUnits('3', 18)
    );
    snap = await stats.getGlobalSnapshot();
    expect(snap.totalDebt).to.equal(ethers.parseUnits('2', 18));

    // withdraw: -4 collateral
    await router['pushUserPositionUpdateDelta(address,address,int256,int256)'](
      userAddr,
      asset,
      -ethers.parseUnits('4', 18),
      0
    );
    snap = await stats.getGlobalSnapshot();
    expect(snap.totalCollateral).to.equal(ethers.parseUnits('6', 18));
  });
});


