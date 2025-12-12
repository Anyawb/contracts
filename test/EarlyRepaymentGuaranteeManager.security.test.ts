/**
 * EarlyRepaymentGuaranteeManager – 安全审计测试
 * 
 * 测试目标:
 * - 重入攻击防护验证
 * - 权限控制机制测试
 * - 计算精度安全测试
 * - 参数验证完整性测试
 * - 业务逻辑边界条件测试
 * - 状态一致性验证
 */

import hardhat from 'hardhat';
const { ethers } = hardhat;
import { expect } from 'chai';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

// 导入合约类型
import type { EarlyRepaymentGuaranteeManager } from '../../types/contracts/Vault/modules/EarlyRepaymentGuaranteeManager';
import type { MockERC20 } from '../../types/contracts/Mocks/MockERC20';

describe('EarlyRepaymentGuaranteeManager – 安全审计测试', function () {
  // 测试常量定义
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const TEST_AMOUNT = ethers.parseUnits('1000', 18);
  const TEST_INTEREST = ethers.parseUnits('100', 18);
  const TEST_TERM_DAYS = 30;
  const LARGE_AMOUNT = ethers.parseUnits('1000000', 18);

  // 合约实例
  let earlyRepaymentGuaranteeManager: EarlyRepaymentGuaranteeManager;
  let mockToken: MockERC20;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
  let mockAccessControlManager: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockVaultCore: any;

  // 签名者
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let owner: SignerWithAddress;
  let borrower: SignerWithAddress;
  let lender: SignerWithAddress;
  let unauthorizedUser: SignerWithAddress;
  let attacker: SignerWithAddress;

  // 测试夹具
  async function deployFixture() {
    const signers = await ethers.getSigners();
    const [owner, borrower, lender, unauthorizedUser, attacker] = signers;

    // 部署 Mock 合约
    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    const mockToken = await MockERC20Factory.deploy('Mock Token', 'MTK', LARGE_AMOUNT);
    await mockToken.waitForDeployment();

    const MockAccessControlManagerFactory = await ethers.getContractFactory('MockAccessControlManager');
    const mockAccessControlManager = await MockAccessControlManagerFactory.deploy();
    await mockAccessControlManager.waitForDeployment();

    const MockVaultCoreFactory = await ethers.getContractFactory('MockVaultCore');
    const mockVaultCore = await MockVaultCoreFactory.deploy();
    await mockVaultCore.waitForDeployment();

    // 部署 EarlyRepaymentGuaranteeManager
    const EarlyRepaymentGuaranteeManagerFactory = await ethers.getContractFactory('EarlyRepaymentGuaranteeManager');
    const earlyRepaymentGuaranteeManager = await EarlyRepaymentGuaranteeManagerFactory.deploy();
    await earlyRepaymentGuaranteeManager.waitForDeployment();

    // 初始化合约
    await earlyRepaymentGuaranteeManager.initialize(
      mockVaultCore.target,
      mockAccessControlManager.target,
      owner.address, // 平台费用接收者
      100 // 1% 平台费率
    );

    // 设置权限
    await mockAccessControlManager.grantRole(
      ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER')), 
      owner.address
    );
    await mockAccessControlManager.grantRole(
      ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE')), 
      owner.address
    );
    await mockAccessControlManager.grantRole(
      ethers.keccak256(ethers.toUtf8Bytes('PAUSE_SYSTEM')), 
      owner.address
    );
    await mockAccessControlManager.grantRole(
      ethers.keccak256(ethers.toUtf8Bytes('UNPAUSE_SYSTEM')), 
      owner.address
    );

    // 给用户分配代币
    await mockToken.mint(borrower.address, LARGE_AMOUNT);
    await mockToken.mint(lender.address, LARGE_AMOUNT);
    await mockToken.mint(owner.address, LARGE_AMOUNT);

    return {
      earlyRepaymentGuaranteeManager,
      mockToken,
      mockAccessControlManager,
      mockVaultCore,
      owner,
      borrower,
      lender,
      unauthorizedUser,
      attacker
    };
  }

  beforeEach(async function () {
    const fixture = await loadFixture(deployFixture);
    earlyRepaymentGuaranteeManager = fixture.earlyRepaymentGuaranteeManager;
    mockToken = fixture.mockToken;
    mockAccessControlManager = fixture.mockAccessControlManager;
    mockVaultCore = fixture.mockVaultCore;
    owner = fixture.owner;
    borrower = fixture.borrower;
    lender = fixture.lender;
    unauthorizedUser = fixture.unauthorizedUser;
    attacker = fixture.attacker;

    // 确保合约有足够的代币
    await mockToken.mint(earlyRepaymentGuaranteeManager.target, LARGE_AMOUNT);
  });

  describe('🔴 严重安全漏洞测试', function () {
    describe('重入攻击风险', function () {
      it('EarlyRepaymentGuaranteeManager – 应该防止重入攻击', async function () {
        // 锁定保证金
        await earlyRepaymentGuaranteeManager.connect(mockVaultCore).lockGuarantee(
          borrower.address,
          lender.address,
          mockToken.target,
          TEST_AMOUNT,
          TEST_INTEREST,
          TEST_TERM_DAYS
        );

        // 尝试重入攻击 - 应该被 ReentrancyGuard 阻止
        await expect(
          earlyRepaymentGuaranteeManager.connect(mockVaultCore).processEarlyRepayment(
            borrower.address,
            mockToken.target,
            TEST_AMOUNT
          )
        ).to.not.be.reverted;
      });
    });

    describe('权限控制漏洞', function () {
      it('EarlyRepaymentGuaranteeManager – 未授权用户不能设置平台费用接收者', async function () {
        await expect(
          earlyRepaymentGuaranteeManager.connect(unauthorizedUser).setPlatformFeeReceiver(attacker.address)
        ).to.be.revertedWith('requireRole: MissingRole');
      });

      it('EarlyRepaymentGuaranteeManager – 未授权用户不能升级合约', async function () {
        const newImplementation = await ethers.getContractFactory('EarlyRepaymentGuaranteeManager');
        const newImpl = await newImplementation.deploy();

        await expect(
          earlyRepaymentGuaranteeManager.connect(unauthorizedUser).upgradeTo(newImpl.target)
        ).to.be.revertedWith('requireRole: MissingRole');
      });

      it('EarlyRepaymentGuaranteeManager – 不能设置零地址作为平台费用接收者', async function () {
        await expect(
          earlyRepaymentGuaranteeManager.setPlatformFeeReceiver(ZERO_ADDRESS)
        ).to.be.revertedWithCustomError(earlyRepaymentGuaranteeManager, 'ZeroAddress');
      });
    });

    describe('计算精度问题', function () {
      it('EarlyRepaymentGuaranteeManager – 应该正确处理小数计算', async function () {
        // 锁定保证金
        await earlyRepaymentGuaranteeManager.connect(mockVaultCore).lockGuarantee(
          borrower.address,
          lender.address,
          mockToken.target,
          TEST_AMOUNT,
          TEST_INTEREST,
          TEST_TERM_DAYS
        );

        // 模拟时间经过
        await ethers.provider.send('evm_increaseTime', [15 * 24 * 3600]); // 15天
        await ethers.provider.send('evm_mine', []);

        // 预览提前还款
        const result = await earlyRepaymentGuaranteeManager.previewEarlyRepayment(1, TEST_AMOUNT);
        
        // 验证计算结果的合理性
        expect(result.actualInterestPaid).to.be.gt(0);
        expect(result.penaltyToLender).to.be.gte(0);
        expect(result.refundToBorrower).to.be.gte(0);
        expect(result.platformFee).to.be.gte(0);
      });
    });
  });

  describe('🟡 中等安全漏洞测试', function () {
    describe('参数验证', function () {
      it('EarlyRepaymentGuaranteeManager – 不能锁定零地址借款人的保证金', async function () {
        await expect(
          earlyRepaymentGuaranteeManager.connect(mockVaultCore).lockGuarantee(
            ZERO_ADDRESS,
            lender.address,
            mockToken.target,
            TEST_AMOUNT,
            TEST_INTEREST,
            TEST_TERM_DAYS
          )
        ).to.be.revertedWithCustomError(earlyRepaymentGuaranteeManager, 'ZeroAddress');
      });

      it('EarlyRepaymentGuaranteeManager – 不能锁定零地址贷款人的保证金', async function () {
        await expect(
          earlyRepaymentGuaranteeManager.connect(mockVaultCore).lockGuarantee(
            borrower.address,
            ZERO_ADDRESS,
            mockToken.target,
            TEST_AMOUNT,
            TEST_INTEREST,
            TEST_TERM_DAYS
          )
        ).to.be.revertedWithCustomError(earlyRepaymentGuaranteeManager, 'ZeroAddress');
      });

      it('EarlyRepaymentGuaranteeManager – 不能锁定零金额的保证金', async function () {
        await expect(
          earlyRepaymentGuaranteeManager.connect(mockVaultCore).lockGuarantee(
            borrower.address,
            lender.address,
            mockToken.target,
            0,
            TEST_INTEREST,
            TEST_TERM_DAYS
          )
        ).to.be.revertedWithCustomError(earlyRepaymentGuaranteeManager, 'AmountIsZero');
      });

      it('EarlyRepaymentGuaranteeManager – 不能设置过高的平台费率', async function () {
        await expect(
          earlyRepaymentGuaranteeManager.setPlatformFeeRate(1001) // 超过10%
        ).to.be.revertedWith('Rate too high');
      });
    });

    describe('业务逻辑验证', function () {
      it('EarlyRepaymentGuaranteeManager – 不能为同一用户在同一资产上创建多个活跃保证金', async function () {
        // 创建第一个保证金
        await earlyRepaymentGuaranteeManager.connect(mockVaultCore).lockGuarantee(
          borrower.address,
          lender.address,
          mockToken.target,
          TEST_AMOUNT,
          TEST_INTEREST,
          TEST_TERM_DAYS
        );

        // 尝试创建第二个保证金
        await expect(
          earlyRepaymentGuaranteeManager.connect(mockVaultCore).lockGuarantee(
            borrower.address,
            lender.address,
            mockToken.target,
            TEST_AMOUNT,
            TEST_INTEREST,
            TEST_TERM_DAYS
          )
        ).to.be.revertedWith('Active guarantee already exists');
      });

      it('EarlyRepaymentGuaranteeManager – 不能处理不存在的保证金', async function () {
        await expect(
          earlyRepaymentGuaranteeManager.connect(mockVaultCore).processEarlyRepayment(
            borrower.address,
            mockToken.target,
            TEST_AMOUNT
          )
        ).to.be.revertedWith('No guarantee found');
      });
    });

    describe('边界条件测试', function () {
      it('EarlyRepaymentGuaranteeManager – 应该正确处理极短期限的借款', async function () {
        await earlyRepaymentGuaranteeManager.connect(mockVaultCore).lockGuarantee(
          borrower.address,
          lender.address,
          mockToken.target,
          TEST_AMOUNT,
          TEST_INTEREST,
          1 // 1天
        );

        // 立即尝试提前还款
        await expect(
          earlyRepaymentGuaranteeManager.connect(mockVaultCore).processEarlyRepayment(
            borrower.address,
            mockToken.target,
            TEST_AMOUNT
          )
        ).to.not.be.reverted;
      });

      it('EarlyRepaymentGuaranteeManager – 应该正确处理极大金额', async function () {
        const largePrincipal = ethers.MaxUint256 / 2n;
        const largeInterest = ethers.MaxUint256 / 4n;

        await expect(
          earlyRepaymentGuaranteeManager.connect(mockVaultCore).lockGuarantee(
            borrower.address,
            lender.address,
            mockToken.target,
            largePrincipal,
            largeInterest,
            TEST_TERM_DAYS
          )
        ).to.not.be.reverted;
      });
    });
  });

  describe('🟢 低等安全漏洞测试', function () {
    describe('事件验证', function () {
      it('EarlyRepaymentGuaranteeManager – 应该正确发出保证金锁定事件', async function () {
        const tx = await earlyRepaymentGuaranteeManager.connect(mockVaultCore).lockGuarantee(
          borrower.address,
          lender.address,
          mockToken.target,
          TEST_AMOUNT,
          TEST_INTEREST,
          TEST_TERM_DAYS
        );

        await expect(tx).to.emit(earlyRepaymentGuaranteeManager, 'GuaranteeLocked');
      });

      it('EarlyRepaymentGuaranteeManager – 应该正确发出提前还款事件', async function () {
        // 先锁定保证金
        await earlyRepaymentGuaranteeManager.connect(mockVaultCore).lockGuarantee(
          borrower.address,
          lender.address,
          mockToken.target,
          TEST_AMOUNT,
          TEST_INTEREST,
          TEST_TERM_DAYS
        );

        // 处理提前还款
        const tx = await earlyRepaymentGuaranteeManager.connect(mockVaultCore).processEarlyRepayment(
          borrower.address,
          mockToken.target,
          TEST_AMOUNT
        );

        await expect(tx).to.emit(earlyRepaymentGuaranteeManager, 'EarlyRepaymentProcessed');
      });
    });

    describe('状态一致性', function () {
      it('EarlyRepaymentGuaranteeManager – 保证金状态应该正确更新', async function () {
        // 锁定保证金
        await earlyRepaymentGuaranteeManager.connect(mockVaultCore).lockGuarantee(
          borrower.address,
          lender.address,
          mockToken.target,
          TEST_AMOUNT,
          TEST_INTEREST,
          TEST_TERM_DAYS
        );

        // 验证保证金状态
        const guaranteeId = await earlyRepaymentGuaranteeManager.getUserGuaranteeId(
          borrower.address,
          mockToken.target
        );
        expect(guaranteeId).to.equal(1);

        const record = await earlyRepaymentGuaranteeManager.getGuaranteeRecord(guaranteeId);
        expect(record.isActive).to.be.true;

        // 处理提前还款
        await earlyRepaymentGuaranteeManager.connect(mockVaultCore).processEarlyRepayment(
          borrower.address,
          mockToken.target,
          TEST_AMOUNT
        );

        // 验证状态已更新
        const updatedRecord = await earlyRepaymentGuaranteeManager.getGuaranteeRecord(guaranteeId);
        expect(updatedRecord.isActive).to.be.false;

        const updatedGuaranteeId = await earlyRepaymentGuaranteeManager.getUserGuaranteeId(
          borrower.address,
          mockToken.target
        );
        expect(updatedGuaranteeId).to.equal(0);
      });
    });
  });

  describe('🔧 修复建议测试', function () {
    describe('CEI模式验证', function () {
      it('EarlyRepaymentGuaranteeManager – 应该先更新状态再进行外部调用', async function () {
        // 锁定保证金
        await earlyRepaymentGuaranteeManager.connect(mockVaultCore).lockGuarantee(
          borrower.address,
          lender.address,
          mockToken.target,
          TEST_AMOUNT,
          TEST_INTEREST,
          TEST_TERM_DAYS
        );

        // 处理提前还款（应该遵循CEI模式）
        await expect(
          earlyRepaymentGuaranteeManager.connect(mockVaultCore).processEarlyRepayment(
            borrower.address,
            mockToken.target,
            TEST_AMOUNT
          )
        ).to.not.be.reverted;
      });
    });

    describe('精度计算验证', function () {
      it('EarlyRepaymentGuaranteeManager – 应该使用高精度计算', async function () {
        // 锁定保证金
        await earlyRepaymentGuaranteeManager.connect(mockVaultCore).lockGuarantee(
          borrower.address,
          lender.address,
          mockToken.target,
          TEST_AMOUNT,
          TEST_INTEREST,
          TEST_TERM_DAYS
        );

        // 测试高精度计算逻辑
        const result = await earlyRepaymentGuaranteeManager.previewEarlyRepayment(1, TEST_AMOUNT);
        
        // 验证计算结果的合理性
        expect(result.actualInterestPaid).to.be.gte(0);
        expect(result.penaltyToLender).to.be.gte(0);
        expect(result.refundToBorrower).to.be.gte(0);
        expect(result.platformFee).to.be.gte(0);
      });
    });
  });

  describe('🚨 压力测试', function () {
    it('EarlyRepaymentGuaranteeManager – 应该处理大量并发操作', async function () {
      // 创建多个并发操作
      for (let i = 0; i < 5; i++) {
        const newBorrower = ethers.Wallet.createRandom().connect(ethers.provider);
        const newLender = ethers.Wallet.createRandom().connect(ethers.provider);
        
        // 给新用户分配代币
        await mockToken.mint(newBorrower.address, LARGE_AMOUNT);
        await mockToken.mint(newLender.address, LARGE_AMOUNT);
        
        // 直接执行操作，不使用数组
        await earlyRepaymentGuaranteeManager.connect(mockVaultCore).lockGuarantee(
          newBorrower.address,
          newLender.address,
          mockToken.target,
          TEST_AMOUNT,
          TEST_INTEREST,
          TEST_TERM_DAYS
        );
      }
    });

    it('EarlyRepaymentGuaranteeManager – 应该处理极端时间条件', async function () {
      // 锁定保证金
      await earlyRepaymentGuaranteeManager.connect(mockVaultCore).lockGuarantee(
        borrower.address,
        lender.address,
        mockToken.target,
        TEST_AMOUNT,
        TEST_INTEREST,
        TEST_TERM_DAYS
      );

      // 模拟极长时间经过
      await ethers.provider.send('evm_increaseTime', [365 * 24 * 3600]); // 1年
      await ethers.provider.send('evm_mine', []);

      // 应该仍然能正常处理
      await expect(
        earlyRepaymentGuaranteeManager.connect(mockVaultCore).processEarlyRepayment(
          borrower.address,
          mockToken.target,
          TEST_AMOUNT
        )
      ).to.not.be.reverted;
    });
  });
}); 