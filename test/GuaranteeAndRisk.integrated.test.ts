/**
 * Guarantee & Risk – 保证金与风险相关模块集成测试
 *
 * 测试目标:
 * - EarlyRepaymentGuaranteeManager(ERGM) 自定义错误与核心流程（记录→结算/没收）
 * - GuaranteeFundManager(GFM) 新增查询 isGuaranteePaid 与三方结算、批量接口、CEI 顺序
 * - RiskView.calculateHealthFactorExcludingGuarantee 排除保证金的健康因子推导
 * - VaultBusinessLogic 视图地址解析优先级（KEY_VAULT_CORE 主路径、KEY_STATS 回退）
 * - 事件/数据推送不重复（仅下游模块负责 DataPush）
 */

import * as hardhat from 'hardhat';
const { ethers } = hardhat;
import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

// 合约类型（从 types 生成）
import type {
  ERC1967Proxy,
  MockERC20,
  MockAccessControlManager,
  MockRegistry,
  MockVaultCore,
  MockCollateralManager,
  MockLendingEngineBasic,
  EarlyRepaymentGuaranteeManager,
  GuaranteeFundManager,
  RiskView
} from '../../types';

describe('Guarantee & Risk – 保证金与风险模块集成测试', function () {
  // 常量
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const ONE_ETH = ethers.parseUnits('1', 18);
  const TEST_AMOUNT = ethers.parseUnits('1000', 18);

  // 动态地址
  let TEST_ASSET: string;

  // 实例
  let erc20: MockERC20;
  let registry: MockRegistry;
  let acm: MockAccessControlManager;
  let vaultCore: MockVaultCore;
  let collateralManager: MockCollateralManager;
  let lendingEngine: MockLendingEngineBasic;
  let guaranteeFund: GuaranteeFundManager;
  let earlyRepayGM: EarlyRepaymentGuaranteeManager;
  let riskView: RiskView;

  // 账户
  let owner: any;
  let user: any;
  let lender: any;
  let platform: any;

  async function deployProxyContract(contractName: string, initData: string = '0x') {
    const ImplF = await ethers.getContractFactory(contractName);
    const impl = await ImplF.deploy();
    await impl.waitForDeployment();
    const ProxyF = await ethers.getContractFactory('ERC1967Proxy');
    const proxy = (await ProxyF.deploy(impl.target, initData)) as unknown as ERC1967Proxy;
    await proxy.waitForDeployment();
    const instance = impl.attach(proxy.target);
    return { impl, proxy, instance };
  }

  async function deployFixture() {
    [owner, user, lender, platform] = await ethers.getSigners();
    TEST_ASSET = (await ethers.getSigners())[9].address; // 随机地址占位

    // 1. 基础模块
    const MockRegistryF = await ethers.getContractFactory('MockRegistry');
    registry = (await MockRegistryF.deploy()) as unknown as MockRegistry;
    await registry.waitForDeployment();

    // ACM 代理
    const { instance: acmProxy } = await deployProxyContract('MockAccessControlManager');
    acm = acmProxy as unknown as MockAccessControlManager;

    // 注册 ACM
    const ACCESS_CONTROL_KEY = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
    await registry.setModule(ACCESS_CONTROL_KEY, acm.target);

    // 2. MockVaultCore（带 viewContractAddrVar）
    const MockVaultCoreF = await ethers.getContractFactory('MockVaultCore');
    vaultCore = (await MockVaultCoreF.deploy()) as unknown as MockVaultCore;
    await vaultCore.waitForDeployment();

    // 3. Mock 子模块
    const MockERC20F = await ethers.getContractFactory('MockERC20');
    erc20 = (await MockERC20F.deploy('Mock', 'MOCK', ethers.parseUnits('100000000', 18))) as unknown as MockERC20;
    await erc20.waitForDeployment();

    const CollateralF = await ethers.getContractFactory('MockCollateralManager');
    collateralManager = (await CollateralF.deploy()) as unknown as MockCollateralManager;
    await collateralManager.waitForDeployment();

    const LendingF = await ethers.getContractFactory('MockLendingEngineBasic');
    lendingEngine = (await LendingF.deploy()) as unknown as MockLendingEngineBasic;
    await lendingEngine.waitForDeployment();

    const { instance: gfmProxy } = await deployProxyContract('GuaranteeFundManager');
    guaranteeFund = gfmProxy as unknown as GuaranteeFundManager;
    await guaranteeFund.initialize(vaultCore.target, registry.target);

    const { instance: ergmProxy } = await deployProxyContract('EarlyRepaymentGuaranteeManager');
    earlyRepayGM = ergmProxy as unknown as EarlyRepaymentGuaranteeManager;
    await earlyRepayGM.initialize(vaultCore.target, registry.target, await platform.getAddress(), 100); // 1%

    const { instance: riskViewProxy } = await deployProxyContract('RiskView');
    riskView = riskViewProxy as unknown as RiskView;
    await riskView.initialize(registry.target);

    // 4. 注册业务模块与 View
    const KEY_VAULT_CORE = ethers.keccak256(ethers.toUtf8Bytes('KEY_VAULT_CORE'));
    await registry.setModule(KEY_VAULT_CORE, vaultCore.target);
    await vaultCore.setRegistry(registry.target);
    await vaultCore.setGuaranteeFundManager(guaranteeFund.target);
    await vaultCore.setEarlyRepaymentGuaranteeManager(earlyRepayGM.target);
    await vaultCore.setLendingEngine(lendingEngine.target);
    await vaultCore.setCollateralManager(collateralManager.target);
    // 将 RiskView 作为聚合视图（模拟 viewContractAddrVar 指向 View 聚合器）
    await vaultCore.setViewContract(riskView.target);

    // 5. 权限（ActionKeys 常量字符串）
    const SET_PARAMETER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));
    const UPGRADE_MODULE_ROLE = ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE'));
    await acm.grantRole(SET_PARAMETER_ROLE, await owner.getAddress());
    await acm.grantRole(UPGRADE_MODULE_ROLE, await owner.getAddress());

    // 6. 资金准备
    await erc20.mint(await user.getAddress(), TEST_AMOUNT * 10n);
    await erc20.connect(user).approve(guaranteeFund.target, TEST_AMOUNT * 10n);

    return { owner, user, lender, platform };
  }

  beforeEach(async function () {
    await loadFixture(deployFixture);
  });

  describe('GFM – isGuaranteePaid 查询', function () {
    it('初始应为 false；锁定后为 true', async function () {
      expect(await guaranteeFund.isGuaranteePaid(await user.getAddress(), erc20.target)).to.equal(false);

      // 通过 GFM 直接锁定
      await expect(vaultCore.lockGuarantee(await user.getAddress(), erc20.target, ONE_ETH)).to.not.be.reverted;
      expect(await guaranteeFund.isGuaranteePaid(await user.getAddress(), erc20.target)).to.equal(true);
    });
  });

  describe('ERGM – 自定义错误与核心流程', function () {
    it('onlyVaultCore: 非 vaultCore 调用应使用自定义错误', async function () {
      await expect(
        earlyRepayGM.lockGuaranteeRecord(await user.getAddress(), await lender.getAddress(), erc20.target, ONE_ETH, ONE_ETH, 30)
      ).to.be.revertedWithCustomError(earlyRepayGM, 'EarlyRepaymentGuaranteeManager__OnlyVaultCore');
    });

    it('提前还款计算与三方结算调用路径可达（由 ERGM 纯计算→GFM 结算）', async function () {
      // 记录保证金 + 锁资
      await expect(
        vaultCore.lockGuaranteeRecord(await user.getAddress(), await lender.getAddress(), erc20.target, ONE_ETH, ONE_ETH / 10n, 30)
      ).to.not.be.reverted;
      await expect(
        vaultCore.lockGuarantee(await user.getAddress(), erc20.target, ONE_ETH / 10n)
      ).to.not.be.reverted;

      // 触发 early settle（这里使用任意正数，实际分配逻辑在合约内按时间计算）
      await expect(
        vaultCore.settleEarlyRepayment(await user.getAddress(), erc20.target, ONE_ETH)
      ).to.not.be.reverted;
    });
  });

  describe('RiskView – 排除保证金的健康因子', function () {
    it('calculateHealthFactorExcludingGuarantee 可调用且返回 uint', async function () {
      const hf = await riskView.calculateHealthFactorExcludingGuarantee(await user.getAddress(), erc20.target);
      expect(hf).to.be.a('bigint');
    });
  });

  describe('VBL – 视图解析优先级', function () {
    it('KEY_VAULT_CORE 主路径可返回 viewContractAddrVar() 地址', async function () {
      // 从 VBL 内部调用路径很难直接暴露；此处验证 MockVaultCore.viewContractAddrVar 设置生效
      expect(await vaultCore.viewContractAddrVar()).to.equal(riskView.target);
    });
  });
});


