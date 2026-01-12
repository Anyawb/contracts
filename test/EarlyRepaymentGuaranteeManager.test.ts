/**
 * EarlyRepaymentGuaranteeManager – guarantee lifecycle & permissions
 *
 * Notes:
 * - ethers v6 uses `method.staticCall(...)` instead of `contract.callStatic.method(...)`
 */
import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

import type { EarlyRepaymentGuaranteeManager } from '../types/src/Vault/modules/EarlyRepaymentGuaranteeManager';
import type { AccessControlManager } from '../types/src/access/AccessControlManager';
import type { MockGuaranteeFundForEarlyRepayment } from '../types/src/Mocks/MockGuaranteeFundForEarlyRepayment';
import type { Registry } from '../types/src/registry/Registry';

const MODULE_KEYS = {
  ACCESS_CONTROL: ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER')),
  GUARANTEE_FUND: ethers.keccak256(ethers.toUtf8Bytes('GUARANTEE_FUND_MANAGER')),
} as const;

const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));

const PRINCIPAL = ethers.parseEther('1000');
const PROMISED_INTEREST = ethers.parseEther('100');
const TERM_DAYS = 30;
const PLATFORM_FEE_RATE = 100; // 1% (bps)

interface DeploymentFixture {
  registry: Registry;
  accessControl: AccessControlManager;
  guaranteeFund: MockGuaranteeFundForEarlyRepayment;
  ergm: EarlyRepaymentGuaranteeManager;
  vaultCore: SignerWithAddress;
  borrower: SignerWithAddress;
  lender: SignerWithAddress;
  platformFeeReceiver: SignerWithAddress;
  admin: SignerWithAddress;
  testAsset: string;
}

async function deployRegistryProxy(
  minDelay: number,
  upgradeAdmin: string,
  emergencyAdmin: string,
  initialOwner: string
): Promise<Registry> {
  const RegistryFactory = await ethers.getContractFactory('Registry');
  const registryImpl = await RegistryFactory.deploy();
  await registryImpl.waitForDeployment();

  const ProxyFactory = await ethers.getContractFactory('ERC1967Proxy');
  const initData = registryImpl.interface.encodeFunctionData('initialize', [
    minDelay,
    upgradeAdmin,
    emergencyAdmin,
    initialOwner,
  ]);
  const proxy = await ProxyFactory.deploy(registryImpl.target, initData);
  await proxy.waitForDeployment();

  return RegistryFactory.attach(proxy.target) as Registry;
}

async function deploySystemFixture(): Promise<DeploymentFixture> {
  const [deployer, vaultCore, borrower, lender, platformFeeReceiver, admin] =
    await ethers.getSigners();

  const registry = await deployRegistryProxy(0, deployer.address, deployer.address, deployer.address);

  const AccessControlFactory = await ethers.getContractFactory('AccessControlManager');
  const accessControl = (await AccessControlFactory.deploy(deployer.address)) as AccessControlManager;
  await accessControl.waitForDeployment();
  await registry.setModule(MODULE_KEYS.ACCESS_CONTROL, await accessControl.getAddress());

  const GuaranteeFundFactory = await ethers.getContractFactory('MockGuaranteeFundForEarlyRepayment');
  const guaranteeFund = (await GuaranteeFundFactory.deploy()) as MockGuaranteeFundForEarlyRepayment;
  await guaranteeFund.waitForDeployment();
  await registry.setModule(MODULE_KEYS.GUARANTEE_FUND, await guaranteeFund.getAddress());

  const ERGMFactory = await ethers.getContractFactory('EarlyRepaymentGuaranteeManager');
  const ergm = (await upgrades.deployProxy(
    ERGMFactory,
    [vaultCore.address, await registry.getAddress(), platformFeeReceiver.address, PLATFORM_FEE_RATE],
    { kind: 'uups', initializer: 'initialize' }
  )) as EarlyRepaymentGuaranteeManager;
  await ergm.waitForDeployment();

  // grant governance role to admin
  await accessControl.grantRole(ACTION_SET_PARAMETER, admin.address);

  // use random address as "asset"
  const testAsset = ethers.Wallet.createRandom().address;

  return {
    registry,
    accessControl,
    guaranteeFund,
    ergm,
    vaultCore,
    borrower,
    lender,
    platformFeeReceiver,
    admin,
    testAsset,
  };
}

