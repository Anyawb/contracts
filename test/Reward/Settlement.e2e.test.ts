/**
 * Settlement E2E 测试 - 双架构设计版本
 * 
 * 测试目标:
 * - 验证撮合结算的完整流程，严格符合双架构设计
 * - 验证 EIP-712 签名机制的正确性
 * - 验证双架构数据流：VaultCore → VaultRouter → VaultBusinessLogic → CollateralManager + LendingEngine
 * - 验证事件驱动架构和数据推送
 * - 验证权限控制和错误处理
 */

import { expect } from 'chai';
import * as hardhat from 'hardhat';
const { ethers } = hardhat;
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import type { ContractTransactionResponse } from 'ethers';

// 导入合约类型
import type { 
  MockRegistry,
  AccessControlManager,
  CollateralManager,
  VaultLendingEngine,
  LendingEngine,
  LenderPoolVault,
  LoanNFT,
  MockRewardManager,
  FeeRouter,
  VaultRouter,
  VaultBusinessLogic,
  MockPriceOracle,
  MockERC20,
  MockAssetWhitelist,
  MockGuaranteeFundManager,
  MockEarlyRepaymentGuaranteeManager,
  MockLiquidationRiskManager,
  MockLiquidationManager,
  MockHealthView,
  MockPositionView
} from '../../types';

// 测试常量定义
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// EIP-712 type descriptors
const BorrowIntentTypes = [
  { name: 'borrower', type: 'address' },
  { name: 'collateralAsset', type: 'address' },
  { name: 'collateralAmount', type: 'uint256' },
  { name: 'borrowAsset', type: 'address' },
  { name: 'amount', type: 'uint256' },
  { name: 'termDays', type: 'uint16' },
  { name: 'rateBps', type: 'uint256' },
  { name: 'expireAt', type: 'uint256' },
  { name: 'salt', type: 'bytes32' },
];

const LendIntentTypes = [
  { name: 'lender', type: 'address' },
  { name: 'asset', type: 'address' },
  { name: 'amount', type: 'uint256' },
  { name: 'minTermDays', type: 'uint16' },
  { name: 'maxTermDays', type: 'uint16' },
  { name: 'minRateBps', type: 'uint256' },
  { name: 'expireAt', type: 'uint256' },
  { name: 'salt', type: 'bytes32' },
];

// 模块键
const MODULE_KEYS = {
  KEY_CM: ethers.keccak256(ethers.toUtf8Bytes('COLLATERAL_MANAGER')),
  KEY_LE: ethers.keccak256(ethers.toUtf8Bytes('LENDING_ENGINE')),
  KEY_VAULT_CORE: ethers.keccak256(ethers.toUtf8Bytes('VAULT_CORE')),
  KEY_VAULT_VIEW: ethers.keccak256(ethers.toUtf8Bytes('VAULT_VIEW')),
  KEY_VAULT_ROUTER: ethers.keccak256(ethers.toUtf8Bytes('VAULT_ROUTER')),
  KEY_VAULT_BUSINESS_LOGIC: ethers.keccak256(ethers.toUtf8Bytes('VAULT_BUSINESS_LOGIC')),
  KEY_ORDER_ENGINE: ethers.keccak256(ethers.toUtf8Bytes('ORDER_ENGINE')),
  KEY_LOAN_NFT: ethers.keccak256(ethers.toUtf8Bytes('LOAN_NFT')),
  KEY_FEE_ROUTER: ethers.keccak256(ethers.toUtf8Bytes('FEE_ROUTER')),
  KEY_REWARD_MANAGER: ethers.keccak256(ethers.toUtf8Bytes('REWARD_MANAGER')),
  KEY_PRICE_ORACLE: ethers.keccak256(ethers.toUtf8Bytes('PRICE_ORACLE')),
  KEY_ASSET_WHITELIST: ethers.keccak256(ethers.toUtf8Bytes('ASSET_WHITELIST')),
  KEY_GUARANTEE_FUND: ethers.keccak256(ethers.toUtf8Bytes('GUARANTEE_FUND_MANAGER')),
  KEY_EARLY_REPAYMENT_GUARANTEE: ethers.keccak256(ethers.toUtf8Bytes('EARLY_REPAYMENT_GUARANTEE_MANAGER')),
  KEY_ACCESS_CONTROL: ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER')),
  KEY_LIQUIDATION_MANAGER: ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATION_MANAGER')),
  KEY_LIQUIDATION_RISK_MANAGER: ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATION_RISK_MANAGER')),
  KEY_HEALTH_VIEW: ethers.keccak256(ethers.toUtf8Bytes('HEALTH_VIEW')),
  KEY_POSITION_VIEW: ethers.keccak256(ethers.toUtf8Bytes('POSITION_VIEW')),
  KEY_LENDER_POOL_VAULT: ethers.keccak256(ethers.toUtf8Bytes('LENDER_POOL_VAULT')),
} as const;

