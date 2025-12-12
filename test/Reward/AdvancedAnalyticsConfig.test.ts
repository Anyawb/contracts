/**
 * AdvancedAnalyticsConfig – 高级数据分析服务配置测试
 */
import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

import type { 
  AdvancedAnalyticsConfig,
  AccessControlManager
} from '../../types';

const ONE_ETH = ethers.parseUnits('1', 18);

// 定义ActionKeys常量，与合约中保持一致
const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));
const ACTION_CONSUME_POINTS = ethers.keccak256(ethers.toUtf8Bytes('CONSUME_POINTS'));

describe('AdvancedAnalyticsConfig – 高级数据分析服务配置', function () {
  let governance: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  beforeEach(async function () {
    // 在每个测试前重置网络状态
    await ethers.provider.send('hardhat_reset', []);
    [governance, alice, bob] = await ethers.getSigners();
  });

  // 部署合约和代理并进行初始化的函数
  async function deployConfigWithProxy() {
    // 部署 ACM 权限管理合约
    const ACMFactory = await ethers.getContractFactory('AccessControlManager');
    const acm = await ACMFactory.deploy(governance.address) as AccessControlManager;
    await acm.waitForDeployment();
    
    // 为测试账户授予权限
    await acm.grantRole(ACTION_SET_PARAMETER, alice.address);
    await acm.grantRole(ACTION_CONSUME_POINTS, bob.address);
    
    // 部署高级数据分析配置合约实现
    const ConfigFactory = await ethers.getContractFactory('AdvancedAnalyticsConfig');
    const configImpl = await ConfigFactory.deploy();
    await configImpl.waitForDeployment();
    
    // 部署代理并在构造函数中初始化
    const ProxyFactory = await ethers.getContractFactory('ERC1967Proxy');
    const configProxy = await ProxyFactory.deploy(
      await configImpl.getAddress(),
      configImpl.interface.encodeFunctionData('initialize', [
        await acm.getAddress()
      ])
    );
    await configProxy.waitForDeployment();
    
    // 将接口连接到代理地址
    const config = ConfigFactory.attach(await configProxy.getAddress()) as AdvancedAnalyticsConfig;
    
    return { config, acm };
  }

  describe('基础功能测试', function () {
    it('应正确初始化服务配置', async function () {
      const { config } = await deployConfigWithProxy();
      
      // 验证基础等级配置
      const basicConfig = await config.getConfig(0);
      expect(basicConfig.price).to.equal(ethers.parseUnits('100', 18));
      expect(basicConfig.duration).to.equal(30 * 24 * 3600);
      expect(basicConfig.isActive).to.be.true;
      expect(basicConfig.level).to.equal(0);
    });

    it('应正确获取服务类型', async function () {
      const { config } = await deployConfigWithProxy();
      
      const serviceType = await config.getServiceType();
      expect(serviceType).to.equal(0); // AdvancedAnalytics
    });

    it('应正确获取冷却期', async function () {
      const { config } = await deployConfigWithProxy();
      
      const cooldown = await config.getCooldown();
      expect(cooldown).to.equal(24 * 3600); // 1 day
    });

    it('应防止重复初始化', async function () {
      const { config, acm } = await deployConfigWithProxy();
      
      await expect(
        config.initialize(await acm.getAddress())
      ).to.be.reverted;
    });
  });

  describe('权限控制测试', function () {
    it('未授权账户不应能更新配置', async function () {
      const { config } = await deployConfigWithProxy();
      
      await expect(
        config.connect(bob).updateConfig(0, ONE_ETH, 30 * 24 * 3600, true)
      ).to.be.reverted; // 使用通用断言，不指定具体错误类型
    });

    it('view 函数应不受权限限制', async function () {
      const { config } = await deployConfigWithProxy();
      
      // view 函数应该可以正常调用
      const serviceType = await config.connect(bob).getServiceType();
      expect(serviceType).to.equal(0); // AdvancedAnalytics
      
      const configData = await config.connect(bob).getConfig(0);
      expect(configData.price).to.be.gt(0n);
    });
  });

  describe('配置管理测试', function () {
    it('应正确更新服务配置', async function () {
      const { config } = await deployConfigWithProxy();
      
      const newPrice = ethers.parseUnits('150', 18);
      const newDuration = 60 * 24 * 3600; // 60 days
      
      await config.connect(alice).updateConfig(0, newPrice, newDuration, false);
      
      const updatedConfig = await config.getConfig(0);
      expect(updatedConfig.price).to.equal(newPrice);
      expect(updatedConfig.duration).to.equal(newDuration);
      expect(updatedConfig.isActive).to.be.false;
    });

    it('应拒绝零价格配置', async function () {
      const { config } = await deployConfigWithProxy();
      
      await expect(
        config.connect(alice).updateConfig(0, 0, 30 * 24 * 3600, true)
      ).to.be.reverted;
    });

    it('应拒绝零时长配置', async function () {
      const { config } = await deployConfigWithProxy();
      
      await expect(
        config.connect(alice).updateConfig(0, ONE_ETH, 0, true)
      ).to.be.reverted;
    });
  });

  describe('统计功能测试', function () {
    it('应正确记录服务使用', async function () {
      const { config } = await deployConfigWithProxy();
      
      const points = ethers.parseUnits('100', 18);
      await config.connect(bob).recordServiceUsage(0, points);
      
      const [usageCount, revenue] = await config.getServiceStats(0);
      expect(usageCount).to.equal(1n);
      expect(revenue).to.equal(points);
    });
  });
}); 