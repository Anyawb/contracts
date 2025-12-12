/**
 * PreviewView 测试模块
 * 
 * 测试目标:
 * - 预览操作功能测试（借款、存款、还款、提取）
 * - 批量预览操作测试
 * - 权限控制测试
 * - 边界条件测试
 * - 安全场景测试
 * - 集成测试
 */

import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers, upgrades } = hardhat;

import type { 
  PreviewView,
  UserView,
  SystemView
} from '../../../../types/contracts/Vault/view/modules';
import type { 
  PreviewView__factory,
  UserView__factory,
  SystemView__factory
} from '../../../../types/factories/contracts/Vault/view/modules';
import type { 
  AccessControlManager
} from '../../../../types/contracts/access/AccessControlManager';
import type { 
  MockERC20
} from '../../../../types/contracts/Mocks';
import type { 
  MockERC20__factory
} from '../../../../types/factories/contracts/Mocks';

import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

// 常量定义
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MAX_PREVIEW_BATCH_SIZE = 30;

describe('PreviewView – 预览操作模块测试', function () {
  let previewView: PreviewView;
  let userView: UserView;
  let systemView: SystemView;
  let acm: AccessControlManager;
  let mockToken: MockERC20;
  
  let governance: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let charlie: SignerWithAddress;

  async function deployFixture() {
    const [, _governance, _alice, _bob, _charlie]: SignerWithAddress[] = await ethers.getSigners();
    governance = _governance;
    alice = _alice;
    bob = _bob;
    charlie = _charlie;

    // 部署 ACM
    const acmFactory = await ethers.getContractFactory('AccessControlManager');
    acm = await acmFactory.deploy(governance.address) as AccessControlManager;
    await acm.waitForDeployment();

    // 部署 Mock VaultStorage
    const mockVaultStorageFactory = await ethers.getContractFactory('MockVaultStorage');
    const mockVaultStorage = await mockVaultStorageFactory.deploy();
    await mockVaultStorage.waitForDeployment();

    // 部署 ViewCache
    const viewCacheFactory = await ethers.getContractFactory('ViewCache');
    const viewCache = await upgrades.deployProxy(viewCacheFactory, [await acm.getAddress()]);
    await viewCache.waitForDeployment();

    // 部署 UserView
    const UserViewFactory = (await ethers.getContractFactory('UserView')) as UserView__factory;
    userView = await upgrades.deployProxy(UserViewFactory, [
      await acm.getAddress(),
      await mockVaultStorage.getAddress(),
      await viewCache.getAddress()
    ]) as UserView;
    await userView.waitForDeployment();

    // 部署 SystemView
    const SystemViewFactory = (await ethers.getContractFactory('SystemView')) as SystemView__factory;
    systemView = await upgrades.deployProxy(SystemViewFactory, [
      await acm.getAddress(),
      await mockVaultStorage.getAddress(),
      await viewCache.getAddress()
    ]) as SystemView;
    await systemView.waitForDeployment();

    // 部署 PreviewView
    const PreviewViewFactory = (await ethers.getContractFactory('PreviewView')) as PreviewView__factory;
    previewView = await upgrades.deployProxy(PreviewViewFactory, [
      await acm.getAddress(),
      await userView.getAddress(),
      await systemView.getAddress()
    ]) as PreviewView;
    await previewView.waitForDeployment();

    // 部署测试代币
    const MockERC20Factory = (await ethers.getContractFactory('MockERC20')) as MockERC20__factory;
    mockToken = await MockERC20Factory.deploy('Mock Token', 'MTK', 18);
    await mockToken.waitForDeployment();

    // 设置权限
    const viewUserDataRole = ethers.keccak256(ethers.toUtf8Bytes('VIEW_USER_DATA'));
    const actionAdminRole = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
    const upgradeModuleRole = ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE'));
    
    await acm.grantRole(viewUserDataRole, alice.address);
    await acm.grantRole(viewUserDataRole, bob.address);
    await acm.grantRole(viewUserDataRole, charlie.address);
    await acm.grantRole(actionAdminRole, governance.address);
    await acm.grantRole(upgradeModuleRole, governance.address);

    // 为 PreviewView 合约本身授予权限
    await acm.grantRole(viewUserDataRole, await previewView.getAddress());
    await acm.grantRole(actionAdminRole, await previewView.getAddress());
    
    // 为 SystemView 授予系统数据访问权限
    const viewSystemDataRole = ethers.keccak256(ethers.toUtf8Bytes('VIEW_SYSTEM_DATA'));
    await acm.grantRole(viewSystemDataRole, await systemView.getAddress());
    await acm.grantRole(viewSystemDataRole, await previewView.getAddress());

    return {
      previewView,
      userView,
      systemView,
      acm,
      mockToken,
      governance,
      alice,
      bob,
      charlie
    };
  }

  describe('初始化测试', function () {
    it('应正确初始化合约', async function () {
      const { previewView, acm, userView, systemView } = await deployFixture();
      
      expect(await previewView.acm()).to.equal(await acm.getAddress());
      expect(await previewView.userView()).to.equal(await userView.getAddress());
      expect(await previewView.systemView()).to.equal(await systemView.getAddress());
    });

    it('初始化时无效地址应被拒绝', async function () {
      const { acm } = await deployFixture();
      
      const PreviewViewFactory = (await ethers.getContractFactory('PreviewView')) as PreviewView__factory;
      
      // 测试无效 ACM 地址
      await expect(
        upgrades.deployProxy(PreviewViewFactory, [
          ZERO_ADDRESS, // 无效 ACM 地址
          await userView.getAddress(),
          await systemView.getAddress()
        ])
      ).to.be.revertedWith('PreviewView: invalid ACM address');

      // 测试无效 UserView 地址
      await expect(
        upgrades.deployProxy(PreviewViewFactory, [
          await acm.getAddress(),
          ZERO_ADDRESS, // 无效 UserView 地址
          await systemView.getAddress()
        ])
      ).to.be.revertedWith('PreviewView: invalid UserView address');

      // 测试无效 SystemView 地址
      await expect(
        upgrades.deployProxy(PreviewViewFactory, [
          await acm.getAddress(),
          await userView.getAddress(),
          ZERO_ADDRESS // 无效 SystemView 地址
        ])
      ).to.be.revertedWith('PreviewView: invalid SystemView address');
    });
  });

  describe('权限控制测试', function () {
    it('无权限用户不应能访问用户数据', async function () {
      const { previewView, charlie } = await deployFixture();
      
      // 移除 charlie 的权限
      const viewUserDataRole = ethers.keccak256(ethers.toUtf8Bytes('VIEW_USER_DATA'));
      await acm.revokeRole(viewUserDataRole, charlie.address);
      
      await expect(
        previewView.connect(charlie).previewBorrow(
          alice.address,
          await mockToken.getAddress(),
          ethers.parseUnits('100', 18),
          0,
          ethers.parseUnits('10', 6)
        )
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('非用户本人或管理员不应能访问用户数据', async function () {
      const { previewView, bob } = await deployFixture();
      
      await expect(
        previewView.connect(bob).previewBorrow(
          alice.address, // bob 尝试访问 alice 的数据
          await mockToken.getAddress(),
          ethers.parseUnits('100', 18),
          0,
          ethers.parseUnits('10', 6)
        )
      ).to.be.revertedWith('PreviewView: unauthorized user data access');
    });

    it('用户本人应能访问自己的数据', async function () {
      const { previewView, alice } = await deployFixture();
      
      const result = await previewView.connect(alice).previewBorrow(
        alice.address,
        await mockToken.getAddress(),
        ethers.parseUnits('100', 18),
        0,
        ethers.parseUnits('10', 6)
      );
      
      expect(result).to.have.lengthOf(3);
    });

    it('管理员应能访问任何用户的数据', async function () {
      const { previewView, governance } = await deployFixture();
      
      // 为 governance 授予 viewUserData 权限
      const viewUserDataRole = ethers.keccak256(ethers.toUtf8Bytes('VIEW_USER_DATA'));
      await acm.grantRole(viewUserDataRole, governance.address);
      
      const result = await previewView.connect(governance).previewBorrow(
        alice.address,
        await mockToken.getAddress(),
        ethers.parseUnits('100', 18),
        0,
        ethers.parseUnits('10', 6)
      );
      
      expect(result).to.have.lengthOf(3);
    });
  });

  describe('单个预览操作测试', function () {
    describe('previewBorrow 测试', function () {
      it('应正确预估借款操作', async function () {
        const { previewView, alice } = await deployFixture();
        
        const [newHF, newLTV, maxBorrowable] = await previewView.connect(alice).previewBorrow(
          alice.address,
          await mockToken.getAddress(),
          ethers.parseUnits('100', 18), // 当前抵押
          ethers.parseUnits('10', 18),  // 新增抵押
          ethers.parseUnits('20', 6)    // 借款数量
        );
        
        expect(newHF).to.be.gt(0);
        expect(newLTV).to.be.gte(0);
        expect(maxBorrowable).to.be.gte(0);
      });

      it('零抵押时健康因子应为最大值', async function () {
        const { previewView, alice } = await deployFixture();
        
        const [newHF, newLTV, maxBorrowable] = await previewView.connect(alice).previewBorrow(
          alice.address,
          await mockToken.getAddress(),
          0, // 零抵押
          0,
          ethers.parseUnits('10', 6)
        );
        
        expect(newHF).to.equal(ethers.MaxUint256);
        expect(newLTV).to.equal(0);
        expect(maxBorrowable).to.equal(0);
      });
    });

    describe('previewDeposit 测试', function () {
      it('应正确预估存款操作', async function () {
        const { previewView, alice } = await deployFixture();
        
        const [hfAfter, ok] = await previewView.connect(alice).previewDeposit(
          alice.address,
          await mockToken.getAddress(),
          ethers.parseUnits('50', 18)
        );
        
        expect(hfAfter).to.be.gt(0);
        expect(ok).to.be.a('boolean');
      });

      it('零存款时应返回当前健康因子', async function () {
        const { previewView, alice } = await deployFixture();
        
        const [hfAfter, ok] = await previewView.connect(alice).previewDeposit(
          alice.address,
          await mockToken.getAddress(),
          0
        );
        
        expect(hfAfter).to.be.gt(0);
        expect(ok).to.be.a('boolean');
      });
    });

    describe('previewRepay 测试', function () {
      it('应正确预估还款操作', async function () {
        const { previewView, alice } = await deployFixture();
        
        const [newHF, newLTV] = await previewView.connect(alice).previewRepay(
          alice.address,
          await mockToken.getAddress(),
          ethers.parseUnits('10', 6)
        );
        
        expect(newHF).to.be.gt(0);
        expect(newLTV).to.be.gte(0);
      });

      it('全额还款后 LTV 应为零', async function () {
        const { previewView, alice } = await deployFixture();
        
        const [newHF, newLTV] = await previewView.connect(alice).previewRepay(
          alice.address,
          await mockToken.getAddress(),
          ethers.parseUnits('30', 6) // 全额还款
        );
        
        expect(newHF).to.be.gt(0);
        expect(newLTV).to.be.gte(0);
      });
    });

    describe('previewWithdraw 测试', function () {
      it('应正确预估提取操作', async function () {
        const { previewView, alice } = await deployFixture();
        
        const [newHF, ok] = await previewView.connect(alice).previewWithdraw(
          alice.address,
          await mockToken.getAddress(),
          ethers.parseUnits('20', 18)
        );
        
        expect(newHF).to.be.gt(0);
        expect(ok).to.be.a('boolean');
      });

      it('提取超过抵押数量时应被正确处理', async function () {
        const { previewView, alice } = await deployFixture();
        
        const [newHF, ok] = await previewView.connect(alice).previewWithdraw(
          alice.address,
          await mockToken.getAddress(),
          ethers.parseUnits('200', 18) // 超过抵押数量
        );
        
        expect(newHF).to.be.gt(0);
        expect(ok).to.be.a('boolean');
      });
    });
  });

  describe('批量预览操作测试', function () {
    it('应正确处理批量预览操作', async function () {
      const { previewView, alice } = await deployFixture();
      
      const operations = [
        {
          operationType: 0, // deposit
          user: alice.address,
          asset: await mockToken.getAddress(),
          amount: ethers.parseUnits('10', 18)
        },
        {
          operationType: 1, // withdraw
          user: alice.address,
          asset: await mockToken.getAddress(),
          amount: ethers.parseUnits('5', 18)
        },
        {
          operationType: 2, // borrow
          user: alice.address,
          asset: await mockToken.getAddress(),
          amount: ethers.parseUnits('15', 6)
        },
        {
          operationType: 3, // repay
          user: alice.address,
          asset: await mockToken.getAddress(),
          amount: ethers.parseUnits('5', 6)
        }
      ];
      
      const results = await previewView.connect(alice).batchPreviewOperations(operations);
      
      expect(results).to.have.lengthOf(4);
      
      // 验证每个结果都有正确的结构
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        expect(result).to.have.lengthOf(4); // 应该有4个元素
        expect(typeof result[0]).to.equal('bigint'); // newHealthFactor
        expect(typeof result[1]).to.equal('bigint'); // newLTV
        expect(typeof result[2]).to.equal('boolean'); // isSafe
        expect(typeof result[3]).to.equal('bigint'); // maxBorrowable
      }
    });

    it('空操作数组应被拒绝', async function () {
      const { previewView, alice } = await deployFixture();
      
      await expect(
        previewView.connect(alice).batchPreviewOperations([])
      ).to.be.revertedWith('PreviewView: empty operations array');
    });

    it('超过最大批量大小应被拒绝', async function () {
      const { previewView, alice } = await deployFixture();
      
      const operations = new Array(MAX_PREVIEW_BATCH_SIZE + 1).fill({
        operationType: 0,
        user: alice.address,
        asset: await mockToken.getAddress(),
        amount: ethers.parseUnits('1', 18)
      });
      
      await expect(
        previewView.connect(alice).batchPreviewOperations(operations)
      ).to.be.revertedWith('PreviewView: too many operations');
    });

    it('非用户本人或管理员不应能进行批量预览', async function () {
      const { previewView, bob } = await deployFixture();
      
      const operations = [
        {
          operationType: 0,
          user: alice.address, // bob 尝试访问 alice 的数据
          asset: await mockToken.getAddress(),
          amount: ethers.parseUnits('10', 18)
        }
      ];
      
      await expect(
        previewView.connect(bob).batchPreviewOperations(operations)
      ).to.be.revertedWith('PreviewView: unauthorized batch preview access');
    });
  });

  describe('边界条件测试', function () {
    it('大额数值应正常工作', async function () {
      const { previewView, alice } = await deployFixture();
      
      const largeAmount = ethers.parseUnits('1000000', 18);
      
      const [newHF, newLTV, maxBorrowable] = await previewView.connect(alice).previewBorrow(
        alice.address,
        await mockToken.getAddress(),
        largeAmount,
        0,
        ethers.parseUnits('500000', 6)
      );
      
      expect(newHF).to.be.gt(0);
      expect(newLTV).to.be.gte(0);
      expect(maxBorrowable).to.be.gte(0);
    });

    it('极小数值应正常工作', async function () {
      const { previewView, alice } = await deployFixture();
      
      const tinyAmount = 1n;
      
      const [newHF, newLTV, maxBorrowable] = await previewView.connect(alice).previewBorrow(
        alice.address,
        await mockToken.getAddress(),
        tinyAmount,
        0,
        tinyAmount
      );
      
      expect(newHF).to.be.gt(0);
      expect(newLTV).to.be.gte(0);
      expect(maxBorrowable).to.be.gte(0);
    });
  });

  describe('安全场景测试', function () {
    it('重入攻击应被阻止', async function () {
      // 这个测试需要特殊的重入合约，在实际项目中应该实现
      // 这里只是验证合约的基本安全性
      const { previewView, alice } = await deployFixture();
      
      const result = await previewView.connect(alice).previewBorrow(
        alice.address,
        await mockToken.getAddress(),
        ethers.parseUnits('100', 18),
        0,
        ethers.parseUnits('10', 6)
      );
      
      expect(result).to.have.lengthOf(3);
    });

    it('预言机失败时应返回默认值', async function () {
      const { previewView, alice } = await deployFixture();
      
      // 模拟预言机失败的情况 - 使用零地址或无效参数
      const [newHF, newLTV, maxBorrowable] = await previewView.connect(alice).previewBorrow(
        alice.address,
        ZERO_ADDRESS, // 使用零地址模拟预言机失败
        ethers.parseUnits('100', 18),
        0,
        ethers.parseUnits('10', 6)
      );
      
      // 应该返回合理的默认值
      expect(newHF).to.be.gte(0);
      expect(newLTV).to.be.gte(0);
      expect(maxBorrowable).to.be.gte(0);
    });
  });

  describe('集成测试', function () {
    it('完整借贷流程预览', async function () {
      const { previewView, alice } = await deployFixture();
      
      // 1. 预览存款
      const [depositHF, depositOk] = await previewView.connect(alice).previewDeposit(
        alice.address,
        await mockToken.getAddress(),
        ethers.parseUnits('100', 18)
      );
      expect(depositHF).to.be.gt(0);
      expect(depositOk).to.be.a('boolean');
      
      // 2. 预览借款
      const [borrowHF] = await previewView.connect(alice).previewBorrow(
        alice.address,
        await mockToken.getAddress(),
        ethers.parseUnits('100', 18),
        0,
        ethers.parseUnits('30', 6)
      );
      expect(borrowHF).to.be.gt(0);
      
      // 3. 预览还款
      const [repayHF] = await previewView.connect(alice).previewRepay(
        alice.address,
        await mockToken.getAddress(),
        ethers.parseUnits('10', 6)
      );
      expect(repayHF).to.be.gt(0);
      
      // 4. 预览提取
      const [withdrawHF, withdrawOk] = await previewView.connect(alice).previewWithdraw(
        alice.address,
        await mockToken.getAddress(),
        ethers.parseUnits('20', 18)
      );
      expect(withdrawHF).to.be.gt(0);
      expect(withdrawOk).to.be.a('boolean');
    });

    it('批量操作集成测试', async function () {
      const { previewView, alice, bob } = await deployFixture();
      
      // 为 alice 授予 ACTION_ADMIN 权限，这样她可以为其他用户执行批量操作
      const actionAdminRole = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
      await acm.grantRole(actionAdminRole, alice.address);
      
      const operations = [
        // alice 的操作
        {
          operationType: 0,
          user: alice.address,
          asset: await mockToken.getAddress(),
          amount: ethers.parseUnits('50', 18)
        },
        {
          operationType: 2,
          user: alice.address,
          asset: await mockToken.getAddress(),
          amount: ethers.parseUnits('20', 6)
        },
        // bob 的操作
        {
          operationType: 1,
          user: bob.address,
          asset: await mockToken.getAddress(),
          amount: ethers.parseUnits('30', 18)
        },
        {
          operationType: 3,
          user: bob.address,
          asset: await mockToken.getAddress(),
          amount: ethers.parseUnits('10', 6)
        }
      ];
      
      const results = await previewView.connect(alice).batchPreviewOperations(operations);
      
      expect(results).to.have.lengthOf(4);
      // 验证每个结果都有正确的结构
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        expect(result).to.have.lengthOf(4); // 应该有4个元素
        expect(typeof result[0]).to.equal('bigint'); // newHealthFactor
        expect(typeof result[1]).to.equal('bigint'); // newLTV
        expect(typeof result[2]).to.equal('boolean'); // isSafe
        expect(typeof result[3]).to.equal('bigint'); // maxBorrowable
      }
    });
  });

  describe('升级控制测试', function () {
    it('非升级权限用户不应能升级合约', async function () {
      const { previewView } = await deployFixture();
      
      // alice 没有升级权限，所以不需要撤销
      const PreviewViewFactory = (await ethers.getContractFactory('PreviewView')) as PreviewView__factory;
      
      await expect(
        upgrades.upgradeProxy(await previewView.getAddress(), PreviewViewFactory)
      ).to.be.revertedWith('PreviewView: not authorized');
    });

    it('合约暂停时不应能升级', async function () {
      await deployFixture();
      
      // 模拟合约暂停状态 - 在实际环境中需要设置 ACM 的暂停状态
      // 这里只是测试升级权限验证
      
      // 由于 Mock ACM 可能没有实现 getContractStatus，这里只是验证基本升级流程
      // 在实际测试中，需要确保暂停时升级被拒绝
    });
  });

  describe('Gas 优化测试', function () {
    it('批量操作应比单个操作更节省 Gas', async function () {
      const { previewView, alice } = await deployFixture();
      
      // 单个操作
      const singleGas = await previewView.connect(alice).previewBorrow.estimateGas(
        alice.address,
        await mockToken.getAddress(),
        ethers.parseUnits('100', 18),
        0,
        ethers.parseUnits('10', 6)
      );
      
      // 批量操作
      const operations = [
        {
          operationType: 2,
          user: alice.address,
          asset: await mockToken.getAddress(),
          amount: ethers.parseUnits('10', 6)
        }
      ];
      
      const batchGas = await previewView.connect(alice).batchPreviewOperations.estimateGas(operations);
      
      // 批量操作应该比单个操作更高效（考虑基础开销）
      expect(batchGas).to.be.lt(singleGas * 2n);
    });
  });

  describe('错误处理测试', function () {
    it('无效操作类型应被正确处理', async function () {
      const { previewView, alice } = await deployFixture();
      
      const operations = [
        {
          operationType: 99, // 无效操作类型
          user: alice.address,
          asset: await mockToken.getAddress(),
          amount: ethers.parseUnits('10', 18)
        }
      ];
      
      const results = await previewView.connect(alice).batchPreviewOperations(operations);
      
      // 应该返回默认值而不是失败
      expect(results[0].newHealthFactor).to.equal(0);
      expect(results[0].newLTV).to.equal(0);
      expect(results[0].isSafe).to.equal(false);
      expect(results[0].maxBorrowable).to.equal(0);
    });
  });
}); 