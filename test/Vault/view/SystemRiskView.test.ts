import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { ethers, upgrades } from 'hardhat';

const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
const KEY_LIQUIDATION_RISK_MANAGER = ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATION_RISK_MANAGER'));

const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
const ACTION_VIEW_RISK_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_RISK_DATA'));

describe('SystemRiskView', function () {
  async function deployFixture() {
    const [admin, riskViewer, other] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
    const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
    const riskManager = await (await ethers.getContractFactory('MockLiquidationRiskManager')).deploy();

    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(KEY_LIQUIDATION_RISK_MANAGER, await riskManager.getAddress());

    await acm.grantRole(ACTION_ADMIN, admin.address);
    await acm.grantRole(ACTION_VIEW_RISK_DATA, riskViewer.address);

    await riskManager.updateLiquidationThreshold(9_500n);
    await riskManager.updateMinHealthFactor(10_500n);
    await riskManager.updateMaxLtvBps(7_500n);

    const systemRiskView = await upgrades.deployProxy(
      await ethers.getContractFactory('SystemRiskView'),
      [await registry.getAddress()],
      { kind: 'uups', initializer: 'initialize' },
    );

    return { systemRiskView, registry, acm, riskManager, admin, riskViewer, other };
  }

  it('exposes version info after initialization', async function () {
    const { systemRiskView } = await loadFixture(deployFixture);

    expect(await systemRiskView.apiVersion()).to.equal(1n);
    expect(await systemRiskView.schemaVersion()).to.equal(1n);
  });

  it('rejects zero-address initialization', async function () {
    const impl = await (await ethers.getContractFactory('SystemRiskView')).deploy();
    await impl.waitForDeployment();

    await expect(
      upgrades.deployProxy(await ethers.getContractFactory('SystemRiskView'), [ethers.ZeroAddress], {
        kind: 'uups',
        initializer: 'initialize',
      }),
    ).to.be.revertedWithCustomError(impl, 'ZeroAddress');
  });

  it('allows VIEW_RISK_DATA and admin reads, and blocks unauthorized callers', async function () {
    const { systemRiskView, admin, riskViewer, other } = await loadFixture(deployFixture);

    await expect(systemRiskView.connect(other).getLiquidationThreshold()).to.be.revertedWithCustomError(
      systemRiskView,
      'MissingRole',
    );

    expect(await systemRiskView.connect(riskViewer).getLiquidationThreshold()).to.equal(9_500n);
    expect(await systemRiskView.connect(riskViewer).getMinHealthFactor()).to.equal(10_500n);
    expect(await systemRiskView.connect(admin).getMaxLtvBps()).to.equal(7_500n);
  });

  it('reflects updated risk-manager values', async function () {
    const { systemRiskView, riskManager, admin } = await loadFixture(deployFixture);

    await riskManager.updateLiquidationThreshold(8_800n);
    await riskManager.updateMinHealthFactor(11_100n);
    await riskManager.updateMaxLtvBps(6_600n);

    expect(await systemRiskView.connect(admin).getLiquidationThreshold()).to.equal(8_800n);
    expect(await systemRiskView.connect(admin).getMinHealthFactor()).to.equal(11_100n);
    expect(await systemRiskView.connect(admin).getMaxLtvBps()).to.equal(6_600n);
  });
});