const ActionKeys = {
  ACTION_DEPOSIT: ethers.keccak256(ethers.toUtf8Bytes('DEPOSIT')),
} as const;

// 权限角色定义
const ROLES = {
  DEPOSIT: ethers.keccak256(ethers.toUtf8Bytes('DEPOSIT')),
  BORROW: ethers.keccak256(ethers.toUtf8Bytes('BORROW')),
  REPAY: ethers.keccak256(ethers.toUtf8Bytes('REPAY')),
  WITHDRAW: ethers.keccak256(ethers.toUtf8Bytes('WITHDRAW')),
  SET_PARAMETER: ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER')),
  ADMIN: ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN')),
  UPGRADE_MODULE: ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE')),
  PAUSE_SYSTEM: ethers.keccak256(ethers.toUtf8Bytes('PAUSE_SYSTEM')),
  UNPAUSE_SYSTEM: ethers.keccak256(ethers.toUtf8Bytes('UNPAUSE_SYSTEM')),
  ORDER_CREATE: ethers.keccak256(ethers.toUtf8Bytes('ORDER_CREATE')),
} as const;

/**
 * 智能代理合约部署函数
 */
async function deployProxyContract<T extends object>(
  contractName: string,
  initArgs: readonly unknown[] = []
): Promise<T> {
  // 使用 OZ upgrades helpers 来兼容带构造的 UUPS 实现
  const Factory = await ethers.getContractFactory(contractName);
  try {
    const instance = (await upgrades.deployProxy(Factory, initArgs, {
      kind: 'uups',
      unsafeAllow: ['constructor'],
    })) as unknown as T;
    return instance;
  } catch (err) {
    console.error(`deployProxyContract failed for ${contractName} with args len=${initArgs.length}`, err);
    throw err;
  }
}

/**
 * 计算 LendIntent 哈希
 */
function hashLendIntent(lendIntent: {
  lenderSigner: string;
  asset: string;
  amount: bigint;
  minTermDays: number;
  maxTermDays: number;
  minRateBps: bigint;
  expireAt: bigint;
  salt: string;
}): string {
  const typeHash = ethers.keccak256(ethers.toUtf8Bytes(
    'LendIntent(address lenderSigner,address asset,uint256 amount,uint16 minTermDays,uint16 maxTermDays,uint256 minRateBps,uint256 expireAt,bytes32 salt)'
  ));
  
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = coder.encode(
    ['bytes32', 'address', 'address', 'uint256', 'uint16', 'uint16', 'uint256', 'uint256', 'bytes32'],
    [
      typeHash,
      lendIntent.lenderSigner,
      lendIntent.asset,
      lendIntent.amount,
      lendIntent.minTermDays,
      lendIntent.maxTermDays,
      lendIntent.minRateBps,
      lendIntent.expireAt,
      lendIntent.salt
    ]
  );
  return ethers.keccak256(encoded);
}

