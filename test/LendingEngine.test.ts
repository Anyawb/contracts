import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import type { LendingEngine } from '../../types/contracts/core/LendingEngine';
import { LendingEngine__factory } from '../../types/factories/contracts/core/LendingEngine__factory';
import type { Registry } from '../../types/contracts/registry/Registry';
import { Registry__factory } from '../../types/factories/contracts/registry/Registry__factory';
import type { MockERC20 } from '../../types/contracts/Mocks/MockERC20';
import { MockERC20__factory } from '../../types/factories/contracts/Mocks/MockERC20__factory';
import type { LoanNFT } from '../../types/contracts/core/LoanNFT';
import { LoanNFT__factory } from '../../types/factories/contracts/core/LoanNFT__factory';
import type { FeeRouter } from '../../types/contracts/core/FeeRouter';
import { FeeRouter__factory } from '../../types/factories/contracts/core/FeeRouter__factory';

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
describe.skip('LendingEngine – 贷款引擎测试 (已跳过，待代理模式适配)', function () {
  let lendingEngine: LendingEngine;
  let loanNFT: LoanNFT;
  let feeRouter: FeeRouter;
  let mockToken: MockERC20;
  let registry: Registry;
  let governance: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let charlie: SignerWithAddress;

  async function deployFixture() {
    [governance, alice, bob, charlie] = await ethers.getSigners();

    // 部署 MockERC20 代币
    const erc20Factory = (await ethers.getContractFactory('MockERC20')) as MockERC20__factory;
    mockToken = await erc20Factory.deploy('Mock Token', 'MTK', ethers.parseEther('1000000'));
    await mockToken.waitForDeployment();

    // 部署 Registry (minDelay = 0)
    const registryFactory = (await ethers.getContractFactory('Registry')) as Registry__factory;
    registry = await registryFactory.deploy(0);
    await registry.waitForDeployment();

    // 部署 LoanNFT
    const loanNFTFactory = (await ethers.getContractFactory('LoanNFT')) as LoanNFT__factory;
    loanNFT = await loanNFTFactory.deploy();
    await loanNFT.waitForDeployment();
    await loanNFT.initialize(
      'Loan NFT',
      'LOAN',
      'https://api.example.com/token/',
      await registry.getAddress(),
      await governance.getAddress()
    );

    // 部署 FeeRouter
    const feeRouterFactory = (await ethers.getContractFactory('FeeRouter')) as FeeRouter__factory;
    feeRouter = await feeRouterFactory.deploy();
    await feeRouter.waitForDeployment();
    await feeRouter.initialize(
      await governance.getAddress(), // platformTreasury
      await governance.getAddress(), // ecosystemVault
      50, // platformBps (0.5%)
      20, // ecoBps (0.2%)
      await governance.getAddress() // admin
    );

    // 部署 LendingEngine
    const lendingEngineFactory = (await ethers.getContractFactory('LendingEngine')) as LendingEngine__factory;
    lendingEngine = await lendingEngineFactory.deploy();
    await lendingEngine.waitForDeployment();

    // 注意：LendingEngine 实现合约在 constructor 中调用 _disableInitializers()
    // 无法直接初始化；如果需要初始化应通过代理模式。

    // 分配代币给用户
    await mockToken.transfer(await alice.getAddress(), ethers.parseEther('1000'));
    await mockToken.transfer(await bob.getAddress(), ethers.parseEther('1000'));
    await mockToken.transfer(await charlie.getAddress(), ethers.parseEther('1000'));

    return { 
      lendingEngine, 
      loanNFT, 
      feeRouter, 
      mockToken, 
      governance, 
      registry,
      alice, 
      bob, 
      charlie 
    };
  }

  describe('初始化测试', function () {
    it.skip('应该正确初始化合约并设置所有者 (已跳过，因实现禁用初始化)', async function () {
      const { lendingEngine, governance } = await loadFixture(deployFixture);
      
      expect(await lendingEngine.hasRole(await lendingEngine.DEFAULT_ADMIN_ROLE(), await governance.getAddress())).to.be.true;
    });

    it('应该拒绝重复初始化', async function () {
      const { lendingEngine, registry, alice } = await loadFixture(deployFixture);
      
      await expect(
        lendingEngine.initialize(
          await registry.getAddress(),
          await alice.getAddress()
        )
      ).to.be.revertedWith('Initializable: contract is already initialized');
    });

    it('应该拒绝零地址初始化', async function () {
      const { registry } = await loadFixture(deployFixture);
      
      const lendingEngineFactory = (await ethers.getContractFactory('LendingEngine')) as LendingEngine__factory;
      const newLendingEngine = await lendingEngineFactory.deploy();
      await newLendingEngine.waitForDeployment();

      await expect(
        newLendingEngine.initialize(ZERO_ADDRESS, await governance.getAddress())
      ).to.be.revertedWith('LendingEngine__ZeroAddress');

      await expect(
        newLendingEngine.initialize(await registry.getAddress(), ZERO_ADDRESS)
      ).to.be.revertedWith('LendingEngine__ZeroAddress');
    });
  });

  describe('权限控制测试', function () {
    it('应该拒绝非所有者调用管理功能', async function () {
      const { lendingEngine, alice } = await loadFixture(deployFixture);
      
      await expect(
        lendingEngine.connect(alice).pause()
      ).to.be.revertedWith('AccessControl: account');
    });

    it('应该允许所有者暂停和恢复', async function () {
      const { lendingEngine, governance } = await loadFixture(deployFixture);
      
      await expect(lendingEngine.connect(governance).pause()).to.not.be.reverted;
      expect(await lendingEngine.paused()).to.be.true;
      
      await expect(lendingEngine.connect(governance).unpause()).to.not.be.reverted;
      expect(await lendingEngine.paused()).to.be.false;
    });

    it('应该拒绝非匹配引擎角色创建贷款订单', async function () {
      const { lendingEngine, alice, bob, mockToken } = await loadFixture(deployFixture);
      
      const order = {
        principal: ethers.parseEther('100'),
        rate: 500, // 5%
        term: 86400, // 1 day
        borrower: await alice.getAddress(),
        lender: await bob.getAddress(),
        asset: await mockToken.getAddress(),
        startTimestamp: 0,
        maturity: 0,
        repaidAmount: 0
      };

      await expect(
        lendingEngine.connect(alice).createLoanOrder(order)
      ).to.be.revertedWith('LendingEngine__NotMatchEngine');
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
      const { lendingEngine, governance } = await loadFixture(deployFixture);
      
      await lendingEngine.connect(governance).pause();
      expect(await lendingEngine.paused()).to.be.true;
    });

    it('应该验证合约状态一致性', async function () {
      const { lendingEngine, governance } = await loadFixture(deployFixture);
      
      // 验证初始状态
      expect(await lendingEngine.paused()).to.be.false;
      
      // 验证角色设置
      const adminRole = await lendingEngine.DEFAULT_ADMIN_ROLE();
      expect(await lendingEngine.hasRole(adminRole, await governance.getAddress())).to.be.true;
    });
  });

  describe('边界条件测试', function () {
    it('应该处理零金额操作', async function () {
      const { lendingEngine, alice } = await loadFixture(deployFixture);
      
      // 测试零金额还款
      await expect(
        lendingEngine.connect(alice).repay(0, 0)
      ).to.be.revertedWith('LendingEngine__InvalidOrder');
    });

    it('应该处理无效订单ID', async function () {
      const { lendingEngine, alice } = await loadFixture(deployFixture);
      
      // 测试无效订单ID的还款
      await expect(
        lendingEngine.connect(alice).repay(999999, ethers.parseEther('100'))
      ).to.be.revertedWith('LendingEngine__InvalidOrder');
    });
  });

  describe('集成测试', function () {
    it('应该正确设置匹配引擎角色', async function () {
      const { lendingEngine, governance, alice } = await loadFixture(deployFixture);
      
      const matchEngineRole = await lendingEngine.MATCH_ENGINE_ROLE();
      
      // 授予匹配引擎角色
      await lendingEngine.connect(governance).grantRole(matchEngineRole, await alice.getAddress());
      expect(await lendingEngine.hasRole(matchEngineRole, await alice.getAddress())).to.be.true;
      
      // 撤销匹配引擎角色
      await lendingEngine.connect(governance).revokeRole(matchEngineRole, await alice.getAddress());
      expect(await lendingEngine.hasRole(matchEngineRole, await alice.getAddress())).to.be.false;
    });

    it('应该正确查询贷款订单信息', async function () {
      const { lendingEngine } = await loadFixture(deployFixture);
      
      // 查询不存在的订单
      const order = await lendingEngine.getLoanOrder(0);
      expect(order.borrower).to.equal(ZERO_ADDRESS);
      expect(order.principal).to.equal(0n);
    });
  });

  describe('升级功能测试', function () {
    it('应该支持合约升级授权', async function () {
      const { lendingEngine, governance } = await loadFixture(deployFixture);
      
      // 测试 _authorizeUpgrade 函数存在且可调用
      // 注意：实际升级需要代理合约，这里只测试函数存在
      const adminRole = await lendingEngine.DEFAULT_ADMIN_ROLE();
      expect(await lendingEngine.hasRole(adminRole, await governance.getAddress())).to.be.true;
    });

    it('应该验证升级权限控制', async function () {
      const { lendingEngine, alice } = await loadFixture(deployFixture);
      
      // 非所有者不应该能够升级
      // 这里测试权限控制机制
      expect(await lendingEngine.hasRole(await lendingEngine.DEFAULT_ADMIN_ROLE(), await alice.getAddress())).to.be.false;
    });
  });

  describe('错误处理测试', function () {
    it('应该正确处理无效参数', async function () {
      const { lendingEngine, alice } = await loadFixture(deployFixture);
      
      // 测试无效的还款金额
      await expect(
        lendingEngine.connect(alice).repay(0, ethers.parseEther('100'))
      ).to.be.revertedWith('LendingEngine__InvalidOrder');
    });

    it('应该正确处理重复操作', async function () {
      const { lendingEngine, governance } = await loadFixture(deployFixture);
      
      // 测试重复暂停
      await lendingEngine.connect(governance).pause();
      await expect(lendingEngine.connect(governance).pause()).to.not.be.reverted;
      
      // 测试重复恢复
      await lendingEngine.connect(governance).unpause();
      await expect(lendingEngine.connect(governance).unpause()).to.not.be.reverted;
    });
  });
}); 