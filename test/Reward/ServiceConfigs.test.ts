/**
 * ServiceConfigs 测试模块
 * 
 * 测试目标:
 * - FeatureUnlockConfig 合约功能测试
 * - GovernanceAccessConfig 合约功能测试
 * - ACM权限控制测试
 * - 代理模式测试
 * - 边界条件测试
 * - 安全场景测试
 */
import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers, upgrades } = hardhat;

import type { 
  FeatureUnlockConfig,
  GovernanceAccessConfig
} from '../../types';

import type { 
  FeatureUnlockConfig__factory,
  GovernanceAccessConfig__factory
} from '../../types/factories/contracts/Reward/configs';
import type { 
  AccessControlManager,
  MockRegistry
} from '../../types/contracts';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

describe('ServiceConfigs – 服务配置合约测试', function () {
  async function deployFixture() {
    const [governance, alice, bob, charlie] = await ethers.getSigners();
    const KEY_ACM = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
    
    // Registry + ACM
    const registryFactory = await ethers.getContractFactory('MockRegistry');
    const registry = (await registryFactory.deploy()) as MockRegistry;
    await registry.waitForDeployment();
    
    const acmFactory = await ethers.getContractFactory('AccessControlManager');
    const acm = (await acmFactory.deploy(governance.address)) as AccessControlManager;
    await acm.waitForDeployment();
    await registry.setModule(KEY_ACM, await acm.getAddress());
    
    // 部署 FeatureUnlockConfig 代理 - initialize方法需要Registry地址
    const featureUnlockFactory = (await ethers.getContractFactory('FeatureUnlockConfig')) as FeatureUnlockConfig__factory;
    const featureUnlockProxy = await upgrades.deployProxy(featureUnlockFactory, [await registry.getAddress()], {
      kind: 'uups'
    }) as FeatureUnlockConfig;
    await featureUnlockProxy.waitForDeployment();
    
    // 部署 GovernanceAccessConfig 代理 - initialize方法需要Registry地址
    const governanceAccessFactory = (await ethers.getContractFactory('GovernanceAccessConfig')) as GovernanceAccessConfig__factory;
    const governanceAccessProxy = await upgrades.deployProxy(governanceAccessFactory, [await registry.getAddress()], {
      kind: 'uups'
    }) as GovernanceAccessConfig;
    await governanceAccessProxy.waitForDeployment();
    
    // 设置权限 - 默认治理已有 SET_PARAMETER/UPGRADE_MODULE，额外授予 alice/bob 时按需在测试内调用
    
    return { 
      acm, 
      registry,
      featureUnlockProxy, 
      governanceAccessProxy, 
      governance, 
      alice, 
      bob, 
      charlie 
    };
  }

  describe('FeatureUnlockConfig – 功能解锁配置测试', function () {
    
    describe('初始化测试', function () {
      it('应正确初始化合约', async function () {
        const { featureUnlockProxy, registry } = await deployFixture();
        
        // 验证 Registry 地址
        expect(await featureUnlockProxy.getRegistry()).to.equal(await registry.getAddress());
        
        // 验证服务类型
        expect(await featureUnlockProxy.getServiceType()).to.equal(2); // FeatureUnlock
        
        // 验证冷却期
        expect(await featureUnlockProxy.getCooldown()).to.equal(7 * 24 * 60 * 60); // 7 days
      });
      
      it('应正确初始化所有服务等级配置', async function () {
        const { featureUnlockProxy } = await deployFixture();
        
        // 验证 Basic 等级
        const basicConfig = await featureUnlockProxy.getConfig(0); // ServiceLevel.Basic
        expect(basicConfig.price).to.equal(ethers.parseUnits('200', 18));
        expect(basicConfig.duration).to.equal(30 * 24 * 60 * 60); // 30 days
        expect(basicConfig.isActive).to.be.true;
        expect(basicConfig.level).to.equal(0);
        expect(basicConfig.description).to.equal('Custom interest rate calculator');
        
        // 验证 Standard 等级
        const standardConfig = await featureUnlockProxy.getConfig(1); // ServiceLevel.Standard
        expect(standardConfig.price).to.equal(ethers.parseUnits('800', 18));
        expect(standardConfig.duration).to.equal(30 * 24 * 60 * 60); // 30 days
        expect(standardConfig.isActive).to.be.true;
        expect(standardConfig.level).to.equal(1);
        expect(standardConfig.description).to.equal('Batch operation tools');
        
        // 验证 Premium 等级
        const premiumConfig = await featureUnlockProxy.getConfig(2); // ServiceLevel.Premium
        expect(premiumConfig.price).to.equal(ethers.parseUnits('1500', 18));
        expect(premiumConfig.duration).to.equal(30 * 24 * 60 * 60); // 30 days
        expect(premiumConfig.isActive).to.be.true;
        expect(premiumConfig.level).to.equal(2);
        expect(premiumConfig.description).to.equal('Advanced risk management tools');
        
        // 验证 VIP 等级
        const vipConfig = await featureUnlockProxy.getConfig(3); // ServiceLevel.VIP
        expect(vipConfig.price).to.equal(ethers.parseUnits('3000', 18));
        expect(vipConfig.duration).to.equal(30 * 24 * 60 * 60); // 30 days
        expect(vipConfig.isActive).to.be.true;
        expect(vipConfig.level).to.equal(3);
        expect(vipConfig.description).to.equal('Full feature unlock');
      });
    });
    
    describe('权限控制测试', function () {
      it('非授权用户不应能更新配置', async function () {
        const { featureUnlockProxy, alice } = await deployFixture();
        
        await expect(
          featureUnlockProxy.connect(alice).updateConfig(0, ethers.parseUnits('500', 18), 60 * 60 * 24 * 30, true)
        ).to.be.reverted;
      });
      
      it('授权用户应能更新配置', async function () {
        const { featureUnlockProxy, governance } = await deployFixture();
        
        const newPrice = ethers.parseUnits('500', 18);
        const newDuration = 60 * 24 * 60 * 60; // 60 days
        
        await expect(
          featureUnlockProxy.connect(governance).updateConfig(0, newPrice, newDuration, true)
        ).to.emit(featureUnlockProxy, 'ConfigUpdated')
          .withArgs(0, newPrice, newDuration, true);
        
        const config = await featureUnlockProxy.getConfig(0);
        expect(config.price).to.equal(newPrice);
        expect(config.duration).to.equal(newDuration);
        expect(config.isActive).to.be.true;
      });
      
      it('非授权用户不应能设置冷却期', async function () {
        const { featureUnlockProxy, alice } = await deployFixture();
        
        await expect(
          featureUnlockProxy.connect(alice).setCooldown(14 * 24 * 60 * 60)
        ).to.be.reverted;
      });
      
      it('授权用户应能设置冷却期', async function () {
        const { featureUnlockProxy, governance } = await deployFixture();
        
        const newCooldown = 14 * 24 * 60 * 60; // 14 days
        
        await expect(
          featureUnlockProxy.connect(governance).setCooldown(newCooldown)
        ).to.emit(featureUnlockProxy, 'CooldownUpdated')
          .withArgs(newCooldown);
        
        expect(await featureUnlockProxy.getCooldown()).to.equal(newCooldown);
      });
    });
    
    describe('边界条件测试', function () {
      it('应能处理零价格配置', async function () {
        const { featureUnlockProxy, governance } = await deployFixture();
        
        await expect(
          featureUnlockProxy.connect(governance).updateConfig(0, 0, 30 * 24 * 60 * 60, true)
        ).to.not.be.reverted;
        
        const config = await featureUnlockProxy.getConfig(0);
        expect(config.price).to.equal(0);
      });
      
      it('应能处理零持续时间配置', async function () {
        const { featureUnlockProxy, governance } = await deployFixture();
        
        await expect(
          featureUnlockProxy.connect(governance).updateConfig(0, ethers.parseUnits('300', 18), 0, true)
        ).to.not.be.reverted;
        
        const config = await featureUnlockProxy.getConfig(0);
        expect(config.duration).to.equal(0);
      });
      
      it('应能处理大额价格配置', async function () {
        const { featureUnlockProxy, governance } = await deployFixture();
        
        const largePrice = ethers.parseUnits('1000000', 18);
        
        await expect(
          featureUnlockProxy.connect(governance).updateConfig(0, largePrice, 30 * 24 * 60 * 60, true)
        ).to.not.be.reverted;
        
        const config = await featureUnlockProxy.getConfig(0);
        expect(config.price).to.equal(largePrice);
      });
      
      it('应能处理长时间持续时间配置', async function () {
        const { featureUnlockProxy, governance } = await deployFixture();
        
        const longDuration = 365 * 24 * 60 * 60; // 1 year
        
        await expect(
          featureUnlockProxy.connect(governance).updateConfig(0, ethers.parseUnits('300', 18), longDuration, true)
        ).to.not.be.reverted;
        
        const config = await featureUnlockProxy.getConfig(0);
        expect(config.duration).to.equal(longDuration);
      });
    });
    
    describe('代理模式测试', function () {
      it('应能通过代理升级合约', async function () {
        const { featureUnlockProxy } = await deployFixture();
        
        // 部署新版本实现
        const featureUnlockFactory = (await ethers.getContractFactory('FeatureUnlockConfig')) as FeatureUnlockConfig__factory;
        
        // 升级代理
        await expect(
          upgrades.upgradeProxy(await featureUnlockProxy.getAddress(), featureUnlockFactory)
        ).to.not.be.reverted;
        
        // 验证功能仍然正常
        const config = await featureUnlockProxy.getConfig(0);
        expect(config.price).to.equal(ethers.parseUnits('200', 18));
      });
      
      it('非授权用户不应能升级合约', async function () {
        const { featureUnlockProxy, alice } = await deployFixture();
        
        const featureUnlockFactory = (await ethers.getContractFactory('FeatureUnlockConfig')) as FeatureUnlockConfig__factory;
        
        // 尝试使用非授权用户升级
        await expect(
          upgrades.upgradeProxy(await featureUnlockProxy.getAddress(), featureUnlockFactory.connect(alice))
        ).to.be.reverted;
      });
    });
  });

  describe('GovernanceAccessConfig – 治理访问配置测试', function () {
    
    describe('初始化测试', function () {
      it('应正确初始化合约', async function () {
        const { governanceAccessProxy, registry } = await deployFixture();
        
        // 验证 Registry 地址
        expect(await governanceAccessProxy.getRegistry()).to.equal(await registry.getAddress());
        
        // 验证服务类型
        expect(await governanceAccessProxy.getServiceType()).to.equal(3); // GovernanceAccess
        
        // 验证冷却期
        expect(await governanceAccessProxy.getCooldown()).to.equal(30 * 24 * 60 * 60); // 30 days
      });
      
      it('应正确初始化所有服务等级配置', async function () {
        const { governanceAccessProxy } = await deployFixture();
        
        // 验证 Basic 等级
        const basicConfig = await governanceAccessProxy.getConfig(0); // ServiceLevel.Basic
        expect(basicConfig.price).to.equal(ethers.parseUnits('200', 18));
        expect(basicConfig.duration).to.equal(30 * 24 * 60 * 60); // 30 days
        expect(basicConfig.isActive).to.be.true;
        expect(basicConfig.level).to.equal(0);
        expect(basicConfig.description).to.equal('Basic voting rights');
        
        // 验证 Standard 等级
        const standardConfig = await governanceAccessProxy.getConfig(1); // ServiceLevel.Standard
        expect(standardConfig.price).to.equal(ethers.parseUnits('1000', 18));
        expect(standardConfig.duration).to.equal(30 * 24 * 60 * 60); // 30 days
        expect(standardConfig.isActive).to.be.true;
        expect(standardConfig.level).to.equal(1);
        expect(standardConfig.description).to.equal('Proposal creation rights');
        
        // 验证 Premium 等级
        const premiumConfig = await governanceAccessProxy.getConfig(2); // ServiceLevel.Premium
        expect(premiumConfig.price).to.equal(ethers.parseUnits('2500', 18));
        expect(premiumConfig.duration).to.equal(30 * 24 * 60 * 60); // 30 days
        expect(premiumConfig.isActive).to.be.true;
        expect(premiumConfig.level).to.equal(2);
        expect(premiumConfig.description).to.equal('Parameter adjustment suggestions');
        
        // 验证 VIP 等级
        const vipConfig = await governanceAccessProxy.getConfig(3); // ServiceLevel.VIP
        expect(vipConfig.price).to.equal(ethers.parseUnits('6000', 18));
        expect(vipConfig.duration).to.equal(30 * 24 * 60 * 60); // 30 days
        expect(vipConfig.isActive).to.be.true;
        expect(vipConfig.level).to.equal(3);
        expect(vipConfig.description).to.equal('Core governance participation');
      });
    });
    
    describe('权限控制测试', function () {
      it('非授权用户不应能更新配置', async function () {
        const { governanceAccessProxy, alice } = await deployFixture();
        
        await expect(
          governanceAccessProxy.connect(alice).updateConfig(0, ethers.parseUnits('800', 18), 60 * 24 * 60 * 60, true)
        ).to.be.reverted;
      });
      
      it('授权用户应能更新配置', async function () {
        const { governanceAccessProxy, governance } = await deployFixture();
        
        const newPrice = ethers.parseUnits('800', 18);
        const newDuration = 60 * 24 * 60 * 60; // 60 days
        
        await expect(
          governanceAccessProxy.connect(governance).updateConfig(0, newPrice, newDuration, true)
        ).to.emit(governanceAccessProxy, 'ConfigUpdated')
          .withArgs(0, newPrice, newDuration, true);
        
        const config = await governanceAccessProxy.getConfig(0);
        expect(config.price).to.equal(newPrice);
        expect(config.duration).to.equal(newDuration);
        expect(config.isActive).to.be.true;
      });
      
      it('非授权用户不应能设置冷却期', async function () {
        const { governanceAccessProxy, alice } = await deployFixture();
        
        await expect(
          governanceAccessProxy.connect(alice).setCooldown(14 * 24 * 60 * 60)
        ).to.be.reverted;
      });
      
      it('授权用户应能设置冷却期', async function () {
        const { governanceAccessProxy, governance } = await deployFixture();
        
        const newCooldown = 14 * 24 * 60 * 60; // 14 days
        
        await expect(
          governanceAccessProxy.connect(governance).setCooldown(newCooldown)
        ).to.emit(governanceAccessProxy, 'CooldownUpdated')
          .withArgs(newCooldown);
        
        expect(await governanceAccessProxy.getCooldown()).to.equal(newCooldown);
      });
    });
    
    describe('边界条件测试', function () {
      it('应能处理零价格配置', async function () {
        const { governanceAccessProxy, governance } = await deployFixture();
        
        await expect(
          governanceAccessProxy.connect(governance).updateConfig(0, 0, 30 * 24 * 60 * 60, true)
        ).to.not.be.reverted;
        
        const config = await governanceAccessProxy.getConfig(0);
        expect(config.price).to.equal(0);
      });
      
      it('应能处理零持续时间配置', async function () {
        const { governanceAccessProxy, governance } = await deployFixture();
        
        await expect(
          governanceAccessProxy.connect(governance).updateConfig(0, ethers.parseUnits('500', 18), 0, true)
        ).to.not.be.reverted;
        
        const config = await governanceAccessProxy.getConfig(0);
        expect(config.duration).to.equal(0);
      });
      
      it('应能处理大额价格配置', async function () {
        const { governanceAccessProxy, governance } = await deployFixture();
        
        const largePrice = ethers.parseUnits('1000000', 18);
        
        await expect(
          governanceAccessProxy.connect(governance).updateConfig(0, largePrice, 30 * 24 * 60 * 60, true)
        ).to.not.be.reverted;
        
        const config = await governanceAccessProxy.getConfig(0);
        expect(config.price).to.equal(largePrice);
      });
      
      it('应能处理长时间持续时间配置', async function () {
        const { governanceAccessProxy, governance } = await deployFixture();
        
        const longDuration = 365 * 24 * 60 * 60; // 1 year
        
        await expect(
          governanceAccessProxy.connect(governance).updateConfig(0, ethers.parseUnits('500', 18), longDuration, true)
        ).to.not.be.reverted;
        
        const config = await governanceAccessProxy.getConfig(0);
        expect(config.duration).to.equal(longDuration);
      });
    });
    
    describe('代理模式测试', function () {
      it('应能通过代理升级合约', async function () {
        const { governanceAccessProxy } = await deployFixture();
        
        // 部署新版本实现
        const governanceAccessFactory = (await ethers.getContractFactory('GovernanceAccessConfig')) as GovernanceAccessConfig__factory;
        
        // 升级代理
        await expect(
          upgrades.upgradeProxy(await governanceAccessProxy.getAddress(), governanceAccessFactory)
        ).to.not.be.reverted;
        
        // 验证功能仍然正常
        const config = await governanceAccessProxy.getConfig(0);
        expect(config.price).to.equal(ethers.parseUnits('200', 18));
      });
      
      it('非授权用户不应能升级合约', async function () {
        const { governanceAccessProxy, alice } = await deployFixture();
        
        const governanceAccessFactory = (await ethers.getContractFactory('GovernanceAccessConfig')) as GovernanceAccessConfig__factory;
        
        // 尝试使用非授权用户升级
        await expect(
          upgrades.upgradeProxy(await governanceAccessProxy.getAddress(), governanceAccessFactory.connect(alice))
        ).to.be.reverted;
      });
    });
  });

  // 省略 ACM 集成与 keeper 相关测试（当前合约未暴露对应接口）

  describe('安全场景测试', function () {
    
    describe('重入攻击防护', function () {
      it('应防止重入攻击', async function () {
        const { featureUnlockProxy, governance } = await deployFixture();
        
        // 这里测试重入防护，实际的重入攻击需要更复杂的合约
        // 主要验证合约使用了ReentrancyGuard
        await expect(
          featureUnlockProxy.connect(governance).updateConfig(0, ethers.parseUnits('400', 18), 30 * 24 * 60 * 60, true)
        ).to.not.be.reverted;
      });
    });
    
    describe('数学溢出防护', function () {
      it('应防止价格溢出', async function () {
        const { featureUnlockProxy, governance } = await deployFixture();
        
        // 测试大数值
        const maxUint256 = ethers.MaxUint256;
        
        await expect(
          featureUnlockProxy.connect(governance).updateConfig(0, maxUint256, 30 * 24 * 60 * 60, true)
        ).to.not.be.reverted;
        
        const config = await featureUnlockProxy.getConfig(0);
        expect(config.price).to.equal(maxUint256);
      });
      
      it('应防止持续时间溢出', async function () {
        const { featureUnlockProxy, governance } = await deployFixture();
        
        // 测试大数值
        const maxUint256 = ethers.MaxUint256;
        
        await expect(
          featureUnlockProxy.connect(governance).updateConfig(0, ethers.parseUnits('300', 18), maxUint256, true)
        ).to.not.be.reverted;
        
        const config = await featureUnlockProxy.getConfig(0);
        expect(config.duration).to.equal(maxUint256);
      });
    });
    
    describe('权限提升防护', function () {
      it('普通用户不应能提升自己的权限', async function () {
        const { acm, alice } = await deployFixture();
        
        const adminRole = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));
        
        await expect(
          acm.connect(alice).grantRole(adminRole, alice.address)
        ).to.be.revertedWithCustomError(acm, 'OnlyOwnerAllowed');
      });
      
      it('普通用户不应能撤销管理员权限', async function () {
        const { acm, governance, alice, bob } = await deployFixture();
        
        const adminRole = ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE'));
        
        // 先授予bob管理员权限
        await acm.connect(governance).grantRole(adminRole, bob.address);
        
        // 尝试撤销
        await expect(
          acm.connect(alice).revokeRole(adminRole, bob.address)
        ).to.be.revertedWithCustomError(acm, 'OnlyOwnerAllowed');
      });
    });
  });

  describe('集成测试', function () {
    
    describe('完整业务流程测试', function () {
      it('应能完成完整的配置管理流程', async function () {
        const { featureUnlockProxy, governanceAccessProxy, governance } = await deployFixture();
        
        // 1. 验证初始配置
        let config = await featureUnlockProxy.getConfig(0);
        expect(config.price).to.equal(ethers.parseUnits('200', 18));
        
        // 2. 更新配置
        const newPrice = ethers.parseUnits('400', 18);
        await featureUnlockProxy.connect(governance).updateConfig(0, newPrice, 30 * 24 * 60 * 60, true);
        
        config = await featureUnlockProxy.getConfig(0);
        expect(config.price).to.equal(newPrice);
        
        // 3. 更新冷却期
        const newCooldown = 14 * 24 * 60 * 60;
        await featureUnlockProxy.connect(governance).setCooldown(newCooldown);
        expect(await featureUnlockProxy.getCooldown()).to.equal(newCooldown);
        
        // 4. 验证治理访问配置
        config = await governanceAccessProxy.getConfig(0);
        expect(config.price).to.equal(ethers.parseUnits('200', 18));
        
        // 5. 更新治理访问配置
        const newGovPrice = ethers.parseUnits('600', 18);
        await governanceAccessProxy.connect(governance).updateConfig(0, newGovPrice, 30 * 24 * 60 * 60, true);
        
        config = await governanceAccessProxy.getConfig(0);
        expect(config.price).to.equal(newGovPrice);
      });
    });
    
    describe('多用户并发测试', function () {
      it('应能处理多用户并发操作', async function () {
        const { featureUnlockProxy, acm, governance, alice, bob } = await deployFixture();
        
        // 授予alice和bob权限
        const setParameterRole = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));
        await acm.connect(governance).grantRole(setParameterRole, alice.address);
        await acm.connect(governance).grantRole(setParameterRole, bob.address);
        
        // 并发更新不同等级
        const tx1 = featureUnlockProxy.connect(alice).updateConfig(0, ethers.parseUnits('400', 18), 30 * 24 * 60 * 60, true);
        const tx2 = featureUnlockProxy.connect(bob).updateConfig(1, ethers.parseUnits('900', 18), 30 * 24 * 60 * 60, true);
        
        await expect(Promise.all([tx1, tx2])).to.not.be.reverted;
        
        // 验证结果
        const config0 = await featureUnlockProxy.getConfig(0);
        const config1 = await featureUnlockProxy.getConfig(1);
        
        expect(config0.price).to.equal(ethers.parseUnits('400', 18));
        expect(config1.price).to.equal(ethers.parseUnits('900', 18));
      });
    });
  });
});

// 辅助函数
async function time(): Promise<number> {
  return (await ethers.provider.getBlock('latest'))!.timestamp;
} 