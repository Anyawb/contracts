import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import type { 
  VaultStatistics,
  VaultStatistics__factory,
  Registry,
  Registry__factory
} from '../../types';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ONE_ETH = ethers.parseUnits('1', 18);
const ONE_USD = ethers.parseUnits('1', 6);

describe('VaultStatistics – 修复版测试', function () {
  let signers: SignerWithAddress[];
  let vaultStatistics: VaultStatistics;
  let registry: Registry;
  let governance: SignerWithAddress;
  let vault: SignerWithAddress;
  let users: SignerWithAddress[];

  async function deployFixture() {
    signers = await ethers.getSigners();
    governance = signers[0];
    vault = signers[1];
    users = signers.slice(2, 12); // 使用 10 个用户账户

    // 部署 Registry
    const RegistryFactory = (await ethers.getContractFactory('Registry')) as Registry__factory;
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();
    await registry.initialize(0); // 初始化时设置 minDelay

    // 部署 VaultStatistics 合约
    const VaultStatisticsFactory = (await ethers.getContractFactory('VaultStatistics')) as VaultStatistics__factory;
    vaultStatistics = await VaultStatisticsFactory.deploy();
    await vaultStatistics.waitForDeployment();

    // 不在 deployFixture 中初始化，避免重复初始化错误
    // 初始化将在测试中按需进行

    return { 
      vaultStatistics, 
      governance, 
      vault, 
      users,
      registry,
      signers 
    };
  }

  describe('初始化测试', function () {
    it('应正确初始化合约', async function () {
      const { vaultStatistics, governance, registry } = await loadFixture(deployFixture);
      
      // 在测试中初始化
      await vaultStatistics.initialize(await governance.getAddress(), await registry.getAddress());
      
      // 验证初始化状态
      expect(await vaultStatistics.activeUsers()).to.equal(0n);
      const globalSnapshot = await vaultStatistics.getGlobalSnapshot();
      expect(globalSnapshot).to.not.be.undefined;
    });

    it('初始化时不应接受零地址', async function () {
      const { vaultStatistics, governance, registry } = await loadFixture(deployFixture);

      // 治理地址为零
      await expect(
        vaultStatistics.initialize(ZERO_ADDRESS, await registry.getAddress())
      ).to.be.revertedWithCustomError(vaultStatistics, 'ZeroAddress');

      // Registry 地址为零
      await expect(
        vaultStatistics.initialize(await governance.getAddress(), ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(vaultStatistics, 'ZeroAddress');
    });

    it('不应重复初始化', async function () {
      const { vaultStatistics, governance, registry } = await loadFixture(deployFixture);

      // 第一次初始化
      await vaultStatistics.initialize(await governance.getAddress(), await registry.getAddress());

      // 第二次初始化应该失败
      await expect(
        vaultStatistics.initialize(await governance.getAddress(), await registry.getAddress())
      ).to.be.revertedWith('Initializable: contract is already initialized');
    });
  });

  describe('View 函数测试', function () {
    beforeEach(async function () {
      const { vaultStatistics, governance, registry } = await loadFixture(deployFixture);
      await vaultStatistics.initialize(await governance.getAddress(), await registry.getAddress());
    });

    it('应正确返回用户快照', async function () {
      const { vaultStatistics, users } = await loadFixture(deployFixture);
      const user = users[0];
      const snapshot = await vaultStatistics.getUserSnapshot(user.address);
      
      expect(snapshot.collateral).to.equal(0n);
      expect(snapshot.debt).to.equal(0n);
      expect(snapshot.ltv).to.equal(0n);
      expect(snapshot.healthFactor).to.equal(0n);
      expect(snapshot.timestamp).to.equal(0n);
      expect(snapshot.isActive).to.be.false;
    });

    it('应正确返回全局快照', async function () {
      const { vaultStatistics } = await loadFixture(deployFixture);
      const snapshot = await vaultStatistics.getGlobalSnapshot();
      
      expect(snapshot.totalCollateral).to.equal(0n);
      expect(snapshot.totalDebt).to.equal(0n);
      expect(snapshot.averageLTV).to.equal(0n);
      expect(snapshot.averageHealthFactor).to.be.oneOf([0n, 10000n]); // 可能是 0 或 10000
      expect(snapshot.activeUsers).to.equal(0n);
      expect(snapshot.timestamp).to.be.gt(0n);
    });
  });

  describe('权限控制测试', function () {
    beforeEach(async function () {
      const { vaultStatistics, governance, registry } = await loadFixture(deployFixture);
      await vaultStatistics.initialize(await governance.getAddress(), await registry.getAddress());
    });

    it('只有治理者可以更新用户统计', async function () {
      const { vaultStatistics, users, governance } = await loadFixture(deployFixture);
      const user = users[0];

      // 治理者可以更新
      await expect(
        vaultStatistics.connect(governance).updateUserStats(
          user.address,
          ONE_ETH, // collateral
          ONE_ETH / 2n, // debt
          5000n, // ltv (50%)
          15000n // healthFactor (150%)
        )
      ).to.not.be.reverted;

      // 非治理者不能更新
      await expect(
        vaultStatistics.connect(user).updateUserStats(
          user.address,
          ONE_ETH,
          ONE_ETH / 2n,
          5000n,
          15000n
        )
      ).to.be.revertedWithCustomError(vaultStatistics, 'NotGovernance');
    });
  });

  describe('统计更新测试', function () {
    beforeEach(async function () {
      const { vaultStatistics, governance, registry } = await loadFixture(deployFixture);
      await vaultStatistics.initialize(await governance.getAddress(), await registry.getAddress());
    });

    it('应正确更新用户统计', async function () {
      const { vaultStatistics, users, governance } = await loadFixture(deployFixture);
      const user = users[0];

      const collateral = ONE_ETH;
      const debt = ONE_ETH / 2n;
      const ltv = 5000n; // 50%
      const healthFactor = 15000n; // 150%

      await vaultStatistics.connect(governance).updateUserStats(
        user.address,
        collateral,
        debt,
        ltv,
        healthFactor
      );

      const snapshot = await vaultStatistics.getUserSnapshot(user.address);
      expect(snapshot.collateral).to.equal(collateral);
      expect(snapshot.debt).to.equal(debt);
      expect(snapshot.ltv).to.equal(ltv);
      expect(snapshot.healthFactor).to.equal(healthFactor);
      expect(snapshot.isActive).to.be.true;
    });

    it('应正确更新全局统计', async function () {
      const { vaultStatistics, users, governance } = await loadFixture(deployFixture);
      const user1 = users[0];
      const user2 = users[1];

      // 更新第一个用户
      await vaultStatistics.connect(governance).updateUserStats(
        user1.address,
        ONE_ETH,
        ONE_ETH / 2n,
        5000n,
        15000n
      );

      // 更新第二个用户
      await vaultStatistics.connect(governance).updateUserStats(
        user2.address,
        ONE_ETH * 2n,
        ONE_ETH,
        5000n,
        20000n
      );

      const globalSnapshot = await vaultStatistics.getGlobalSnapshot();
      expect(globalSnapshot.totalCollateral).to.equal(ONE_ETH * 3n);
      expect(globalSnapshot.totalDebt).to.equal(ONE_ETH * 3n / 2n);
      expect(globalSnapshot.activeUsers).to.equal(2n);
    });
  });

  describe('事件测试', function () {
    beforeEach(async function () {
      const { vaultStatistics, governance, registry } = await loadFixture(deployFixture);
      await vaultStatistics.initialize(await governance.getAddress(), await registry.getAddress());
    });

    it('应发出用户统计更新事件', async function () {
      const { vaultStatistics, users, governance } = await loadFixture(deployFixture);
      const user = users[0];

      await expect(
        vaultStatistics.connect(governance).updateUserStats(
          user.address,
          ONE_ETH,
          ONE_ETH / 2n,
          5000n,
          15000n
        )
      ).to.emit(vaultStatistics, 'UserStatsUpdated')
        .withArgs(user.address, ONE_ETH, ONE_ETH / 2n, 5000n, 15000n);
    });

    it('应发出全局统计更新事件', async function () {
      const { vaultStatistics, users, governance } = await loadFixture(deployFixture);
      const user = users[0];

      await expect(
        vaultStatistics.connect(governance).updateUserStats(
          user.address,
          ONE_ETH,
          ONE_ETH / 2n,
          5000n,
          15000n
        )
      ).to.emit(vaultStatistics, 'GlobalStatsUpdated')
        .withArgs(ONE_ETH, ONE_ETH / 2n, 5000n, 15000n, 1n);
    });
  });

  describe('边界条件测试', function () {
    beforeEach(async function () {
      const { vaultStatistics, governance, registry } = await loadFixture(deployFixture);
      await vaultStatistics.initialize(await governance.getAddress(), await registry.getAddress());
    });

    it('应处理零值统计', async function () {
      const { vaultStatistics, users, governance } = await loadFixture(deployFixture);
      const user = users[0];

      await expect(
        vaultStatistics.connect(governance).updateUserStats(
          user.address,
          0n, // 零抵押品
          0n, // 零债务
          0n, // 零 LTV
          0n  // 零健康因子
        )
      ).to.not.be.reverted;

      const snapshot = await vaultStatistics.getUserSnapshot(user.address);
      expect(snapshot.collateral).to.equal(0n);
      expect(snapshot.debt).to.equal(0n);
      expect(snapshot.ltv).to.equal(0n);
      expect(snapshot.healthFactor).to.equal(0n);
      expect(snapshot.isActive).to.be.false; // 零值应该标记为非活跃
    });

    it('应处理极大值', async function () {
      const { vaultStatistics, users, governance } = await loadFixture(deployFixture);
      const user = users[0];

      const maxValue = ethers.MaxUint256;
      const maxLTV = 10000n; // 100%
      const maxHealthFactor = 100000n; // 1000%

      await expect(
        vaultStatistics.connect(governance).updateUserStats(
          user.address,
          maxValue,
          maxValue,
          maxLTV,
          maxHealthFactor
        )
      ).to.not.be.reverted;
    });
  });

  describe('Gas 优化测试', function () {
    beforeEach(async function () {
      const { vaultStatistics, governance, registry } = await loadFixture(deployFixture);
      await vaultStatistics.initialize(await governance.getAddress(), await registry.getAddress());
    });

    it('应验证 Gas 消耗在合理范围内', async function () {
      const { vaultStatistics, users, governance } = await loadFixture(deployFixture);
      const user = users[0];

      const tx = await vaultStatistics.connect(governance).updateUserStats(
        user.address,
        ONE_ETH,
        ONE_ETH / 2n,
        5000n,
        15000n
      );
      const receipt = await tx.wait();

      // 验证 Gas 消耗在合理范围内（通常 < 100,000 gas）
      expect(receipt?.gasUsed).to.be.lt(100000n);
    });
  });
}); 