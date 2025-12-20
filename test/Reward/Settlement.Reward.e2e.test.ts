import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';

import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

// 合约类型（仅断言用，不强依赖全部方法）
import type { MockRegistry } from '../../types/contracts/Mocks/MockRegistry';
import type { LendingEngine } from '../../types/contracts/core/LendingEngine';
import type { LoanNFT } from '../../types/contracts/core/LoanNFT';
import type { FeeRouter } from '../../types/contracts/core/FeeRouter';
import type { RewardPoints } from '../../types/contracts/Token/RewardPoints';
import type { RewardManager } from '../../types/contracts/Reward';
import type { RewardManagerCore } from '../../types/contracts/Reward';
import type { AccessControlManager } from '../../types/contracts/access/AccessControlManager';
import type { MockERC20 } from '../../types/contracts/Mocks/MockERC20';

describe('Settlement + Reward end-to-end (借款→落账→锁定→按期释放)', function () {
  let governance!: SignerWithAddress;
  let borrower!: SignerWithAddress;
  let lender!: SignerWithAddress;

  let registry!: MockRegistry;
  let lendingEngine!: LendingEngine;
  let loanNft!: LoanNFT;
  let feeRouter!: FeeRouter;
  let rewardPoints!: RewardPoints;
  let rewardManager!: RewardManager;
  let rewardManagerCore!: RewardManagerCore;
  let acm!: AccessControlManager;
  let usdt!: MockERC20;

  // ModuleKeys（按合约常量字符串生成）
  const KEY = {
    LE: () => ethers.keccak256(ethers.toUtf8Bytes('LENDING_ENGINE')),
    RM: () => ethers.keccak256(ethers.toUtf8Bytes('REWARD_MANAGER')),
    RM_CORE: () => ethers.keccak256(ethers.toUtf8Bytes('REWARD_MANAGER_CORE')),
    RP: () => ethers.keccak256(ethers.toUtf8Bytes('REWARD_POINTS')),
    LOAN_NFT: () => ethers.keccak256(ethers.toUtf8Bytes('LOAN_NFT')),
    FR: () => ethers.keccak256(ethers.toUtf8Bytes('FEE_ROUTER')),
    ACCESS: () => ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER')),
    VBL: () => ethers.keccak256(ethers.toUtf8Bytes('VAULT_BUSINESS_LOGIC')),
  } as const;

  async function deployFixture() {
    [governance, borrower, lender] = await ethers.getSigners();

    // 1) 部署 Registry
    registry = (await (await ethers.getContractFactory('MockRegistry')).deploy()) as unknown as MockRegistry;
    await registry.waitForDeployment();

    // 2) 部署 AccessControlManager 并注册
    acm = (await (await ethers.getContractFactory('AccessControlManager')).deploy(
      await governance.getAddress()
    )) as unknown as AccessControlManager;
    await acm.waitForDeployment();
    await registry.setModule(KEY.ACCESS(), await acm.getAddress());

    // 3) 部署 USDT（MockERC20）作为借款资产
    usdt = (await (await ethers.getContractFactory('MockERC20')).deploy(
      'Mock USDT',
      'USDT',
      ethers.parseUnits('1000000000', 6)
    )) as unknown as MockERC20;
    await usdt.waitForDeployment();

    // 4) 部署 LoanNFT（Proxy）并初始化
    loanNft = (await upgrades.deployProxy(
      await ethers.getContractFactory('src/core/LoanNFT.sol:LoanNFT'),
      ['Loan NFT', 'LOAN', 'https://api.example.com/token/', await registry.getAddress()],
      { unsafeAllow: ['constructor'] }
    )) as unknown as LoanNFT;
    await loanNft.waitForDeployment();
    await registry.setModule(KEY.LOAN_NFT(), await loanNft.getAddress());

    // 5) 部署 FeeRouter 并初始化
    feeRouter = (await upgrades.deployProxy(
      await ethers.getContractFactory('src/core/FeeRouter.sol:FeeRouter'),
      [
        await registry.getAddress(),
        await governance.getAddress(),
        await governance.getAddress(),
        50, // platformBps 0.5%
        20  // ecoBps 0.2%
      ],
      { unsafeAllow: ['constructor'] }
    )) as unknown as FeeRouter;
    await feeRouter.waitForDeployment();
    await registry.setModule(KEY.FR(), await feeRouter.getAddress());

    // 6) 部署 RewardPoints / RewardManagerCore / RewardManager（全部使用 Proxy）
    const rpFactory = await ethers.getContractFactory('src/Token/RewardPoints.sol:RewardPoints');
    rewardPoints = (await upgrades.deployProxy(
      rpFactory,
      [await governance.getAddress()],
      { unsafeAllow: ['constructor'] }
    )) as unknown as RewardPoints;
    await rewardPoints.waitForDeployment();
    await registry.setModule(KEY.RP(), await rewardPoints.getAddress());

    rewardManagerCore = (await upgrades.deployProxy(
      await ethers.getContractFactory('RewardManagerCore'),
      [
        await registry.getAddress(),
        ethers.parseUnits('100', 18),
        10,
        0, // 关闭 earlyRepayBonus，采用扣罚规则
        ethers.parseUnits('50', 18)
      ],
      { unsafeAllow: ['constructor'] }
    )) as unknown as RewardManagerCore;
    await rewardManagerCore.waitForDeployment();
    await registry.setModule(KEY.RM_CORE(), await rewardManagerCore.getAddress());

    rewardManager = (await upgrades.deployProxy(
      await ethers.getContractFactory('RewardManager'),
      [await registry.getAddress()],
      { unsafeAllow: ['constructor'] }
    )) as unknown as RewardManager;
    await rewardManager.waitForDeployment();
    await registry.setModule(KEY.RM(), await rewardManager.getAddress());
    await registry.setModule(KEY.RM(), await rewardManager.getAddress());

    // 授权：RewardPoints MINTER_ROLE → RewardManagerCore
    const MINTER_ROLE = await rewardPoints.MINTER_ROLE();
    await rewardPoints.connect(governance).grantRole(MINTER_ROLE, await rewardManagerCore.getAddress());

    // 7) 部署 LendingEngine 并初始化
    lendingEngine = (await upgrades.deployProxy(
      await ethers.getContractFactory('src/core/LendingEngine.sol:LendingEngine'),
      [await registry.getAddress()],
      { unsafeAllow: ['constructor'] }
    )) as unknown as LendingEngine;
    await lendingEngine.waitForDeployment();
    await registry.setModule(KEY.LE(), await lendingEngine.getAddress());

    // 8) （可选）部署 VBL（本用例不强依赖 finalizeMatch，直接调用 LendingEngine 流程验证 Reward ）
    // 如后续需要，可扩展至 VaultBusinessLogic + EIP-712 流程

    // 9) 权限配置（ACTION_ORDER_CREATE/ACTION_REPAY/ACTION_BORROW 给 LendingEngine 用于 LoanNFT 铸造）
    const ACTION_ORDER_CREATE = ethers.keccak256(ethers.toUtf8Bytes('ORDER_CREATE'));
    const ACTION_REPAY = ethers.keccak256(ethers.toUtf8Bytes('REPAY'));
    const ACTION_BORROW = ethers.keccak256(ethers.toUtf8Bytes('BORROW'));
    await acm.grantRole(ACTION_ORDER_CREATE, await governance.getAddress());
    await acm.grantRole(ACTION_REPAY, await governance.getAddress());
    await acm.grantRole(ACTION_BORROW, await lendingEngine.getAddress());

    return {
      registry,
      lendingEngine,
      feeRouter,
      loanNft,
      rewardPoints,
      rewardManager,
      rewardManagerCore,
      acm,
      borrower,
      lender,
      governance,
      usdt,
    };
  }

  it('应完成借款→落账（锁定积分）→按期还款释放 的完整路径', async function () {
    const {
      lendingEngine,
      rewardPoints,
      borrower,
      governance,
      usdt,
    } = await loadFixture(deployFixture);

    // 1) 创建贷款订单（30天，利率=0，本金=5000 USDT）
    const principal = ethers.parseUnits('5000', 6);
    const termSec = 30 * 24 * 3600;
    const order = {
      principal,
      rate: 0, // 简化利息为0，便于还款一次性结清
      term: termSec,
      borrower: await borrower.getAddress(),
      lender: await governance.getAddress(), // 简化：governance 充当 lender
      asset: await usdt.getAddress(),
      startTimestamp: 0,
      maturity: 0,
      repaidAmount: 0,
    };

    // 借款：governance 具有 ACTION_BORROW 权限
    await expect(lendingEngine.connect(governance).createLoanOrder(order)).to.not.be.reverted;

    // 2) 借款后：Reward 为“锁定积分”，余额应为0
    const userBalanceAfterBorrow = await rewardPoints.balanceOf(await borrower.getAddress());
    expect(userBalanceAfterBorrow).to.equal(0n);

    // 3) 还款（按期且足额）：准备 USDT 给 borrower 以便 repay（引擎从 payer 转账）
    // 将足额 USDT 转给 borrower 并 approve 给 LendingEngine
    await usdt.transfer(await borrower.getAddress(), principal);
    await usdt.connect(borrower).approve(await lendingEngine.getAddress(), principal);

    // repay：governance 拥有 ACTION_REPAY 权限，但还款 payer 为 borrower
    // LendingEngine.repay 只检查 caller 的 ACTION_REPAY，因此让 governance 作为 caller 并从 borrower 转账不吻合
    // 这里按现有实现：repay 从 msg.sender 转账 → 让 borrower 拥有 ACTION_REPAY
    const ACTION_REPAY = ethers.keccak256(ethers.toUtf8Bytes('REPAY'));
    const acmAddr = await registry.getModule(ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER')));
    const acm = await ethers.getContractAt('AccessControlManager', acmAddr);
    await acm.grantRole(ACTION_REPAY, await borrower.getAddress());

    // 推进时间至到期窗口内，确保 isOnTimeAndFullyRepaid 判定为真（见 Architecture-Guide 与 Execution-Plan）
    await time.increase(termSec);
    // 还款（amount=principal，duration=0，LE 内部会计算 isOnTimeAndFullyRepaid 并触发 RewardManager.onLoanEvent）
    await expect(lendingEngine.connect(borrower).repay(0, principal)).to.not.be.reverted; // 订单ID=0（首单）

    // 4) 释放：余额应>0（积分释放）
    const userBalanceAfterRepay = await rewardPoints.balanceOf(await borrower.getAddress());
    expect(userBalanceAfterRepay).to.be.gt(0n);
  });
});


