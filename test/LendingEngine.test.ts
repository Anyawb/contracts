import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

import { ModuleKeys } from '../frontend-config/moduleKeys';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * LendingEngine 测试模块
 * 
 * 测试目标:
 * - 合约初始化和权限控制
 * - 贷款订单创建和管理
 * - 还款功能和安全检查
 * - 事件记录和状态更新
 * - 边界条件和错误处理
 */
describe('LendingEngine – 贷款引擎测试', function () {
  // NOTE: there are two contracts named `LendingEngine` in this repo.
  // Hardhat requires fully-qualified name to avoid HH701.
  const LendingEngineFQN = 'src/core/LendingEngine.sol:LendingEngine';

  // ActionKeys (must match src/constants/ActionKeys.sol)
  const ACTION_ORDER_CREATE = ethers.keccak256(ethers.toUtf8Bytes('ORDER_CREATE'));
  const ACTION_REPAY = ethers.keccak256(ethers.toUtf8Bytes('REPAY'));
  const ACTION_PAUSE_SYSTEM = ethers.keccak256(ethers.toUtf8Bytes('PAUSE_SYSTEM'));
  const ACTION_UNPAUSE_SYSTEM = ethers.keccak256(ethers.toUtf8Bytes('UNPAUSE_SYSTEM'));
  const ACTION_VIEW_SYSTEM_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_SYSTEM_DATA'));
  const ACTION_UPGRADE_MODULE = ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE'));
  const ACTION_BORROW = ethers.keccak256(ethers.toUtf8Bytes('BORROW'));

  async function deployFixture() {
    const [governance, alice, bob, charlie] = await ethers.getSigners();

    // Lightweight registry + ACM for role checks
    const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
    await registry.waitForDeployment();

    const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
    await acm.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, await acm.getAddress());

    // Required module addresses for createLoanOrder() constraints
    const pool = await (await ethers.getContractFactory('SimpleMock')).deploy();
    await pool.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_LENDER_POOL_VAULT, await pool.getAddress());

    const rewardManager = await (await ethers.getContractFactory('MockRewardManager')).deploy();
    await rewardManager.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_RM, await rewardManager.getAddress());

    const feeRouter = await (await ethers.getContractFactory('MockFeeRouter')).deploy();
    await feeRouter.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_FR, await feeRouter.getAddress());

    // Deploy LendingEngine via UUPS proxy and initialize(registry)
    const LendingEngineF = await ethers.getContractFactory(LendingEngineFQN);
    const lendingEngine = await upgrades.deployProxy(LendingEngineF, [await registry.getAddress()], {
      kind: 'uups',
      initializer: 'initialize',
    });
    await lendingEngine.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_LE, await lendingEngine.getAddress());

    // Deploy LoanNFT via UUPS proxy and wire it (required for NFT mint in createLoanOrder)
    const LoanNFT = await ethers.getContractFactory('LoanNFT');
    const loanNFT = await upgrades.deployProxy(
      LoanNFT,
      ['Loan NFT', 'LOAN', 'https://api.example.com/token/', await registry.getAddress()],
      { kind: 'uups', initializer: 'initialize' },
    );
    await loanNFT.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_LOAN_NFT, await loanNFT.getAddress());

    // Permissions
    await acm.grantRole(ACTION_PAUSE_SYSTEM, governance.address);
    await acm.grantRole(ACTION_UNPAUSE_SYSTEM, governance.address);
    await acm.grantRole(ACTION_ORDER_CREATE, governance.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, governance.address);
    await acm.grantRole(ACTION_UPGRADE_MODULE, governance.address);
    // LoanNFT mint is executed by LendingEngine
    await acm.grantRole(ACTION_BORROW, await lendingEngine.getAddress());

    // Token for repay tests (if needed later)
    const mockToken = await (await ethers.getContractFactory('MockERC20')).deploy('Mock Token', 'MTK', ethers.parseEther('1000000'));
    await mockToken.waitForDeployment();
    await mockToken.transfer(alice.address, ethers.parseEther('1000'));
    await mockToken.transfer(bob.address, ethers.parseEther('1000'));
    await mockToken.transfer(charlie.address, ethers.parseEther('1000'));

    return { lendingEngine, loanNFT, feeRouter, mockToken, rewardManager, pool, registry, acm, governance, alice, bob, charlie };
  }

  describe('初始化测试', function () {
    it('应该正确初始化代理合约并写入 registry', async function () {
      const { lendingEngine, registry } = await loadFixture(deployFixture);
      expect(await lendingEngine._getRegistryForView()).to.equal(await registry.getAddress());
    });

    it('应该拒绝重复初始化', async function () {
      const { lendingEngine } = await loadFixture(deployFixture);
      await expect(lendingEngine.initialize(ethers.Wallet.createRandom().address)).to.be.revertedWithCustomError(
        lendingEngine,
        'InvalidInitialization',
      );
    });

    it('应该拒绝零地址初始化', async function () {
      await expect(
        upgrades.deployProxy(await ethers.getContractFactory(LendingEngineFQN), [ZERO_ADDRESS], { kind: 'uups', initializer: 'initialize' })
      ).to.be.revertedWithCustomError(await ethers.getContractFactory(LendingEngineFQN), 'LendingEngine__ZeroAddress');
    });
  });

  describe('权限控制测试', function () {
    it('应该拒绝非所有者调用管理功能', async function () {
      const { lendingEngine, alice, acm } = await loadFixture(deployFixture);
      await expect(lendingEngine.connect(alice).pause()).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('应该允许所有者暂停和恢复', async function () {
      const { lendingEngine, governance } = await loadFixture(deployFixture);
      
      await expect(lendingEngine.connect(governance).pause()).to.not.be.reverted;
      expect(await lendingEngine.paused()).to.be.true;
      
      await expect(lendingEngine.connect(governance).unpause()).to.not.be.reverted;
      expect(await lendingEngine.paused()).to.be.false;
    });

    it('应该拒绝非匹配引擎角色创建贷款订单', async function () {
      const { lendingEngine, alice, bob, mockToken, pool, acm } = await loadFixture(deployFixture);
      const order = {
        principal: ethers.parseEther('100'),
        rate: 500n, // 5%
        term: 5n * 24n * 60n * 60n, // 5 days (whitelisted)
        borrower: alice.address,
        lender: await pool.getAddress(), // must equal KEY_LENDER_POOL_VAULT
        asset: await mockToken.getAddress(),
        startTimestamp: 0n,
        maturity: 0n,
        repaidAmount: 0n,
      };

      await expect(lendingEngine.connect(bob).createLoanOrder(order)).to.be.revertedWithCustomError(acm, 'MissingRole');
    });
  });

  describe('事件记录测试', function () {
    it('应该在暂停时发出正确事件', async function () {
      const { lendingEngine, governance } = await loadFixture(deployFixture);
      
      await expect(lendingEngine.connect(governance).pause())
        .to.emit(lendingEngine, 'Paused')
        .withArgs(await governance.getAddress());
    });

    it('应该在恢复时发出正确事件', async function () {
      const { lendingEngine, governance } = await loadFixture(deployFixture);
      
      await lendingEngine.connect(governance).pause();
      
      await expect(lendingEngine.connect(governance).unpause())
        .to.emit(lendingEngine, 'Unpaused')
        .withArgs(await governance.getAddress());
    });
  });

  describe('安全功能测试', function () {
    it('应该在暂停状态下拒绝业务操作', async function () {
      const { lendingEngine, governance, mockToken, pool } = await loadFixture(deployFixture);
      await lendingEngine.connect(governance).pause();

      const order = {
        principal: ethers.parseEther('1'),
        rate: 500n,
        term: 5n * 24n * 60n * 60n,
        borrower: governance.address,
        lender: await pool.getAddress(),
        asset: await mockToken.getAddress(),
        startTimestamp: 0n,
        maturity: 0n,
        repaidAmount: 0n,
      };

      await expect(lendingEngine.connect(governance).createLoanOrder(order)).to.be.revertedWithCustomError(lendingEngine, 'PausedSystem');
    });

    it('应该验证合约状态一致性', async function () {
      const { lendingEngine, governance, acm } = await loadFixture(deployFixture);
      expect(await lendingEngine.paused()).to.be.false;
      expect(await acm.hasRole(ACTION_PAUSE_SYSTEM, governance.address)).to.equal(true);
      expect(await acm.hasRole(ACTION_UNPAUSE_SYSTEM, governance.address)).to.equal(true);
    });
  });

  describe('边界条件测试', function () {
    it('应该处理零金额操作', async function () {
      const { lendingEngine, alice, acm } = await loadFixture(deployFixture);
      await acm.grantRole(ACTION_REPAY, alice.address);
      await expect(lendingEngine.connect(alice).repay(0, 0)).to.be.revertedWithCustomError(lendingEngine, 'LendingEngine__InvalidOrder');
    });

    it('应该处理无效订单ID', async function () {
      const { lendingEngine, alice, acm } = await loadFixture(deployFixture);
      await acm.grantRole(ACTION_REPAY, alice.address);
      await expect(lendingEngine.connect(alice).repay(999999, ethers.parseEther('100'))).to.be.revertedWithCustomError(
        lendingEngine,
        'LendingEngine__InvalidOrder',
      );
    });
  });

  describe('集成测试', function () {
    it('应该正确设置匹配引擎角色', async function () {
      const { lendingEngine, acm, alice } = await loadFixture(deployFixture);
      await acm.grantRole(ACTION_ORDER_CREATE, alice.address);
      expect(await lendingEngine._isMatchEngineForView(alice.address)).to.equal(true);

      await acm.revokeRole(ACTION_ORDER_CREATE, alice.address);
      expect(await lendingEngine._isMatchEngineForView(alice.address)).to.equal(false);
    });

    it('应该正确查询贷款订单信息', async function () {
      const { lendingEngine, governance } = await loadFixture(deployFixture);
      const order = await lendingEngine.connect(governance)._getLoanOrderForView(0);
      expect(order.borrower).to.equal(ZERO_ADDRESS);
      expect(order.principal).to.equal(0n);
    });
  });

  describe('升级功能测试', function () {
    it('应该支持合约升级授权', async function () {
      const { lendingEngine, governance } = await loadFixture(deployFixture);
      const nextImpl = await (await ethers.getContractFactory(LendingEngineFQN)).deploy();
      await nextImpl.waitForDeployment();
      await expect(lendingEngine.connect(governance).upgradeToAndCall(await nextImpl.getAddress(), '0x')).to.not.be.reverted;
    });

    it('应该验证升级权限控制', async function () {
      const { lendingEngine, alice, acm } = await loadFixture(deployFixture);
      const nextImpl = await (await ethers.getContractFactory(LendingEngineFQN)).deploy();
      await nextImpl.waitForDeployment();
      await expect(lendingEngine.connect(alice).upgradeToAndCall(await nextImpl.getAddress(), '0x')).to.be.revertedWithCustomError(acm, 'MissingRole');
    });
  });

  describe('错误处理测试', function () {
    it('应该正确处理无效参数', async function () {
      const { lendingEngine, alice, acm } = await loadFixture(deployFixture);
      await acm.grantRole(ACTION_REPAY, alice.address);
      await expect(lendingEngine.connect(alice).repay(0, ethers.parseEther('100'))).to.be.revertedWithCustomError(
        lendingEngine,
        'LendingEngine__InvalidOrder',
      );
    });

    it('应该正确处理重复操作', async function () {
      const { lendingEngine, governance } = await loadFixture(deployFixture);
      
      // 测试重复暂停
      await lendingEngine.connect(governance).pause();
      await expect(lendingEngine.connect(governance).pause()).to.be.revertedWithCustomError(lendingEngine, 'EnforcedPause');
      
      // 测试重复恢复
      await lendingEngine.connect(governance).unpause();
      await expect(lendingEngine.connect(governance).unpause()).to.be.revertedWithCustomError(lendingEngine, 'ExpectedPause');
    });
  });
}); 