describe('Settlement E2E Test - 双架构设计版本', function () {
  let governance: SignerWithAddress;
  let borrower: SignerWithAddress;
  let lender: SignerWithAddress;

  // 核心模块
  let registry: MockRegistry;
  let acm: AccessControlManager;
  let cm: CollateralManager;
  let leBasic: VaultLendingEngine;
  let orderEngine: LendingEngine;
  let loanNft: LoanNFT;
  let rewardManager: MockRewardManager;
  let feeRouter: FeeRouter;
  let vaultCore: any; // SettlementBorrowCoreMock
  let vaultRouter: VaultRouter;
  let vaultBusinessLogic: VaultBusinessLogic;
  let lenderPoolVault: LenderPoolVault;
  let priceOracle: MockPriceOracle;
  let usdt: MockERC20;
  let rwa: MockERC20;
  let assetWhitelist: MockAssetWhitelist;
  let guaranteeFundManager: MockGuaranteeFundManager;
  let earlyRepaymentGuaranteeManager: MockEarlyRepaymentGuaranteeManager;
  let liquidationManager: MockLiquidationManager;
  let liquidationRiskManager: MockLiquidationRiskManager;
  let healthView: MockHealthView;
  let positionView: MockPositionView;

  /**
   * 部署测试环境的 fixture 函数
   */
  async function deployFixture() {
    [governance, borrower, lender] = await ethers.getSigners();

    // 1. 部署 Registry
    const RegistryFactory = await ethers.getContractFactory('MockRegistry');
    registry = await RegistryFactory.deploy() as unknown as MockRegistry;
    await registry.waitForDeployment();

    // 2. 部署 AccessControlManager
    const ACMFactory = await ethers.getContractFactory('AccessControlManager');
    acm = await ACMFactory.deploy(await governance.getAddress()) as AccessControlManager;
    await acm.waitForDeployment();
    await acm.grantRole(ROLES.ADMIN, await governance.getAddress());

    // 3. 部署 Mock 代币
    const ERC20Factory = await ethers.getContractFactory('MockERC20');
    usdt = await ERC20Factory.deploy('Mock USDT', 'USDT', ethers.parseUnits('10000000', 6)) as unknown as MockERC20;
    await usdt.waitForDeployment();
    
    rwa = await ERC20Factory.deploy('Mock RWA', 'RWA', ethers.parseEther('10000000')) as unknown as MockERC20;
    await rwa.waitForDeployment();
    
    // 给用户分配代币
    await rwa.transfer(await borrower.getAddress(), ethers.parseEther('100000'));
    await usdt.transfer(await lender.getAddress(), ethers.parseUnits('100000', 6));

    // 4. 部署 PriceOracle
    const PriceOracleFactory = await ethers.getContractFactory('MockPriceOracle');
    priceOracle = await PriceOracleFactory.deploy() as unknown as MockPriceOracle;
    await priceOracle.waitForDeployment();

    // 设置价格
    const now = Math.floor(Date.now() / 1000);
    await priceOracle.setPrice(await rwa.getAddress(), ethers.parseUnits('100', 6), now, 6);
    await priceOracle.setPrice(await usdt.getAddress(), ethers.parseUnits('1', 6), now, 6);

    // 5. 部署资产白名单
    const AssetWhitelistFactory = await ethers.getContractFactory('MockAssetWhitelist');
    assetWhitelist = await AssetWhitelistFactory.deploy() as unknown as MockAssetWhitelist;
    await assetWhitelist.waitForDeployment();
    await assetWhitelist.setAssetAllowed(await rwa.getAddress(), true);
    await assetWhitelist.setAssetAllowed(await usdt.getAddress(), true);

    // 6. 部署保证金管理器
    const GuaranteeFundManagerFactory = await ethers.getContractFactory('MockGuaranteeFundManager');
    guaranteeFundManager = await GuaranteeFundManagerFactory.deploy() as unknown as MockGuaranteeFundManager;
    await guaranteeFundManager.waitForDeployment();

    // 7. 部署提前还款保证金管理器
    const EarlyRepaymentGuaranteeManagerFactory = await ethers.getContractFactory('MockEarlyRepaymentGuaranteeManager');
    earlyRepaymentGuaranteeManager = await EarlyRepaymentGuaranteeManagerFactory.deploy() as unknown as MockEarlyRepaymentGuaranteeManager;
    await earlyRepaymentGuaranteeManager.waitForDeployment();

    const LmFactory = await ethers.getContractFactory('MockLiquidationManager');
    liquidationManager = await LmFactory.deploy() as unknown as MockLiquidationManager;
    await liquidationManager.waitForDeployment();

    // 8. 部署风控/健康视图
    const LrmFactory = await ethers.getContractFactory('MockLiquidationRiskManager');
    liquidationRiskManager = await LrmFactory.deploy() as unknown as MockLiquidationRiskManager;
    await liquidationRiskManager.waitForDeployment();

    const HealthViewFactory = await ethers.getContractFactory('MockHealthView');
    healthView = await HealthViewFactory.deploy() as unknown as MockHealthView;
    await healthView.waitForDeployment();

    const PositionViewFactory = await ethers.getContractFactory('MockPositionView');
    positionView = await PositionViewFactory.deploy() as unknown as MockPositionView;
    await positionView.waitForDeployment();

    // 9. 部署业务模块
    cm = await deployProxyContract<CollateralManager>('CollateralManager', [
      await registry.getAddress()
    ]);

    leBasic = await deployProxyContract<VaultLendingEngine>('VaultLendingEngine', [
      await priceOracle.getAddress(),
      await usdt.getAddress(),
      await registry.getAddress()
    ]);

    orderEngine = await deployProxyContract<LendingEngine>('src/core/LendingEngine.sol:LendingEngine', [await registry.getAddress()]);

    loanNft = await deployProxyContract<LoanNFT>('LoanNFT', [
      'Loan NFT',
      'LOAN',
      'https://token/',
      await registry.getAddress(),
    ]);

    const governanceAddr = await governance.getAddress();
    feeRouter = await deployProxyContract<FeeRouter>('src/Vault/FeeRouter.sol:FeeRouter', [
      await registry.getAddress(),
      governanceAddr,
      governanceAddr,
      100, // platform fee bps (1%)
      1    // eco fee bps (0.01%)
    ]);

    // 10. 部署 Mock RewardManager
    const RewardManagerFactory = await ethers.getContractFactory('MockRewardManager');
    rewardManager = await RewardManagerFactory.deploy() as unknown as MockRewardManager;
    await rewardManager.waitForDeployment();

    // 10.1 部署 LenderPoolVault（线上流动性资金池）
    lenderPoolVault = await deployProxyContract<LenderPoolVault>('LenderPoolVault', [await registry.getAddress()]);

    // 11. Registry 模块注册
    await registry.setModule(MODULE_KEYS.KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(MODULE_KEYS.KEY_CM, await cm.getAddress());
    await registry.setModule(MODULE_KEYS.KEY_LE, await leBasic.getAddress());
    await registry.setModule(MODULE_KEYS.KEY_ORDER_ENGINE, await orderEngine.getAddress());
    await registry.setModule(MODULE_KEYS.KEY_LOAN_NFT, await loanNft.getAddress());
    await registry.setModule(MODULE_KEYS.KEY_FEE_ROUTER, await feeRouter.getAddress());
    await registry.setModule(MODULE_KEYS.KEY_REWARD_MANAGER, await rewardManager.getAddress());
    await registry.setModule(MODULE_KEYS.KEY_PRICE_ORACLE, await priceOracle.getAddress());
    await registry.setModule(MODULE_KEYS.KEY_ASSET_WHITELIST, await assetWhitelist.getAddress());
    await registry.setModule(MODULE_KEYS.KEY_GUARANTEE_FUND, await guaranteeFundManager.getAddress());
    await registry.setModule(MODULE_KEYS.KEY_EARLY_REPAYMENT_GUARANTEE, await earlyRepaymentGuaranteeManager.getAddress());
    await registry.setModule(MODULE_KEYS.KEY_LIQUIDATION_MANAGER, await liquidationManager.getAddress());
    await registry.setModule(MODULE_KEYS.KEY_LIQUIDATION_RISK_MANAGER, await liquidationRiskManager.getAddress());
    await registry.setModule(MODULE_KEYS.KEY_HEALTH_VIEW, await healthView.getAddress());
    await registry.setModule(MODULE_KEYS.KEY_POSITION_VIEW, await positionView.getAddress());
    await registry.setModule(MODULE_KEYS.KEY_LENDER_POOL_VAULT, await lenderPoolVault.getAddress());

    // 12. 部署 VaultRouter（非 UUPS，使用构造函数）
    const VaultRouterFactory = await ethers.getContractFactory('src/Vault/VaultRouter.sol:VaultRouter');
    vaultRouter = await VaultRouterFactory.deploy(
      await registry.getAddress(),
      await assetWhitelist.getAddress(),
      await priceOracle.getAddress(),
      await usdt.getAddress()
    );
    await vaultRouter.waitForDeployment();

    // 13. 部署 VaultBusinessLogic
    vaultBusinessLogic = await deployProxyContract<VaultBusinessLogic>('VaultBusinessLogic', [
      await registry.getAddress(),
      await usdt.getAddress()
    ]);

    // 14. 部署 SettlementBorrowCoreMock，提供 borrowFor 入口（测试替身）
    const BorrowCoreFactory = await ethers.getContractFactory('SettlementBorrowCoreMock');
    vaultCore = await BorrowCoreFactory.deploy(await registry.getAddress(), await vaultRouter.getAddress());
    await vaultCore.waitForDeployment();

    // 15. 配置模块到 Registry
    await registry.setModule(MODULE_KEYS.KEY_VAULT_CORE, await vaultCore.getAddress());
    await registry.setModule(MODULE_KEYS.KEY_VAULT_VIEW, await vaultRouter.getAddress());
    // 对于 SettlementBorrowCoreMock，KEY_VAULT_ROUTER 指向 core 自身，便于 CM 的 onlyVaultRouter 校验通过
    await registry.setModule(MODULE_KEYS.KEY_VAULT_ROUTER, await vaultCore.getAddress());
    await registry.setModule(MODULE_KEYS.KEY_VAULT_BUSINESS_LOGIC, await vaultBusinessLogic.getAddress());
    await vaultRouter.connect(governance).refreshModuleCache();
    await vaultRouter.connect(governance).setTestingMode(true); // 测试模式，避免缺失模块导致写路径中断

    // 15.1 资产白名单：允许 RWA 与 USDT
    await assetWhitelist.setAssetAllowed(await rwa.getAddress(), true);
    await assetWhitelist.setAssetAllowed(await usdt.getAddress(), true);

    // 15. 设置权限
    
    const vblAddr = await vaultBusinessLogic.getAddress();
    const vaultCoreAddr = await vaultCore.getAddress();
    
    // 给 governance 授予权限
    const governanceRoles = [
      ROLES.SET_PARAMETER,
      ROLES.ADMIN,
      ROLES.UPGRADE_MODULE,
      ROLES.PAUSE_SYSTEM,
      ROLES.DEPOSIT,
      ROLES.BORROW,
      ROLES.REPAY,
      ROLES.WITHDRAW,
      ROLES.UNPAUSE_SYSTEM,
    ];
    
    for (const role of governanceRoles) {
      if (!(await acm.hasRole(role, governanceAddr))) {
        await acm.grantRole(role, governanceAddr);
      }
    }
    // FeeRouter 需要 SET_PARAMETER 角色
    await feeRouter.connect(governance).addSupportedToken(await usdt.getAddress());
    
    // 给 VaultBusinessLogic 授予权限
    const vblRoles = [
      ROLES.ORDER_CREATE,
      ROLES.DEPOSIT,
      ROLES.WITHDRAW,
      ROLES.BORROW,
      ROLES.REPAY,
      ROLES.SET_PARAMETER,
      ROLES.UPGRADE_MODULE,
    ];
    
    for (const role of vblRoles) {
      if (!(await acm.hasRole(role, vblAddr))) {
        await acm.grantRole(role, vblAddr);
      }
    }
    
    // 给 VaultCore 授予权限
    const vaultCoreRoles = [
      ROLES.DEPOSIT,
      ROLES.WITHDRAW,
      ROLES.BORROW,
      ROLES.REPAY,
    ];
    
    for (const role of vaultCoreRoles) {
      if (!(await acm.hasRole(role, vaultCoreAddr))) {
        await acm.grantRole(role, vaultCoreAddr);
      }
    }

    // 给 LendingEngine 授予借款铸证权限（ACTION_BORROW）
    const leAddr = await orderEngine.getAddress();
    if (!(await acm.hasRole(ROLES.BORROW, leAddr))) {
      await acm.grantRole(ROLES.BORROW, leAddr);
    }

    // 16. 给用户授权
    await rwa.connect(borrower).approve(await vaultCore.getAddress(), ethers.MaxUint256);
    await usdt.connect(lender).approve(await vaultBusinessLogic.getAddress(), ethers.MaxUint256);

    return {
      governance,
      borrower,
      lender,
      registry,
      acm,
      cm,
      leBasic,
      orderEngine,
      loanNft,
      rewardManager,
      feeRouter,
      vaultCore,
      vaultRouter,
      vaultBusinessLogic,
      lenderPoolVault,
      priceOracle,
      usdt,
      rwa,
      assetWhitelist,
      guaranteeFundManager,
      earlyRepaymentGuaranteeManager,
      liquidationRiskManager,
      healthView
    };
  }

  beforeEach(async function () {
    const fixture = await loadFixture(deployFixture);
    
    // 解构 fixture 到全局变量
    governance = fixture.governance;
    borrower = fixture.borrower;
    lender = fixture.lender;
    registry = fixture.registry;
    acm = fixture.acm;
    cm = fixture.cm;
    leBasic = fixture.leBasic;
    orderEngine = fixture.orderEngine;
    loanNft = fixture.loanNft;
    rewardManager = fixture.rewardManager;
    feeRouter = fixture.feeRouter;
    vaultCore = fixture.vaultCore;
    vaultRouter = fixture.vaultRouter;
    vaultBusinessLogic = fixture.vaultBusinessLogic;
    lenderPoolVault = fixture.lenderPoolVault;
    priceOracle = fixture.priceOracle;
    usdt = fixture.usdt;
    rwa = fixture.rwa;
    assetWhitelist = fixture.assetWhitelist;
    guaranteeFundManager = fixture.guaranteeFundManager;
    earlyRepaymentGuaranteeManager = fixture.earlyRepaymentGuaranteeManager;
    liquidationRiskManager = fixture.liquidationRiskManager;
    healthView = fixture.healthView;
  });

  describe('双架构撮合流程测试', function () {
    it('应该完成完整的撮合结算流程（EIP-712 签名，经 VaultCore 统一入口落账）', async function () {
      const lenderAddr = await lender.getAddress();
      const borrowerAddr = await borrower.getAddress();
      const usdtAddr = await usdt.getAddress();
      const rwaAddr = await rwa.getAddress();

      // 1. 借款人存入抵押物 - 直接通过 VaultRouter 标准入口
      const depositAmount = ethers.parseEther('100');
      // CollateralManager 会从 borrower 拉取抵押 token，因此需要先给 CM 授权
      await rwa.connect(borrower).approve(await cm.getAddress(), depositAmount);
      // 通过 VaultCore（Mock）入口，满足 VaultRouter 的 onlyVaultCore
      await vaultCore.connect(borrower).deposit(rwaAddr, depositAmount);
      
      // 验证抵押物已存入
      const collateralAfter = await cm.getCollateral(borrowerAddr, rwaAddr);
      expect(collateralAfter).to.equal(depositAmount);

      // 2. 出借人保留资金到池子 via VaultBusinessLogic
      const reserveAmount = ethers.parseUnits('5000', 6);
      const lendSalt = ethers.hexlify(ethers.randomBytes(32));
      
      const now = (await ethers.provider.getBlock('latest'))!.timestamp;
      const lendIntent = {
        lender: lenderAddr,
        asset: usdtAddr,
        amount: reserveAmount,
        minTermDays: 30,
        maxTermDays: 30,
        minRateBps: BigInt(500),
        expireAt: BigInt(now + 3600),
        salt: lendSalt,
      };
      
      const lendIntentHash = hashLendIntent(lendIntent);
      await vaultBusinessLogic.connect(lender).reserveForLending(lenderAddr, usdtAddr, reserveAmount, lendIntentHash);

      // 3. 构建 EIP-712 签名数据（撮合参数）
      const termDays = 30;
      const rateBps = BigInt(500);
      const borrowAmount = ethers.parseUnits('5000', 6);
      const borrowSalt = ethers.hexlify(ethers.randomBytes(32));

      const borrowIntent = {
        borrower: borrowerAddr,
        collateralAsset: ZERO_ADDRESS,
        collateralAmount: 0n,
        borrowAsset: usdtAddr,
        amount: borrowAmount,
        termDays,
        rateBps,
        expireAt: BigInt(now + 3600),
        salt: borrowSalt,
      } as const;

      // 4. EIP-712 domain
      const net = await ethers.provider.getNetwork();
      const domain = {
        name: 'RwaLending',
        version: '1',
        chainId: Number(net.chainId),
        verifyingContract: await vaultBusinessLogic.getAddress(),
      } as const;

      // 5. 签名
      const borrowerSig = await borrower.signTypedData(domain, { BorrowIntent: BorrowIntentTypes }, borrowIntent);
      const lenderSig = await lender.signTypedData(domain, { LendIntent: LendIntentTypes }, lendIntent);

      // 6. 调用 finalizeMatch
      const borrowerUsdtBefore = await usdt.balanceOf(borrowerAddr);
      const tx = await vaultBusinessLogic
        .connect(borrower)
        .finalizeMatch(borrowIntent, [lendIntent], borrowerSig, [lenderSig]);
      const rcpt = await tx.wait();
      expect(rcpt?.status).to.equal(1);

      // 7. 验证撮合结果
      const borrowerUsdtAfter = await usdt.balanceOf(borrowerAddr);
      const platformFee = (borrowAmount * BigInt(100)) / BigInt(10_000); // 1%
      const ecoFee = (borrowAmount * BigInt(1)) / BigInt(10_000); // 0.01%
      const expectedNet = borrowAmount - platformFee - ecoFee;
      expect(borrowerUsdtAfter - borrowerUsdtBefore).to.equal(expectedNet);
      
      const debt = await leBasic.getDebt(borrowerAddr, usdtAddr);
      expect(debt).to.equal(borrowAmount);

      console.log('✅ Complete settlement test passed');
    });
  });
});


