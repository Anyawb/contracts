import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';

import { ModuleKeys } from '../frontend-config/moduleKeys';

describe('Interest Accounting – full repay posts interest', function () {
  // NOTE: there are two contracts named `LendingEngine` in this repo.
  const OrderEngineFQN = 'src/core/LendingEngine.sol:LendingEngine';

  // ActionKeys (must match src/constants/ActionKeys.sol)
  const ACTION_ORDER_CREATE = ethers.keccak256(ethers.toUtf8Bytes('ORDER_CREATE'));
  const ACTION_REPAY = ethers.keccak256(ethers.toUtf8Bytes('REPAY'));
  const ACTION_VIEW_SYSTEM_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_SYSTEM_DATA'));
  const ACTION_UPGRADE_MODULE = ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE'));
  const ACTION_PAUSE_SYSTEM = ethers.keccak256(ethers.toUtf8Bytes('PAUSE_SYSTEM'));
  const ACTION_UNPAUSE_SYSTEM = ethers.keccak256(ethers.toUtf8Bytes('UNPAUSE_SYSTEM'));
  const ACTION_BORROW = ethers.keccak256(ethers.toUtf8Bytes('BORROW')); // LoanNFT minter role

  const YEAR = 365n * 24n * 60n * 60n;
  const REPAY_FEE_BPS = 6n; // src/core/LendingEngine.sol constant

  function calcInterest(principal: bigint, rateBps: bigint, termSec: bigint): bigint {
    return (principal * rateBps * termSec) / (YEAR * 10000n);
  }

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

    const feeRouter = await (await ethers.getContractFactory('MockFeeRouter')).deploy();
    await feeRouter.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_FR, await feeRouter.getAddress());

    // repay() will sync principal repayment into VaultCore via repayFor(...)
    // so the module must be registered in the test registry.
    const vaultCore = await (await ethers.getContractFactory('MockVaultCore')).deploy();
    await vaultCore.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_VAULT_CORE, await vaultCore.getAddress());

    const OrderEngineF = await ethers.getContractFactory(OrderEngineFQN);
    const orderEngine = await upgrades.deployProxy(OrderEngineF, [await registry.getAddress()], {
      kind: 'uups',
      initializer: 'initialize',
    });
    await orderEngine.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_LE, await orderEngine.getAddress());

    const LoanNFT = await ethers.getContractFactory('LoanNFT');
    const loanNFT = await upgrades.deployProxy(
      LoanNFT,
      ['Loan NFT', 'LOAN', 'https://example.invalid/token/', await registry.getAddress()],
      { kind: 'uups', initializer: 'initialize' },
    );
    await loanNFT.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_LOAN_NFT, await loanNFT.getAddress());

    // Permissions
    await acm.grantRole(ACTION_ORDER_CREATE, governance.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, governance.address);
    await acm.grantRole(ACTION_UPGRADE_MODULE, governance.address);
    await acm.grantRole(ACTION_PAUSE_SYSTEM, governance.address);
    await acm.grantRole(ACTION_UNPAUSE_SYSTEM, governance.address);
    await acm.grantRole(ACTION_REPAY, borrower.address);
    // LoanNFT mint is executed by order engine contract
    await acm.grantRole(ACTION_BORROW, await orderEngine.getAddress());

    const token = await (await ethers.getContractFactory('MockERC20')).deploy(
      'DebtToken',
      'DEBT',
      18,
      ethers.parseEther('1'),
    );
    await token.waitForDeployment();

    return { governance, borrower, registry, acm, pool, feeRouter, rewardManager, orderEngine, loanNFT, token };
  }

  it('full repay records interest in repaidAmount, transfers fee + lenderAmount', async function () {
    const { governance, borrower, pool, orderEngine, token } = await loadFixture(deployFixture);

    const principal = ethers.parseEther('1000');
    const rateBps = 1000n; // 10%
    const termSec = 5n * 24n * 60n * 60n; // 5 days (whitelisted)

    const interest = calcInterest(principal, rateBps, termSec);
    const totalDue = principal + interest;
    const fee = (totalDue * REPAY_FEE_BPS) / 10000n;
    const lenderAmount = totalDue - fee;

    // Create order (orderId starts at 0 in a fresh fixture)
    await orderEngine.connect(governance).createLoanOrder({
      principal,
      rate: rateBps,
      term: termSec,
      borrower: borrower.address,
      lender: await pool.getAddress(),
      asset: await token.getAddress(),
      startTimestamp: 0n,
      maturity: 0n,
      repaidAmount: 0n,
    });
    const orderId = 0n;

    // Advance time beyond maturity (not strictly required for interest math here, but matches "interest has accrued" expectation).
    await time.increase(Number(termSec + 1n));

    // Fund borrower and approve order engine (spender is the order engine contract).
    await token.mint(borrower.address, totalDue);
    await token.connect(borrower).approve(await orderEngine.getAddress(), totalDue);

    const borrowerBalBefore = await token.balanceOf(borrower.address);
    const poolBalBefore = await token.balanceOf(await pool.getAddress());
    const engineBalBefore = await token.balanceOf(await orderEngine.getAddress());

    await orderEngine.connect(borrower).repay(orderId, totalDue);

    const borrowerBalAfter = await token.balanceOf(borrower.address);
    const poolBalAfter = await token.balanceOf(await pool.getAddress());
    const engineBalAfter = await token.balanceOf(await orderEngine.getAddress());

    // Token flows:
    // - borrower pays totalDue
    // - lender (pool) receives totalDue - fee
    // - fee stays on orderEngine in this fixture (MockFeeRouter.distributeNormal is a no-op)
    expect(borrowerBalBefore - borrowerBalAfter).to.equal(totalDue);
    expect(poolBalAfter - poolBalBefore).to.equal(lenderAmount);
    expect(engineBalAfter - engineBalBefore).to.equal(fee);

    // Bookkeeping: repaidAmount must include interest.
    const ord = await orderEngine.connect(governance).getLoanOrderForView(orderId);
    expect(ord.principal).to.equal(principal);
    expect(ord.rate).to.equal(rateBps);
    expect(ord.term).to.equal(termSec);
    expect(ord.repaidAmount).to.equal(totalDue);
    expect(ord.repaidAmount - ord.principal).to.equal(interest);
  });
});