async function lockGuarantee(
  ergm: EarlyRepaymentGuaranteeManager,
  vaultCore: SignerWithAddress,
  borrower: string,
  lender: string,
  asset: string
) {
  await ergm
    .connect(vaultCore)
    .lockGuaranteeRecord(borrower, lender, asset, PRINCIPAL, PROMISED_INTEREST, TERM_DAYS);
}

describe('EarlyRepaymentGuaranteeManager', function () {
  describe('Initialization', function () {
    it('stores initializer parameters', async function () {
      const { ergm, vaultCore, platformFeeReceiver } = await loadFixture(deploySystemFixture);
      expect(await ergm.vaultCore()).to.equal(vaultCore.address);
      expect(await ergm.platformFeeReceiver()).to.equal(platformFeeReceiver.address);
      expect(await ergm.platformFeeRate()).to.equal(PLATFORM_FEE_RATE);
    });

    it('reverts when initialized with zero addresses', async function () {
      const Factory = await ethers.getContractFactory('EarlyRepaymentGuaranteeManager');
      await expect(
        upgrades.deployProxy(
          Factory,
          [ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, PLATFORM_FEE_RATE],
          { kind: 'uups', initializer: 'initialize' }
        )
      ).to.be.revertedWithCustomError(Factory, 'ZeroAddress');
    });
  });

  describe('lockGuaranteeRecord', function () {
    it('locks guarantee and writes record', async function () {
      const { ergm, vaultCore, borrower, lender, testAsset } = await loadFixture(deploySystemFixture);

      const expectedId = await ergm
        .connect(vaultCore)
        .lockGuaranteeRecord.staticCall(
          borrower.address,
          lender.address,
          testAsset,
          PRINCIPAL,
          PROMISED_INTEREST,
          TERM_DAYS
        );

      await expect(
        ergm
          .connect(vaultCore)
          .lockGuaranteeRecord(
            borrower.address,
            lender.address,
            testAsset,
            PRINCIPAL,
            PROMISED_INTEREST,
            TERM_DAYS
          )
      )
        .to.emit(ergm, 'GuaranteeLocked')
        .withArgs(
          expectedId,
          borrower.address,
          lender.address,
          testAsset,
          PRINCIPAL,
          PROMISED_INTEREST,
          anyValue, // startTime
          anyValue, // maturityTime
          2n, // DEFAULT_EARLY_REPAY_PENALTY_DAYS
          anyValue // timestamp
        );

      const record = await ergm.getGuaranteeRecord(expectedId);
      expect(record.principal).to.equal(PRINCIPAL);
      expect(record.promisedInterest).to.equal(PROMISED_INTEREST);
      expect(record.isActive).to.equal(true);
      expect(record.lender).to.equal(lender.address);
      expect(record.asset).to.equal(testAsset);

      expect(await ergm.getUserGuaranteeId(borrower.address, testAsset)).to.equal(expectedId);
      expect(await ergm.hasActiveGuarantee(borrower.address, testAsset)).to.equal(true);
    });

    it('reverts on duplicate active guarantee', async function () {
      const { ergm, vaultCore, borrower, lender, testAsset } = await loadFixture(deploySystemFixture);
      await lockGuarantee(ergm, vaultCore, borrower.address, lender.address, testAsset);

      await expect(
        ergm
          .connect(vaultCore)
          .lockGuaranteeRecord(
            borrower.address,
            lender.address,
            testAsset,
            PRINCIPAL,
            PROMISED_INTEREST,
            TERM_DAYS
          )
      ).to.be.revertedWithCustomError(ergm, 'GuaranteeAlreadyProcessed');
    });
  });

  describe('settleEarlyRepayment', function () {
    it('settles early repayment and deactivates record', async function () {
      const { ergm, vaultCore, borrower, lender, testAsset } = await loadFixture(deploySystemFixture);
      await lockGuarantee(ergm, vaultCore, borrower.address, lender.address, testAsset);

      await time.increase(10 * 24 * 60 * 60);

      await expect(
        ergm
          .connect(vaultCore)
          .settleEarlyRepayment(borrower.address, testAsset, PRINCIPAL + PROMISED_INTEREST)
      )
        .to.emit(ergm, 'EarlyRepaymentProcessed')
        .withArgs(
          1n,
          borrower.address,
          lender.address,
          testAsset,
          anyValue, // penaltyToLender
          anyValue, // refundToBorrower
          anyValue, // platformFee
          anyValue, // actualInterestPaid
          anyValue // timestamp
        );

      expect(await ergm.hasActiveGuarantee(borrower.address, testAsset)).to.equal(false);
      expect(await ergm.getUserGuaranteeId(borrower.address, testAsset)).to.equal(0n);
    });

    it('reverts when guarantee not found', async function () {
      const { ergm, vaultCore, lender, testAsset } = await loadFixture(deploySystemFixture);
      await expect(
        ergm.connect(vaultCore).settleEarlyRepayment(lender.address, testAsset, PRINCIPAL)
      ).to.be.revertedWithCustomError(ergm, 'GuaranteeRecordNotFound');
    });
  });

  describe('processDefault', function () {
    it('forfeits promised interest to lender', async function () {
      const { ergm, vaultCore, borrower, lender, testAsset } = await loadFixture(deploySystemFixture);
      await lockGuarantee(ergm, vaultCore, borrower.address, lender.address, testAsset);

      await expect(ergm.connect(vaultCore).processDefault(borrower.address, testAsset))
        .to.emit(ergm, 'GuaranteeForfeited')
        .withArgs(1n, borrower.address, lender.address, testAsset, PROMISED_INTEREST, anyValue);

      expect(await ergm.hasActiveGuarantee(borrower.address, testAsset)).to.equal(false);
    });

    it('reverts when record missing', async function () {
      const { ergm, vaultCore, borrower, testAsset } = await loadFixture(deploySystemFixture);
      await expect(
        ergm.connect(vaultCore).processDefault(borrower.address, testAsset)
      ).to.be.revertedWithCustomError(ergm, 'GuaranteeRecordNotFound');
    });
  });

  describe('previewEarlyRepayment', function () {
    it('returns preview', async function () {
      const { ergm, vaultCore, borrower, lender, testAsset } = await loadFixture(deploySystemFixture);
      await lockGuarantee(ergm, vaultCore, borrower.address, lender.address, testAsset);

      const preview = await ergm.previewEarlyRepayment(1n, PRINCIPAL + PROMISED_INTEREST);
      expect(preview.penaltyToLender).to.be.greaterThan(0n);
      expect(preview.platformFee).to.be.greaterThanOrEqual(0n);
    });

    it('reverts when record inactive', async function () {
      const { ergm, vaultCore, borrower, lender, testAsset } = await loadFixture(deploySystemFixture);
      await lockGuarantee(ergm, vaultCore, borrower.address, lender.address, testAsset);
      await ergm.connect(vaultCore).processDefault(borrower.address, testAsset);

      await expect(ergm.previewEarlyRepayment(1n, PRINCIPAL)).to.be.revertedWithCustomError(
        ergm,
        'GuaranteeNotActive'
      );
    });
  });

  describe('Admin controls', function () {
    it('allows admin to update platform fee receiver', async function () {
      const { ergm, admin, lender } = await loadFixture(deploySystemFixture);
      await ergm.connect(admin).setPlatformFeeReceiver(lender.address);
      expect(await ergm.platformFeeReceiver()).to.equal(lender.address);
    });

    it('rejects unauthorized platform updates', async function () {
      const { ergm, borrower, accessControl } = await loadFixture(deploySystemFixture);
      await expect(
        ergm.connect(borrower).setPlatformFeeReceiver(borrower.address)
      ).to.be.revertedWithCustomError(accessControl, 'MissingRole');
    });

    it('allows admin to update fee rate', async function () {
      const { ergm, admin } = await loadFixture(deploySystemFixture);
      await ergm.connect(admin).setPlatformFeeRate(200);
      expect(await ergm.platformFeeRate()).to.equal(200);
    });

    it('reverts when rate too high', async function () {
      const { ergm, admin } = await loadFixture(deploySystemFixture);
      await expect(ergm.connect(admin).setPlatformFeeRate(1100)).to.be.revertedWithCustomError(
        ergm,
        'EarlyRepaymentGuaranteeManager__RateTooHigh'
      );
    });
  });
});

