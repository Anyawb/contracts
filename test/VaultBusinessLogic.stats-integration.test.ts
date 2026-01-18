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

    // Mock ACM：用于给 VaultRouter（调用者）授予 ACTION_VIEW_PUSH
    const ACMF = await ethers.getContractFactory('MockAccessControlManager');
    const acm = await ACMF.deploy();
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

    // Ledger mocks required by PositionView module resolution (onlyBusinessContract)
    const CMF = await ethers.getContractFactory('MockCollateralManager');
    const cm = await CMF.deploy();
    await cm.waitForDeployment();

    const LEF = await ethers.getContractFactory('MockLendingEngineBasic');
    const le = await LEF.deploy();
    await le.waitForDeployment();

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

    // Deploy minimal PositionView to satisfy VaultRouter.pushUserPositionUpdateDelta forwarding
    const PositionViewF = await ethers.getContractFactory('PositionView');
    const positionView = await upgrades.deployProxy(PositionViewF, [await registry.getAddress()], {
      kind: 'uups',
      initializer: 'initialize',
    });
    await positionView.waitForDeployment();

    // Deploy VaultCore mock: satisfies VaultRouter.onlyVaultCore and provides viewContractAddrVar for PositionView
    const VaultCoreViewF = await ethers.getContractFactory('MockVaultCoreView');
    const vaultCoreModule = await VaultCoreViewF.deploy();
    await vaultCoreModule.waitForDeployment();
    await vaultCoreModule.setViewContractAddr(await router.getAddress());
    await vaultCoreModule.setLendingEngine(ethers.ZeroAddress);

    // Registry wiring:
    const KEY_STATS = ethers.keccak256(ethers.toUtf8Bytes('VAULT_STATISTICS'));
    const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
    const KEY_VAULT_CORE = ethers.keccak256(ethers.toUtf8Bytes('VAULT_CORE'));
    const KEY_VAULT_BUSINESS_LOGIC = ethers.keccak256(ethers.toUtf8Bytes('VAULT_BUSINESS_LOGIC'));
    const KEY_POSITION_VIEW = ethers.keccak256(ethers.toUtf8Bytes('POSITION_VIEW'));
    const KEY_CM = ethers.keccak256(ethers.toUtf8Bytes('COLLATERAL_MANAGER'));
    const KEY_LE = ethers.keccak256(ethers.toUtf8Bytes('LENDING_ENGINE'));
    await registry.setModule(KEY_STATS, await stats.getAddress());
    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(KEY_VAULT_CORE, await vaultCoreModule.getAddress());
    await registry.setModule(KEY_VAULT_BUSINESS_LOGIC, await owner.getAddress());
    await registry.setModule(KEY_POSITION_VIEW, await positionView.getAddress());
    await registry.setModule(KEY_CM, await cm.getAddress());
    await registry.setModule(KEY_LE, await le.getAddress());

    // Grant ACTION_VIEW_PUSH to VaultRouter so it can write PositionView
    const ACTION_VIEW_PUSH = ethers.keccak256(ethers.toUtf8Bytes('ACTION_VIEW_PUSH'));
    await acm.grantRole(ACTION_VIEW_PUSH, await router.getAddress());

    const asset = await settlementToken.getAddress();
    const userAddr = await user.getAddress();

    // Seed ledger state so the first delta push (when cache is invalid) can sync from ledger
    // and subsequent negative deltas won't underflow cached values.
    await cm.depositCollateral(userAddr, asset, ethers.parseUnits('10', 18));

    let snap = await stats.getGlobalSnapshot();
    expect(snap.totalCollateral).to.equal(0n);
    expect(snap.totalDebt).to.equal(0n);

    // deposit: +10 collateral (must go through VaultCore -> VaultRouter due to onlyVaultCore)
    await vaultCoreModule.pushUserPositionUpdateDelta(
      userAddr,
      asset,
      ethers.parseUnits('10', 18),
      0,
      ethers.ZeroHash,
      0,
      0
    );
    snap = await stats.getGlobalSnapshot();
    expect(snap.totalCollateral).to.equal(ethers.parseUnits('10', 18));

    // borrow: +5 debt
    await vaultCoreModule.pushUserPositionUpdateDelta(
      userAddr,
      asset,
      0,
      ethers.parseUnits('5', 18),
      ethers.ZeroHash,
      0,
      0
    );
    snap = await stats.getGlobalSnapshot();
    expect(snap.totalDebt).to.equal(ethers.parseUnits('5', 18));

    // repay: -3 debt
    await vaultCoreModule.pushUserPositionUpdateDelta(
      userAddr,
      asset,
      0,
      -ethers.parseUnits('3', 18),
      ethers.ZeroHash,
      0,
      0
    );
    snap = await stats.getGlobalSnapshot();
    expect(snap.totalDebt).to.equal(ethers.parseUnits('2', 18));

    // withdraw: -4 collateral
    await vaultCoreModule.pushUserPositionUpdateDelta(
      userAddr,
      asset,
      -ethers.parseUnits('4', 18),
      0,
      ethers.ZeroHash,
      0,
      0
    );
    snap = await stats.getGlobalSnapshot();
    expect(snap.totalCollateral).to.equal(ethers.parseUnits('6', 18));
  });
});


