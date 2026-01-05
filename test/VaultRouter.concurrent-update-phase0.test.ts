/**
 * VaultRouter 并发更新 Phase 0 测试
 * 
 * 测试目标（基于 Architecture-Concurrent-Update-Plan.md）:
 * - Phase 0: 统一入口与链下节流
 *   - 强制统一入口：所有推送只能经过 VaultCore → VaultRouter
 *   - 事件携带上下文：在推送事件中补充 requestId/seq
 *   - 权限收紧：VaultRouter 的推送接口只允许 VaultCore 调用
 *   - 业务模块只能通过 VaultCore 推送
 * 
 * 规范：参考 docs/test-file-standards.md
 */

import * as hardhat from 'hardhat';
const { ethers } = hardhat;
import { expect } from 'chai';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

// 导入合约类型
import type {
  VaultRouter,
  VaultCore,
  MockAccessControlManager,
  MockCollateralManager,
  MockLendingEngineBasic,
  MockPriceOracle,
  MockRegistry,
  MockAssetWhitelist,
  MockERC20,
} from '../../types';

describe('VaultRouter – 并发更新 Phase 0 测试', function () {
  // 测试常量
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const ONE_ETH = ethers.parseUnits('1', 18);

  // 测试变量
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let businessModule1: SignerWithAddress;
  let businessModule2: SignerWithAddress;
  let unauthorizedCaller: SignerWithAddress;

  // 合约实例
  let vaultRouter: VaultRouter;
  let vaultCore: VaultCore;
  let mockRegistry: MockRegistry;
  let mockAccessControlManager: MockAccessControlManager;
  let mockCollateralManager: MockCollateralManager;
  let mockLendingEngineBasic: MockLendingEngineBasic;
  let mockPriceOracle: MockPriceOracle;
  let mockAssetWhitelist: MockAssetWhitelist;
  let mockSettlementToken: MockERC20;

  // 测试资产
  let testAsset: string;

  /**
   * 部署测试环境
   */
  async function deployFixture() {
    const [
      deployer,
      user1Signer,
      businessModule1Signer,
      businessModule2Signer,
      unauthorizedCallerSigner,
    ] = await ethers.getSigners();

    owner = deployer;
    user1 = user1Signer;
    businessModule1 = businessModule1Signer;
    businessModule2 = businessModule2Signer;
    unauthorizedCaller = unauthorizedCallerSigner;

    // 部署 Mock 合约
    const MockAccessControlManagerFactory = await ethers.getContractFactory('MockAccessControlManager');
    mockAccessControlManager = await MockAccessControlManagerFactory.deploy();

    const MockCollateralManagerFactory = await ethers.getContractFactory('MockCollateralManager');
    mockCollateralManager = await MockCollateralManagerFactory.deploy();

    const MockLendingEngineBasicFactory = await ethers.getContractFactory('MockLendingEngineBasic');
    mockLendingEngineBasic = await MockLendingEngineBasicFactory.deploy();

    const MockPriceOracleFactory = await ethers.getContractFactory('MockPriceOracle');
    mockPriceOracle = await MockPriceOracleFactory.deploy();

    const MockAssetWhitelistFactory = await ethers.getContractFactory('MockAssetWhitelist');
    mockAssetWhitelist = await MockAssetWhitelistFactory.deploy();

    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    mockSettlementToken = await MockERC20Factory.deploy('Settlement Token', 'SETTLE', ethers.parseUnits('1000000', 18));

    const MockRegistryFactory = await ethers.getContractFactory('MockRegistry');
    mockRegistry = await MockRegistryFactory.deploy() as unknown as MockRegistry;

    // 部署 VaultRouter
    const VaultRouterFactory = await ethers.getContractFactory('VaultRouter');
    vaultRouter = await VaultRouterFactory.deploy(
      await mockRegistry.getAddress(),
      await mockAssetWhitelist.getAddress(),
      await mockPriceOracle.getAddress(),
      await mockSettlementToken.getAddress()
    );

    // 部署 VaultCore
    const VaultCoreFactory = await ethers.getContractFactory('VaultCore');
    vaultCore = await VaultCoreFactory.deploy();
    await vaultCore.initialize(await mockRegistry.getAddress(), await vaultRouter.getAddress());

    // 注册模块到 MockRegistry
    const KEY_VAULT_CORE = ethers.keccak256(ethers.toUtf8Bytes('VAULT_CORE'));
    const KEY_CM = ethers.keccak256(ethers.toUtf8Bytes('COLLATERAL_MANAGER'));
    const KEY_LE = ethers.keccak256(ethers.toUtf8Bytes('LENDING_ENGINE'));
    const KEY_PRICE_ORACLE = ethers.keccak256(ethers.toUtf8Bytes('PRICE_ORACLE'));
    const KEY_VAULT_BUSINESS_LOGIC = ethers.keccak256(ethers.toUtf8Bytes('VAULT_BUSINESS_LOGIC'));
    const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
    const KEY_POSITION_VIEW = ethers.keccak256(ethers.toUtf8Bytes('POSITION_VIEW'));
    const KEY_LIQUIDATION_MANAGER = ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATION_MANAGER'));

    await mockRegistry.setModule(KEY_VAULT_CORE, await vaultCore.getAddress());
    await mockRegistry.setModule(KEY_CM, await mockCollateralManager.getAddress());
    await mockRegistry.setModule(KEY_LE, await mockLendingEngineBasic.getAddress());
    await mockRegistry.setModule(KEY_PRICE_ORACLE, await mockPriceOracle.getAddress());
    await mockRegistry.setModule(KEY_VAULT_BUSINESS_LOGIC, await businessModule1.getAddress());
    await mockRegistry.setModule(KEY_ACCESS_CONTROL, await mockAccessControlManager.getAddress());
    await mockRegistry.setModule(KEY_LIQUIDATION_MANAGER, await businessModule2.getAddress());
    const mockPositionView = await (await ethers.getContractFactory('MockPositionView')).deploy();
    await mockRegistry.setModule(KEY_POSITION_VIEW, await mockPositionView.getAddress());

    // 设置测试资产
    testAsset = await user1.getAddress();
    await mockAssetWhitelist.setAssetAllowed(testAsset, true);

    return {
      vaultRouter,
      vaultCore,
      mockRegistry,
      mockAccessControlManager,
      mockCollateralManager,
      mockLendingEngineBasic,
      mockPriceOracle,
      mockAssetWhitelist,
      mockSettlementToken,
      owner,
      user1,
      businessModule1,
      businessModule2,
      unauthorizedCaller,
      testAsset,
    };
  }

  beforeEach(async function () {
    const fixture = await loadFixture(deployFixture);
    Object.assign(this, fixture);
  });

  describe('Phase 0: 统一入口验证', function () {
    it('应该允许 VaultCore 调用 pushUserPositionUpdate（兼容版本）', async function () {
      const vaultCoreAddr = await this.vaultCore.getAddress();
      await ethers.provider.send("hardhat_setBalance", [vaultCoreAddr, "0x1000000000000000000"]);
      const vaultCoreSigner = await ethers.getImpersonatedSigner(vaultCoreAddr);
      
      await expect(
        this.vaultRouter.connect(vaultCoreSigner)['pushUserPositionUpdate(address,address,uint256,uint256)'](
          await this.user1.getAddress(),
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18)
        )
      ).to.emit(this.vaultRouter, 'UserPositionPushed')
        .withArgs(
          await this.user1.getAddress(),
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18),
          anyValue, // timestamp
          ethers.ZeroHash, // requestId (默认 0)
          0 // seq (默认 0)
        );
      
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultCoreAddr]);
    });

    it('应该允许 VaultCore 调用 pushUserPositionUpdate（携带上下文）', async function () {
      const vaultCoreAddr = await this.vaultCore.getAddress();
      await ethers.provider.send("hardhat_setBalance", [vaultCoreAddr, "0x1000000000000000000"]);
      const vaultCoreSigner = await ethers.getImpersonatedSigner(vaultCoreAddr);
      
      const requestId = ethers.keccak256(ethers.toUtf8Bytes('test-request-1'));
      const seq = 123;

      await expect(
        this.vaultRouter.connect(vaultCoreSigner)['pushUserPositionUpdate(address,address,uint256,uint256,bytes32,uint64)'](
          await this.user1.getAddress(),
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18),
          requestId,
          seq
        )
      ).to.emit(this.vaultRouter, 'UserPositionPushed')
        .withArgs(
          await this.user1.getAddress(),
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18),
          anyValue, // timestamp
          requestId,
          seq
        );
      
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultCoreAddr]);
    });

    it('应该拒绝非 VaultCore 调用 pushUserPositionUpdate', async function () {
      await expect(
        this.vaultRouter.connect(this.unauthorizedCaller).pushUserPositionUpdate(
          await this.user1.getAddress(),
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18)
        )
      ).to.be.revertedWithCustomError(this.vaultRouter, 'VaultRouter__UnauthorizedAccess');
    });

    it('应该拒绝业务模块直接调用 VaultRouter 的推送接口', async function () {
      // 业务模块应该通过 VaultCore，而不是直接调用 VaultRouter
      await expect(
        this.vaultRouter.connect(this.businessModule1).pushUserPositionUpdate(
          await this.user1.getAddress(),
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18)
        )
      ).to.be.revertedWithCustomError(this.vaultRouter, 'VaultRouter__UnauthorizedAccess');
    });

    it('应该允许 VaultCore 调用 pushAssetStatsUpdate（兼容版本）', async function () {
      const vaultCoreAddr = await this.vaultCore.getAddress();
      await ethers.provider.send("hardhat_setBalance", [vaultCoreAddr, "0x1000000000000000000"]);
      const vaultCoreSigner = await ethers.getImpersonatedSigner(vaultCoreAddr);
      
      await expect(
        this.vaultRouter.connect(vaultCoreSigner).pushAssetStatsUpdate(
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18),
          ethers.parseUnits('100', 6)
        )
      ).to.emit(this.vaultRouter, 'AssetStatsPushed')
        .withArgs(
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18),
          ethers.parseUnits('100', 6),
          anyValue, // timestamp
          ethers.ZeroHash, // requestId (默认 0)
          0 // seq (默认 0)
        );
      
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultCoreAddr]);
    });

    it('应该允许 VaultCore 调用 pushAssetStatsUpdate（携带上下文）', async function () {
      const vaultCoreAddr = await this.vaultCore.getAddress();
      await ethers.provider.send("hardhat_setBalance", [vaultCoreAddr, "0x1000000000000000000"]);
      const vaultCoreSigner = await ethers.getImpersonatedSigner(vaultCoreAddr);
      
      const requestId = ethers.keccak256(ethers.toUtf8Bytes('test-stats-request-1'));
      const seq = 456;

      await expect(
        this.vaultRouter.connect(vaultCoreSigner).pushAssetStatsUpdate(
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18),
          ethers.parseUnits('100', 6),
          requestId,
          seq
        )
      ).to.emit(this.vaultRouter, 'AssetStatsPushed')
        .withArgs(
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18),
          ethers.parseUnits('100', 6),
          anyValue, // timestamp
          requestId,
          seq
        );
      
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultCoreAddr]);
    });
  });

  describe('Phase 0: VaultCore 统一入口验证', function () {
    it('应该允许业务模块通过 VaultCore 推送用户头寸更新（兼容版本）', async function () {
      await expect(
        this.vaultCore
          .connect(this.businessModule1)
          ['pushUserPositionUpdate(address,address,uint256,uint256)'](
          await this.user1.getAddress(),
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18)
        )
      ).to.emit(this.vaultRouter, 'UserPositionPushed')
        .withArgs(
          await this.user1.getAddress(),
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18),
          anyValue,
          ethers.ZeroHash,
          0
        );
    });

    it('应该允许业务模块通过 VaultCore 推送用户头寸更新（携带上下文）', async function () {
      const requestId = ethers.keccak256(ethers.toUtf8Bytes('business-request-1'));
      const seq = 789;

      await expect(
        this.vaultCore
          .connect(this.businessModule1)
          ['pushUserPositionUpdate(address,address,uint256,uint256,bytes32,uint64)'](
          await this.user1.getAddress(),
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18),
          requestId,
          seq
        )
      ).to.emit(this.vaultRouter, 'UserPositionPushed')
        .withArgs(
          await this.user1.getAddress(),
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18),
          anyValue,
          requestId,
          seq
        );
    });

    it('应该允许 CollateralManager 通过 VaultCore 推送', async function () {
      const cmAddr = await this.mockCollateralManager.getAddress();
      await ethers.provider.send("hardhat_setBalance", [cmAddr, "0x1000000000000000000"]);
      const cmSigner = await ethers.getImpersonatedSigner(cmAddr);
      
      await expect(
        this.vaultCore.connect(cmSigner).pushUserPositionUpdate(
          await this.user1.getAddress(),
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18)
        )
      ).to.emit(this.vaultRouter, 'UserPositionPushed');
      
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [cmAddr]);
    });

    it('应该允许 LendingEngine 通过 VaultCore 推送', async function () {
      const leAddr = await this.mockLendingEngineBasic.getAddress();
      await ethers.provider.send("hardhat_setBalance", [leAddr, "0x1000000000000000000"]);
      const leSigner = await ethers.getImpersonatedSigner(leAddr);
      
      await expect(
        this.vaultCore.connect(leSigner).pushUserPositionUpdate(
          await this.user1.getAddress(),
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18)
        )
      ).to.emit(this.vaultRouter, 'UserPositionPushed');
      
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [leAddr]);
    });

    it('应该允许 LiquidationManager 通过 VaultCore 推送', async function () {
      await expect(
        this.vaultCore.connect(this.businessModule2).pushUserPositionUpdate(
          await this.user1.getAddress(),
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18)
        )
      ).to.emit(this.vaultRouter, 'UserPositionPushed');
    });

    it('应该拒绝未授权调用者通过 VaultCore 推送', async function () {
      await expect(
        this.vaultCore.connect(this.unauthorizedCaller).pushUserPositionUpdate(
          await this.user1.getAddress(),
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18)
        )
      ).to.be.reverted; // VaultCore 的 onlyBusinessModule 修饰符会拒绝
    });

    it('应该允许业务模块通过 VaultCore 推送资产统计更新', async function () {
      const requestId = ethers.keccak256(ethers.toUtf8Bytes('stats-request-1'));
      const seq = 999;

      await expect(
        this.vaultCore.connect(this.businessModule1).pushAssetStatsUpdate(
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18),
          ethers.parseUnits('100', 6),
          requestId,
          seq
        )
      ).to.emit(this.vaultRouter, 'AssetStatsPushed')
        .withArgs(
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18),
          ethers.parseUnits('100', 6),
          anyValue,
          requestId,
          seq
        );
    });
  });

  describe('Phase 0: 事件上下文验证', function () {
    it('应该正确传递 requestId 和 seq 到事件', async function () {
      const requestId1 = ethers.keccak256(ethers.toUtf8Bytes('request-1'));
      const requestId2 = ethers.keccak256(ethers.toUtf8Bytes('request-2'));
      const seq1 = 100;
      const seq2 = 200;

      // 第一次推送
      await expect(
        this.vaultCore
          .connect(this.businessModule1)
          ['pushUserPositionUpdate(address,address,uint256,uint256,bytes32,uint64)'](
          await this.user1.getAddress(),
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18),
          requestId1,
          seq1
        )
      ).to.emit(this.vaultRouter, 'UserPositionPushed')
        .withArgs(
          await this.user1.getAddress(),
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18),
          anyValue,
          requestId1,
          seq1
        );

      // 第二次推送（不同的 requestId 和 seq）
      await expect(
        this.vaultCore
          .connect(this.businessModule1)
          ['pushUserPositionUpdate(address,address,uint256,uint256,bytes32,uint64)'](
          await this.user1.getAddress(),
          this.testAsset,
          ethers.parseUnits('2', 18),
          ethers.parseUnits('1', 18),
          requestId2,
          seq2
        )
      ).to.emit(this.vaultRouter, 'UserPositionPushed')
        .withArgs(
          await this.user1.getAddress(),
          this.testAsset,
          ethers.parseUnits('2', 18),
          ethers.parseUnits('1', 18),
          anyValue,
          requestId2,
          seq2
        );
    });

    it('兼容版本应该使用默认的 requestId=0 和 seq=0', async function () {
      await expect(
        this.vaultCore
          .connect(this.businessModule1)
          ['pushUserPositionUpdate(address,address,uint256,uint256)'](
          await this.user1.getAddress(),
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18)
        )
      ).to.emit(this.vaultRouter, 'UserPositionPushed')
        .withArgs(
          await this.user1.getAddress(),
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18),
          anyValue,
          ethers.ZeroHash, // requestId = 0
          0 // seq = 0
        );
    });
  });

  describe('Phase 0: 边界条件测试', function () {
    it('应该处理零地址用户', async function () {
      await expect(
        this.vaultCore.connect(this.businessModule1).pushUserPositionUpdate(
          ZERO_ADDRESS,
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18)
        )
      ).to.emit(this.vaultRouter, 'UserPositionPushed')
        .withArgs(
          ZERO_ADDRESS,
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18),
          anyValue,
          ethers.ZeroHash,
          0
        );
    });

    it('应该处理零金额', async function () {
      await expect(
        this.vaultCore.connect(this.businessModule1).pushUserPositionUpdate(
          await this.user1.getAddress(),
          this.testAsset,
          0,
          0
        )
      ).to.emit(this.vaultRouter, 'UserPositionPushed')
        .withArgs(
          await this.user1.getAddress(),
          this.testAsset,
          0,
          0,
          anyValue,
          ethers.ZeroHash,
          0
        );
    });

    it('应该处理最大 requestId 和 seq 值', async function () {
      // bytes32 的最大值（全 1）
      const maxRequestId = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
      const maxSeq = BigInt('18446744073709551615'); // uint64 max value

      await expect(
        this.vaultCore
          .connect(this.businessModule1)
          ['pushUserPositionUpdate(address,address,uint256,uint256,bytes32,uint64)'](
          await this.user1.getAddress(),
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18),
          maxRequestId,
          maxSeq
        )
      ).to.emit(this.vaultRouter, 'UserPositionPushed')
        .withArgs(
          await this.user1.getAddress(),
          this.testAsset,
          ONE_ETH,
          ethers.parseUnits('0.5', 18),
          anyValue,
          maxRequestId,
          maxSeq
        );
    });
  });
});

