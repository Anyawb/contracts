import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

import { ModuleKeys } from '../frontend-config/moduleKeys';

describe('Protocol E2E - long-term borrow gate reads RewardManagerCore', function () {
  const LendingEngineFQN = 'src/core/LendingEngine.sol:LendingEngine';
  const ACTION_ORDER_CREATE = ethers.keccak256(ethers.toUtf8Bytes('ORDER_CREATE'));
  const ACTION_BORROW = ethers.keccak256(ethers.toUtf8Bytes('BORROW'));

  async function deployFixture() {
    const [governance, borrower] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
    await registry.waitForDeployment();

    const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
    await acm.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, await acm.getAddress());

    const pool = await (await ethers.getContractFactory('SimpleMock')).deploy();
    await pool.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_LENDER_POOL_VAULT, await pool.getAddress());

    const rewardManager = await (await ethers.getContractFactory('MockRewardManager')).deploy();
    await rewardManager.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_RM, await rewardManager.getAddress());

    const rewardManagerCoreBorrowCheck = await (await ethers.getContractFactory('MockRewardManagerCoreBorrowCheck')).deploy();
    await rewardManagerCoreBorrowCheck.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_REWARD_MANAGER_CORE, await rewardManagerCoreBorrowCheck.getAddress());

    const rewardViewMirror = await (await ethers.getContractFactory('MockRewardViewBorrowCheckMirror')).deploy();
    await rewardViewMirror.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_REWARD_VIEW, await rewardViewMirror.getAddress());

    const feeRouter = await (await ethers.getContractFactory('MockFeeRouter')).deploy();
    await feeRouter.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_FR, await feeRouter.getAddress());

    const lendingEngine = await upgrades.deployProxy(await ethers.getContractFactory(LendingEngineFQN), [await registry.getAddress()], {
      kind: 'uups',
      initializer: 'initialize',
    });
    await lendingEngine.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_LE, await lendingEngine.getAddress());

    const loanNFT = await upgrades.deployProxy(
      await ethers.getContractFactory('LoanNFT'),
      ['Loan NFT', 'LOAN', 'https://api.example.com/token/', await registry.getAddress()],
      { kind: 'uups', initializer: 'initialize' },
    );
    await loanNFT.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_LOAN_NFT, await loanNFT.getAddress());

    const borrowAsset = await (await ethers.getContractFactory('MockERC20')).deploy('Borrow Asset', 'BAS', 18, ethers.parseEther('1000000'));
    await borrowAsset.waitForDeployment();

    await acm.grantRole(ACTION_ORDER_CREATE, governance.address);
    await acm.grantRole(ACTION_BORROW, await lendingEngine.getAddress());

    return { lendingEngine, rewardManagerCoreBorrowCheck, rewardViewMirror, governance, borrower, pool, borrowAsset };
  }

  it('rejects 90/180/360 day terms when RMCore level is low even if RewardView mirror is high', async function () {
    const { lendingEngine, rewardManagerCoreBorrowCheck, rewardViewMirror, governance, borrower, pool, borrowAsset } =
      await loadFixture(deployFixture);

    await rewardViewMirror.setUserLevelForBorrowCheck(borrower.address, 9);
    await rewardManagerCoreBorrowCheck.setUserLevelForBorrowCheck(borrower.address, 2);

    for (const term of [648000n, 1296000n, 2592000n]) {
      const order = {
        principal: ethers.parseEther('20'),
        rate: 500n,
        term,
        borrower: borrower.address,
        lender: await pool.getAddress(),
        asset: await borrowAsset.getAddress(),
        startTimestamp: 0n,
        maturity: 0n,
        repaidAmount: 0n,
      };

      await expect(lendingEngine.connect(governance).createLoanOrder(order)).to.be.revertedWithCustomError(
        lendingEngine,
        'LendingEngine__LevelTooLow',
      );
    }
  });

  it('allows long-term term when RMCore level is high even if RewardView mirror is low', async function () {
    const { lendingEngine, rewardManagerCoreBorrowCheck, rewardViewMirror, governance, borrower, pool, borrowAsset } =
      await loadFixture(deployFixture);

    await rewardViewMirror.setUserLevelForBorrowCheck(borrower.address, 1);
    await rewardManagerCoreBorrowCheck.setUserLevelForBorrowCheck(borrower.address, 4);

    const order = {
      principal: ethers.parseEther('20'),
      rate: 500n,
      term: 648000n,
      borrower: borrower.address,
      lender: await pool.getAddress(),
      asset: await borrowAsset.getAddress(),
      startTimestamp: 0n,
      maturity: 0n,
      repaidAmount: 0n,
    };

    await expect(lendingEngine.connect(governance).createLoanOrder(order)).to.not.be.reverted;
  });
});
