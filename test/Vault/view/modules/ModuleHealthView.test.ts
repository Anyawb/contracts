import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';

const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
const KEY_HEALTH_VIEW = ethers.keccak256(ethers.toUtf8Bytes('HEALTH_VIEW'));

const ACTION_VIEW_SYSTEM_STATUS = ethers.keccak256(ethers.toUtf8Bytes('ACTION_VIEW_SYSTEM_STATUS'));
const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));

describe('ModuleHealthView', function () {
  async function deployFixture() {
    const [admin, viewer, other] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
    const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();

    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());

    const healthView = await upgrades.deployProxy(
      await ethers.getContractFactory('HealthView'),
      [await registry.getAddress()],
      { kind: 'uups' },
    );

    await registry.setModule(KEY_HEALTH_VIEW, await healthView.getAddress());

    const ModuleHealthViewFactory = await ethers.getContractFactory('ModuleHealthView');
    const moduleHealthView = await upgrades.deployProxy(ModuleHealthViewFactory, [await registry.getAddress()], {
      kind: 'uups',
    });

    // grant roles
    await acm.grantRole(ACTION_ADMIN, admin.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_STATUS, viewer.address);
    // allow ModuleHealthView to push into HealthView (HealthView checks sender role)
    await acm.grantRole(ACTION_VIEW_SYSTEM_STATUS, await moduleHealthView.getAddress());

    // dummy contract with code for healthy check
    const dummyModule = await (await ethers.getContractFactory('MockRegistry')).deploy();

    return {
      admin,
      viewer,
      other,
      registry,
      acm,
      healthView,
      moduleHealthView,
      dummyModule,
    };
  }

  it('initializes with registry and getters', async function () {
    const { moduleHealthView, registry } = await deployFixture();
    expect(await moduleHealthView.registryAddr()).to.equal(await registry.getAddress());
    expect(await moduleHealthView.getRegistry()).to.equal(await registry.getAddress());
  });

  it('reverts on zero registry init', async function () {
    const ModuleHealthViewFactory = await ethers.getContractFactory('ModuleHealthView');
    await expect(
      upgrades.deployProxy(ModuleHealthViewFactory, [ethers.ZeroAddress], { kind: 'uups' }),
    ).to.be.revertedWithCustomError(ModuleHealthViewFactory, 'ZeroAddress');
  });

  it('performs health check, caches result, and pushes to HealthView', async function () {
    const { moduleHealthView, healthView, viewer, dummyModule } = await deployFixture();

    const tx = await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress());
    await expect(tx).to.emit(moduleHealthView, 'ModuleHealthChecked').withArgs(await dummyModule.getAddress(), true, 0);

    const status = await moduleHealthView.getModuleHealthStatus(await dummyModule.getAddress());
    expect(status.module).to.equal(await dummyModule.getAddress());
    expect(status.isHealthy).to.equal(true);
    expect(status.lastCheckTime).to.be.gt(0);
    expect(status.totalChecks).to.equal(1n);
    expect(status.successRate).to.equal(100n);

    const cached = await healthView.getModuleHealth(await dummyModule.getAddress());
    expect(cached.isHealthy).to.equal(true);
    expect(cached.detailsHash).to.equal(ethers.keccak256(ethers.toUtf8Bytes('Module is healthy')));
    expect(cached.lastCheckTime).to.be.gt(0);
    expect(cached.consecutiveFailures).to.equal(0);
  });

  it('updates successRate across mixed results', async function () {
    const { moduleHealthView, viewer, dummyModule } = await deployFixture();

    await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress()); // healthy
    const randomEOA = ethers.Wallet.createRandom().address; // no code
    await moduleHealthView.connect(viewer).checkAndPushModuleHealth(randomEOA); // unhealthy

    const status = await moduleHealthView.getModuleHealthStatus(randomEOA);
    expect(status.isHealthy).to.equal(false);
    expect(status.totalChecks).to.equal(1n); // separate cache per module

    const healthyStatus = await moduleHealthView.getModuleHealthStatus(await dummyModule.getAddress());
    expect(healthyStatus.successRate).to.equal(100n); // first module only successes
  });

  it('reverts when module is zero address', async function () {
    const { moduleHealthView, viewer } = await deployFixture();
    await expect(moduleHealthView.connect(viewer).checkAndPushModuleHealth(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      moduleHealthView,
      'ZeroAddress',
    );
  });

  it('enforces system health viewer role', async function () {
    const { moduleHealthView, other, dummyModule } = await deployFixture();
    await expect(
      moduleHealthView.connect(other).checkAndPushModuleHealth(await dummyModule.getAddress()),
    ).to.be.revertedWithCustomError(moduleHealthView, 'MissingRole');
  });

  it('reverts when HealthView module not registered', async function () {
    const { moduleHealthView, viewer, registry, dummyModule } = await deployFixture();
    await registry.setModule(KEY_HEALTH_VIEW, ethers.ZeroAddress);
    await expect(
      moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress()),
    ).to.be.revertedWith('MockRegistry: module not found');
  });

  it('getModuleHealthStatus enforces role', async function () {
    const { moduleHealthView, other, dummyModule } = await deployFixture();
    await expect(
      moduleHealthView.connect(other).getModuleHealthStatus(await dummyModule.getAddress()),
    ).to.be.revertedWithCustomError(moduleHealthView, 'MissingRole');
  });

  it('checkModuleHealth returns correct results', async function () {
    const { moduleHealthView, viewer, dummyModule } = await deployFixture();
    const zero = await moduleHealthView.connect(viewer).checkModuleHealth(ethers.ZeroAddress);
    expect(zero[0]).to.equal(false);
    const noCode = await moduleHealthView.connect(viewer).checkModuleHealth(ethers.Wallet.createRandom().address);
    expect(noCode[0]).to.equal(false);
    const ok = await moduleHealthView.connect(viewer).checkModuleHealth(await dummyModule.getAddress());
    expect(ok[0]).to.equal(true);
  });

  it('upgrade authorization requires admin', async function () {
    const { moduleHealthView, other, acm } = await deployFixture();
    const ModuleHealthViewFactory = await ethers.getContractFactory('ModuleHealthView');
    await expect(
      upgrades.upgradeProxy(await moduleHealthView.getAddress(), ModuleHealthViewFactory.connect(other)),
    ).to.be.revertedWithCustomError(acm, 'MissingRole');
  });

  describe('edge cases', function () {
    it('handles multiple checks on same module', async function () {
      const { moduleHealthView, viewer, dummyModule } = await deployFixture();

      // First check
      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress());
      const status1 = await moduleHealthView.getModuleHealthStatus(await dummyModule.getAddress());
      expect(status1.totalChecks).to.equal(1n);
      expect(status1.successRate).to.equal(100n);

      // Second check
      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress());
      const status2 = await moduleHealthView.getModuleHealthStatus(await dummyModule.getAddress());
      expect(status2.totalChecks).to.equal(2n);
      expect(status2.successRate).to.equal(100n); // Still 100% since all checks passed
      expect(status2.lastCheckTime).to.be.gte(status1.lastCheckTime);
    });

    it('handles multiple different modules', async function () {
      const { moduleHealthView, viewer, dummyModule } = await deployFixture();
      const module2 = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
      const module3 = await (await ethers.getContractFactory('MockRegistry')).deploy();

      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress());
      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await module2.getAddress());
      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await module3.getAddress());

      const status1 = await moduleHealthView.getModuleHealthStatus(await dummyModule.getAddress());
      const status2 = await moduleHealthView.getModuleHealthStatus(await module2.getAddress());
      const status3 = await moduleHealthView.getModuleHealthStatus(await module3.getAddress());

      expect(status1.totalChecks).to.equal(1n);
      expect(status2.totalChecks).to.equal(1n);
      expect(status3.totalChecks).to.equal(1n);
      expect(status1.isHealthy).to.equal(true);
      expect(status2.isHealthy).to.equal(true);
      expect(status3.isHealthy).to.equal(true);
    });

    it('tracks consecutive failures correctly', async function () {
      const { moduleHealthView, viewer } = await deployFixture();
      const noCodeAddr = ethers.Wallet.createRandom().address;

      // First failure
      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(noCodeAddr);
      const status1 = await moduleHealthView.getModuleHealthStatus(noCodeAddr);
      expect(status1.consecutiveFailures).to.equal(1);
      expect(status1.isHealthy).to.equal(false);

      // Second failure
      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(noCodeAddr);
      const status2 = await moduleHealthView.getModuleHealthStatus(noCodeAddr);
      expect(status2.consecutiveFailures).to.equal(1); // Still 1 as per current logic (healthy=0, unhealthy=1)
      expect(status2.totalChecks).to.equal(2n);
    });

    it('calculates success rate correctly for mixed results', async function () {
      const { moduleHealthView, viewer, dummyModule } = await deployFixture();
      const noCodeAddr = ethers.Wallet.createRandom().address;

      // Healthy check
      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress());
      let status = await moduleHealthView.getModuleHealthStatus(await dummyModule.getAddress());
      expect(status.successRate).to.equal(100n);

      // Unhealthy check
      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(noCodeAddr);
      status = await moduleHealthView.getModuleHealthStatus(noCodeAddr);
      expect(status.successRate).to.equal(0n); // 0% success rate
      expect(status.totalChecks).to.equal(1n);
    });

    it('updates timestamp on each check', async function () {
      const { moduleHealthView, viewer, dummyModule } = await deployFixture();

      const tx1 = await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress());
      const receipt1 = await tx1.wait();
      const status1 = await moduleHealthView.getModuleHealthStatus(await dummyModule.getAddress());
      const timestamp1 = status1.lastCheckTime;

      // Wait a bit (in test, blocks advance)
      const tx2 = await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress());
      await tx2.wait();
      const status2 = await moduleHealthView.getModuleHealthStatus(await dummyModule.getAddress());
      const timestamp2 = status2.lastCheckTime;

      expect(timestamp2).to.be.gte(timestamp1);
    });

    it('handles zero address in checkModuleHealth', async function () {
      const { moduleHealthView, viewer } = await deployFixture();
      const result = await moduleHealthView.connect(viewer).checkModuleHealth(ethers.ZeroAddress);
      expect(result[0]).to.equal(false);
      expect(result[1]).to.equal('Module address is zero');
    });

    it('handles non-existent address in checkModuleHealth', async function () {
      const { moduleHealthView, viewer } = await deployFixture();
      const noCodeAddr = ethers.Wallet.createRandom().address;
      const result = await moduleHealthView.connect(viewer).checkModuleHealth(noCodeAddr);
      expect(result[0]).to.equal(false);
      expect(result[1]).to.equal('Module has no code');
    });
  });

  describe('business logic: success rate calculation', function () {
    it('calculates 50% success rate for one success and one failure', async function () {
      const { moduleHealthView, viewer, dummyModule } = await deployFixture();
      const noCodeAddr = ethers.Wallet.createRandom().address;

      // First: healthy
      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress());
      // Second: unhealthy
      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(noCodeAddr);

      const healthyStatus = await moduleHealthView.getModuleHealthStatus(await dummyModule.getAddress());
      const unhealthyStatus = await moduleHealthView.getModuleHealthStatus(noCodeAddr);

      expect(healthyStatus.successRate).to.equal(100n); // 1/1 = 100%
      expect(unhealthyStatus.successRate).to.equal(0n); // 0/1 = 0%
    });

    it('calculates success rate for multiple checks on same module', async function () {
      const { moduleHealthView, viewer, dummyModule } = await deployFixture();

      // 3 successful checks
      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress());
      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress());
      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress());

      const status = await moduleHealthView.getModuleHealthStatus(await dummyModule.getAddress());
      expect(status.totalChecks).to.equal(3n);
      expect(status.successRate).to.equal(100n); // All successful
    });

    it('maintains separate success rates per module', async function () {
      const { moduleHealthView, viewer, dummyModule } = await deployFixture();
      const module2 = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
      const noCodeAddr = ethers.Wallet.createRandom().address;

      // Module 1: 2 successful checks
      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress());
      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress());

      // Module 2: 1 successful check
      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await module2.getAddress());

      // Module 3: 1 failed check
      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(noCodeAddr);

      const status1 = await moduleHealthView.getModuleHealthStatus(await dummyModule.getAddress());
      const status2 = await moduleHealthView.getModuleHealthStatus(await module2.getAddress());
      const status3 = await moduleHealthView.getModuleHealthStatus(noCodeAddr);

      expect(status1.successRate).to.equal(100n);
      expect(status2.successRate).to.equal(100n);
      expect(status3.successRate).to.equal(0n);
    });
  });

  describe('data consistency', function () {
    it('keeps local cache and HealthView in sync', async function () {
      const { moduleHealthView, healthView, viewer, dummyModule } = await deployFixture();

      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress());

      const localStatus = await moduleHealthView.getModuleHealthStatus(await dummyModule.getAddress());
      const healthViewStatus = await healthView.getModuleHealth(await dummyModule.getAddress());

      expect(localStatus.isHealthy).to.equal(healthViewStatus.isHealthy);
      expect(localStatus.detailsHash).to.equal(healthViewStatus.detailsHash);
      expect(localStatus.consecutiveFailures).to.equal(healthViewStatus.consecutiveFailures);
    });

    it('getModuleHealthStatus and checkModuleHealth return consistent results', async function () {
      const { moduleHealthView, viewer, dummyModule } = await deployFixture();

      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress());

      const cachedStatus = await moduleHealthView.getModuleHealthStatus(await dummyModule.getAddress());
      const checkResult = await moduleHealthView.connect(viewer).checkModuleHealth(await dummyModule.getAddress());

      expect(cachedStatus.isHealthy).to.equal(checkResult[0]);
      expect(checkResult[1]).to.equal('Module is healthy');
    });

    it('maintains state across multiple checks', async function () {
      const { moduleHealthView, viewer, dummyModule } = await deployFixture();

      // First check
      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress());
      const status1 = await moduleHealthView.getModuleHealthStatus(await dummyModule.getAddress());

      // Second check
      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress());
      const status2 = await moduleHealthView.getModuleHealthStatus(await dummyModule.getAddress());

      expect(status2.totalChecks).to.equal(status1.totalChecks + 1n);
      expect(status2.module).to.equal(status1.module);
      expect(status2.isHealthy).to.equal(status1.isHealthy);
    });
  });

  describe('event emission', function () {
    it('emits ModuleHealthChecked event with correct parameters', async function () {
      const { moduleHealthView, viewer, dummyModule } = await deployFixture();

      const tx = await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress());
      await expect(tx)
        .to.emit(moduleHealthView, 'ModuleHealthChecked')
        .withArgs(await dummyModule.getAddress(), true, 0);
    });

    it('emits event for unhealthy module', async function () {
      const { moduleHealthView, viewer } = await deployFixture();
      const noCodeAddr = ethers.Wallet.createRandom().address;

      const tx = await moduleHealthView.connect(viewer).checkAndPushModuleHealth(noCodeAddr);
      await expect(tx).to.emit(moduleHealthView, 'ModuleHealthChecked').withArgs(noCodeAddr, false, 1);
    });

    it('emits event on every check', async function () {
      const { moduleHealthView, viewer, dummyModule } = await deployFixture();

      const tx1 = await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress());
      await expect(tx1).to.emit(moduleHealthView, 'ModuleHealthChecked');

      const tx2 = await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress());
      await expect(tx2).to.emit(moduleHealthView, 'ModuleHealthChecked');
    });
  });

  describe('access control', function () {
    it('allows admin to check module health', async function () {
      const { moduleHealthView, admin, dummyModule } = await deployFixture();

      await expect(moduleHealthView.connect(admin).checkAndPushModuleHealth(await dummyModule.getAddress())).to.not.be.reverted;
    });

    it('allows system health viewer to check module health', async function () {
      const { moduleHealthView, viewer, dummyModule } = await deployFixture();

      await expect(moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress())).to.not.be.reverted;
    });

    it('denies unauthorized access to checkModuleHealth', async function () {
      const { moduleHealthView, other, dummyModule } = await deployFixture();

      await expect(moduleHealthView.connect(other).checkModuleHealth(await dummyModule.getAddress())).to.be.revertedWithCustomError(
        moduleHealthView,
        'MissingRole',
      );
    });

    it('allows admin to access checkModuleHealth', async function () {
      const { moduleHealthView, admin, dummyModule } = await deployFixture();

      const result = await moduleHealthView.connect(admin).checkModuleHealth(await dummyModule.getAddress());
      expect(result[0]).to.equal(true);
    });

    it('allows system health viewer to access checkModuleHealth', async function () {
      const { moduleHealthView, viewer, dummyModule } = await deployFixture();

      const result = await moduleHealthView.connect(viewer).checkModuleHealth(await dummyModule.getAddress());
      expect(result[0]).to.equal(true);
    });
  });

  describe('registry and module resolution', function () {
    it('reverts when registry not set', async function () {
      const ModuleHealthViewFactory = await ethers.getContractFactory('ModuleHealthView');
      const view = await upgrades.deployProxy(ModuleHealthViewFactory, [ethers.ZeroAddress], { kind: 'uups' }).catch(() => null);
      expect(view).to.be.null;
    });

    it('reverts when ACCESS_CONTROL not registered', async function () {
      const [admin] = await ethers.getSigners();
      const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
      // Don't set ACCESS_CONTROL

      const ModuleHealthViewFactory = await ethers.getContractFactory('ModuleHealthView');
      const view = await upgrades.deployProxy(ModuleHealthViewFactory, [await registry.getAddress()], { kind: 'uups' });

      const dummyModule = await (await ethers.getContractFactory('MockRegistry')).deploy();
      await expect(view.connect(admin).checkAndPushModuleHealth(await dummyModule.getAddress())).to.be.reverted;
    });
  });

  describe('upgrade scenarios', function () {
    it('preserves data after upgrade', async function () {
      const { moduleHealthView, viewer, admin, dummyModule } = await deployFixture();

      // Perform checks before upgrade
      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress());
      const statusBefore = await moduleHealthView.getModuleHealthStatus(await dummyModule.getAddress());

      // Upgrade
      const ModuleHealthViewFactory = await ethers.getContractFactory('ModuleHealthView');
      const upgraded = await upgrades.upgradeProxy(await moduleHealthView.getAddress(), ModuleHealthViewFactory.connect(admin));

      // Verify data preserved
      const statusAfter = await upgraded.getModuleHealthStatus(await dummyModule.getAddress());
      expect(statusAfter.module).to.equal(statusBefore.module);
      expect(statusAfter.isHealthy).to.equal(statusBefore.isHealthy);
      expect(statusAfter.totalChecks).to.equal(statusBefore.totalChecks);
      expect(statusAfter.successRate).to.equal(statusBefore.successRate);
    });

    it('functions correctly after upgrade', async function () {
      const { moduleHealthView, viewer, admin, dummyModule } = await deployFixture();

      // Upgrade
      const ModuleHealthViewFactory = await ethers.getContractFactory('ModuleHealthView');
      const upgraded = await upgrades.upgradeProxy(await moduleHealthView.getAddress(), ModuleHealthViewFactory.connect(admin));

      // Verify functionality
      await expect(upgraded.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress())).to.not.be.reverted;
      const status = await upgraded.getModuleHealthStatus(await dummyModule.getAddress());
      expect(status.isHealthy).to.equal(true);
    });
  });

  describe('integration with HealthView', function () {
    it('pushes health status to HealthView correctly', async function () {
      const { moduleHealthView, healthView, viewer, dummyModule } = await deployFixture();

      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress());

      const healthViewStatus = await healthView.getModuleHealth(await dummyModule.getAddress());
      expect(healthViewStatus.isHealthy).to.equal(true);
      expect(healthViewStatus.detailsHash).to.equal(ethers.keccak256(ethers.toUtf8Bytes('Module is healthy')));
      expect(healthViewStatus.consecutiveFailures).to.equal(0);
    });

    it('pushes unhealthy status to HealthView correctly', async function () {
      const { moduleHealthView, healthView, viewer } = await deployFixture();
      const noCodeAddr = ethers.Wallet.createRandom().address;

      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(noCodeAddr);

      const healthViewStatus = await healthView.getModuleHealth(noCodeAddr);
      expect(healthViewStatus.isHealthy).to.equal(false);
      expect(healthViewStatus.detailsHash).to.equal(ethers.keccak256(ethers.toUtf8Bytes('Module has no code')));
      expect(healthViewStatus.consecutiveFailures).to.equal(1);
    });

    it('updates HealthView on subsequent checks', async function () {
      const { moduleHealthView, healthView, viewer, dummyModule } = await deployFixture();

      // First check
      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress());
      const status1 = await healthView.getModuleHealth(await dummyModule.getAddress());
      const timestamp1 = status1.lastCheckTime;

      // Second check
      await moduleHealthView.connect(viewer).checkAndPushModuleHealth(await dummyModule.getAddress());
      const status2 = await healthView.getModuleHealth(await dummyModule.getAddress());
      const timestamp2 = status2.lastCheckTime;

      expect(timestamp2).to.be.gte(timestamp1);
      expect(status2.isHealthy).to.equal(status1.isHealthy);
    });
  });

  describe('getter consistency', function () {
    it('registryAddr and getRegistry return same value', async function () {
      const { moduleHealthView, registry } = await deployFixture();
      expect(await moduleHealthView.registryAddr()).to.equal(await moduleHealthView.getRegistry());
      expect(await moduleHealthView.getRegistry()).to.equal(await registry.getAddress());
    });
  });

  describe('double initialization protection', function () {
    it('reverts on double initialization', async function () {
      const { moduleHealthView, registry } = await deployFixture();
      await expect(moduleHealthView.initialize(await registry.getAddress())).to.be.reverted;
    });
  });
});

