import { expect } from 'chai';
import { ethers } from 'hardhat';
import { Contract } from 'ethers';
import { SignerWithAddress } from '@ethersproject/contracts/node_modules/@nomiclabs/hardhat-ethers/signers';

describe('EarlyRepaymentGuaranteeManager', function () {
  let earlyRepaymentGuaranteeManager: Contract;
  let mockToken: Contract;
  let vaultCore: SignerWithAddress;
  let borrower: SignerWithAddress;
  let lender: SignerWithAddress;
  let platformFeeReceiver: SignerWithAddress;
  let acm: SignerWithAddress;

  const PRINCIPAL = ethers.utils.parseEther('1000');
  const PROMISED_INTEREST = ethers.utils.parseEther('100'); // 10% interest
  const TERM_DAYS = 30;
  const PLATFORM_FEE_RATE = 100; // 1%

  beforeEach(async function () {
    [vaultCore, borrower, lender, platformFeeReceiver, acm] = await ethers.getSigners();

    // 部署 Mock ERC20 Token
    const MockToken = await ethers.getContractFactory('MockERC20');
    mockToken = await MockToken.deploy('Mock Token', 'MTK');
    await mockToken.deployed();

    // 部署 EarlyRepaymentGuaranteeManager
    const EarlyRepaymentGuaranteeManager = await ethers.getContractFactory('EarlyRepaymentGuaranteeManager');
    earlyRepaymentGuaranteeManager = await EarlyRepaymentGuaranteeManager.deploy();
    await earlyRepaymentGuaranteeManager.deployed();

    // 初始化合约
    await earlyRepaymentGuaranteeManager.initialize(
      vaultCore.address,
      acm.address,
      platformFeeReceiver.address,
      PLATFORM_FEE_RATE
    );

    // 给借款方和贷款方一些代币
    await mockToken.mint(borrower.address, ethers.utils.parseEther('10000'));
    await mockToken.mint(lender.address, ethers.utils.parseEther('10000'));
  });

  describe('Initialization', function () {
    it('should initialize with correct parameters', async function () {
      expect(await earlyRepaymentGuaranteeManager.vaultCore()).to.equal(vaultCore.address);
      expect(await earlyRepaymentGuaranteeManager.acm()).to.equal(acm.address);
      expect(await earlyRepaymentGuaranteeManager.platformFeeReceiver()).to.equal(platformFeeReceiver.address);
      expect(await earlyRepaymentGuaranteeManager.platformFeeRate()).to.equal(PLATFORM_FEE_RATE);
    });

    it('should revert if initialized with zero addresses', async function () {
      const EarlyRepaymentGuaranteeManager = await ethers.getContractFactory('EarlyRepaymentGuaranteeManager');
      const newManager = await EarlyRepaymentGuaranteeManager.deploy();
      
      await expect(
        newManager.initialize(
          ethers.constants.AddressZero,
          acm.address,
          platformFeeReceiver.address,
          PLATFORM_FEE_RATE
        )
      ).to.be.revertedWith('ZeroAddress');
    });
  });

  describe('Lock Guarantee', function () {
    it('should lock guarantee successfully', async function () {
      const guaranteeId = await earlyRepaymentGuaranteeManager.connect(vaultCore).lockGuarantee(
        borrower.address,
        lender.address,
        mockToken.address,
        PRINCIPAL,
        PROMISED_INTEREST,
        TERM_DAYS
      );

      expect(guaranteeId).to.equal(1);

      const record = await earlyRepaymentGuaranteeManager.getGuaranteeRecord(1);
      expect(record.principal).to.equal(PRINCIPAL);
      expect(record.promisedInterest).to.equal(PROMISED_INTEREST);
      expect(record.lender).to.equal(lender.address);
      expect(record.asset).to.equal(mockToken.address);
      expect(record.isActive).to.be.true;

      const userGuaranteeId = await earlyRepaymentGuaranteeManager.getUserGuaranteeId(borrower.address, mockToken.address);
      expect(userGuaranteeId).to.equal(1);
    });

    it('should revert if called by non-vault-core', async function () {
      await expect(
        earlyRepaymentGuaranteeManager.connect(borrower).lockGuarantee(
          borrower.address,
          lender.address,
          mockToken.address,
          PRINCIPAL,
          PROMISED_INTEREST,
          TERM_DAYS
        )
      ).to.be.revertedWith('Only vault core allowed');
    });

    it('should revert if user already has active guarantee', async function () {
      await earlyRepaymentGuaranteeManager.connect(vaultCore).lockGuarantee(
        borrower.address,
        lender.address,
        mockToken.address,
        PRINCIPAL,
        PROMISED_INTEREST,
        TERM_DAYS
      );

      await expect(
        earlyRepaymentGuaranteeManager.connect(vaultCore).lockGuarantee(
          borrower.address,
          lender.address,
          mockToken.address,
          PRINCIPAL,
          PROMISED_INTEREST,
          TERM_DAYS
        )
      ).to.be.revertedWith('Active guarantee already exists');
    });
  });

  describe('Early Repayment', function () {
    beforeEach(async function () {
      await earlyRepaymentGuaranteeManager.connect(vaultCore).lockGuarantee(
        borrower.address,
        lender.address,
        mockToken.address,
        PRINCIPAL,
        PROMISED_INTEREST,
        TERM_DAYS
      );
    });

    it('should process early repayment correctly', async function () {
      // 模拟10天后提前还款
      await ethers.provider.send('evm_increaseTime', [10 * 24 * 3600]); // 10 days
      await ethers.provider.send('evm_mine', []);

      const actualRepayAmount = ethers.utils.parseEther('1100'); // 本金 + 部分利息

      const result = await earlyRepaymentGuaranteeManager.connect(vaultCore).processEarlyRepayment(
        borrower.address,
        mockToken.address,
        actualRepayAmount
      );

      // 验证结果
      expect(result.actualInterestPaid).to.be.gt(0);
      expect(result.penaltyToLender).to.be.gt(0);
      expect(result.platformFee).to.be.gt(0);
      expect(result.refundToBorrower).to.be.gte(0);

      // 验证保证金状态
      const hasActiveGuarantee = await earlyRepaymentGuaranteeManager.hasActiveGuarantee(borrower.address, mockToken.address);
      expect(hasActiveGuarantee).to.be.false;
    });

    it('should revert if no guarantee found', async function () {
      await expect(
        earlyRepaymentGuaranteeManager.connect(vaultCore).processEarlyRepayment(
          lender.address, // 使用没有保证金的地址
          mockToken.address,
          PRINCIPAL
        )
      ).to.be.revertedWith('No guarantee found');
    });
  });

  describe('Default Processing', function () {
    beforeEach(async function () {
      await earlyRepaymentGuaranteeManager.connect(vaultCore).lockGuarantee(
        borrower.address,
        lender.address,
        mockToken.address,
        PRINCIPAL,
        PROMISED_INTEREST,
        TERM_DAYS
      );
    });

    it('should forfeit guarantee on default', async function () {
      const forfeitedAmount = await earlyRepaymentGuaranteeManager.connect(vaultCore).processDefault(
        borrower.address,
        mockToken.address
      );

      expect(forfeitedAmount).to.equal(PROMISED_INTEREST);

      // 验证保证金状态
      const hasActiveGuarantee = await earlyRepaymentGuaranteeManager.hasActiveGuarantee(borrower.address, mockToken.address);
      expect(hasActiveGuarantee).to.be.false;
    });

    it('should revert if no guarantee found for default', async function () {
      await expect(
        earlyRepaymentGuaranteeManager.connect(vaultCore).processDefault(
          lender.address, // 使用没有保证金的地址
          mockToken.address
        )
      ).to.be.revertedWith('No guarantee found');
    });
  });

  describe('Preview Functions', function () {
    beforeEach(async function () {
      await earlyRepaymentGuaranteeManager.connect(vaultCore).lockGuarantee(
        borrower.address,
        lender.address,
        mockToken.address,
        PRINCIPAL,
        PROMISED_INTEREST,
        TERM_DAYS
      );
    });

    it('should preview early repayment correctly', async function () {
      const actualRepayAmount = ethers.utils.parseEther('1100');

      const result = await earlyRepaymentGuaranteeManager.previewEarlyRepayment(
        1, // guaranteeId
        actualRepayAmount
      );

      expect(result.actualInterestPaid).to.be.gt(0);
      expect(result.penaltyToLender).to.be.gt(0);
      expect(result.platformFee).to.be.gt(0);
      expect(result.refundToBorrower).to.be.gte(0);
    });

    it('should revert preview for inactive guarantee', async function () {
      // 先处理提前还款使保证金变为非活跃
      await earlyRepaymentGuaranteeManager.connect(vaultCore).processEarlyRepayment(
        borrower.address,
        mockToken.address,
        PRINCIPAL
      );

      await expect(
        earlyRepaymentGuaranteeManager.previewEarlyRepayment(
          1,
          PRINCIPAL
        )
      ).to.be.revertedWith('Guarantee not active');
    });
  });

  describe('Admin Functions', function () {
    it('should update platform fee receiver', async function () {
      const newReceiver = lender.address;
      await earlyRepaymentGuaranteeManager.connect(acm).setPlatformFeeReceiver(newReceiver);
      
      expect(await earlyRepaymentGuaranteeManager.platformFeeReceiver()).to.equal(newReceiver);
    });

    it('should update platform fee rate', async function () {
      const newRate = 200; // 2%
      await earlyRepaymentGuaranteeManager.connect(acm).setPlatformFeeRate(newRate);
      
      expect(await earlyRepaymentGuaranteeManager.platformFeeRate()).to.equal(newRate);
    });

    it('should revert if rate too high', async function () {
      await expect(
        earlyRepaymentGuaranteeManager.connect(acm).setPlatformFeeRate(1100) // 11%
      ).to.be.revertedWith('Rate too high');
    });
  });
}); 