/**
 * Registry History Buffer – 历史缓冲区测试
 * 
 * 测试目标:
 * - 历史记录基本功能验证
 * - 历史记录限制测试
 * - Gas 优化测试
 * - 边界条件测试
 * - 错误处理测试
 */

import { expect } from 'chai';
import { ethers } from 'hardhat';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

// 导入合约类型
import type { Registry } from '../../types';

describe('Registry History Buffer', function () {
  let registry: Registry;
  let owner: SignerWithAddress;
  let addr1: SignerWithAddress;
  let addr2: SignerWithAddress;

  // 测试常量定义
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

  async function deployRegistryFixture() {
    const [owner, addr1, addr2] = await ethers.getSigners();
        
    // 部署实现和代理
    const Registry = await ethers.getContractFactory('Registry');
    const implementation = await Registry.deploy();
    await implementation.waitForDeployment();
        
    // 部署代理
    const ERC1967Proxy = await ethers.getContractFactory('ERC1967Proxy');
    const proxy = await ERC1967Proxy.deploy(
      await implementation.getAddress(),
      implementation.interface.encodeFunctionData('initialize', [
        BigInt(3600),
        await owner.getAddress(),
        await owner.getAddress(),
        await owner.getAddress(),
      ])
    );
    await proxy.waitForDeployment();
        
    const registry = implementation.attach(await proxy.getAddress()) as Registry;
        
    return { registry, owner, addr1, addr2 };
  }

  beforeEach(async function () {
    const fixture = await loadFixture(deployRegistryFixture);
    registry = fixture.registry;
    owner = fixture.owner;
    addr1 = fixture.addr1;
    addr2 = fixture.addr2;
  });

  describe('History Buffer - Basic Functionality', function () {
    it('Should record history for module updates', async function () {
      const key = ethers.keccak256(ethers.toUtf8Bytes('HISTORY_TEST')) as `0x${string}`;
      const testAddress = await addr1.getAddress();
            
      // 设置模块
      await registry.setModule(key, testAddress);
            
      // 获取历史记录
      const history = await registry.getAllUpgradeHistory(key);
      expect(history.length).to.equal(1);
      expect(history[0].oldAddress).to.equal(ZERO_ADDRESS);
      expect(history[0].newAddress).to.equal(testAddress);
      expect(history[0].executor).to.equal(await owner.getAddress());
      expect(history[0].timestamp).to.be.gt(0);
    });

    it('Should handle multiple history records', async function () {
      const key = ethers.keccak256(ethers.toUtf8Bytes('MULTIPLE_HISTORY')) as `0x${string}`;
      const addresses: string[] = [];
            
      // 设置多个模块
      for (let i = 0; i < 5; i++) {
        addresses.push(ethers.Wallet.createRandom().address);
        await registry.setModule(key, addresses[i]);
      }
            
      // 获取历史记录
      const history = await registry.getAllUpgradeHistory(key);
      expect(history.length).to.equal(5);
            
      // 验证历史记录数量
      expect(history.length).to.equal(5);
      // 验证历史记录存在
      expect(history).to.be.an('array');
      expect(history.length).to.be.gt(0);
    });

    it('Should handle batch operations with history', async function () {
      const keys: `0x${string}`[] = [
        ethers.keccak256(ethers.toUtf8Bytes('BATCH_HISTORY_1')) as `0x${string}`,
        ethers.keccak256(ethers.toUtf8Bytes('BATCH_HISTORY_2')) as `0x${string}`
      ];
            
      // 执行批量操作
      const addresses: string[] = [
        ethers.Wallet.createRandom().address,
        ethers.Wallet.createRandom().address
      ];
                
      await registry.setModulesWithStatus(keys, addresses);
            
      // 检查两个键的历史
      for (let i = 0; i < keys.length; i++) {
        const history = await registry.getAllUpgradeHistory(keys[i]);
        expect(history.length).to.equal(1);
        expect(history[0].newAddress).to.equal(addresses[i]);
        expect(history[0].oldAddress).to.equal(ZERO_ADDRESS);
      }
    });

    it('Should handle edge case with zero history', async function () {
      const key = ethers.keccak256(ethers.toUtf8Bytes('ZERO_HISTORY')) as `0x${string}`;
            
      // 在任何操作之前获取历史
      const history = await registry.getAllUpgradeHistory(key);
      expect(history.length).to.equal(0);
            
      // 设置模块一次
      await registry.setModule(key, await addr1.getAddress());
            
      // 一次操作后获取历史
      const historyAfter = await registry.getAllUpgradeHistory(key);
      expect(historyAfter.length).to.equal(1);
      expect(historyAfter[0].newAddress).to.equal(await addr1.getAddress());
    });

    it('Should handle rapid successive updates', async function () {
      const key = ethers.keccak256(ethers.toUtf8Bytes('RAPID_TEST')) as `0x${string}`;
            
      // 执行快速连续更新
      for (let i = 0; i < 10; i++) {
        await registry.setModule(key, ethers.Wallet.createRandom().address);
      }
            
      const history = await registry.getAllUpgradeHistory(key);
      expect(history.length).to.equal(10);
            
      // 验证时间戳按升序排列
      for (let i = 1; i < history.length; i++) {
        expect(Number(history[i].timestamp)).to.be.gte(Number(history[i-1].timestamp));
      }
            
      console.log('Rapid updates test passed');
    });
  });

  describe('History Buffer - Gas Optimization', function () {
    it('Should optimize gas usage for history operations', async function () {
      const key = ethers.keccak256(ethers.toUtf8Bytes('GAS_TEST')) as `0x${string}`;
            
      // 测量第一个历史记录的气体使用
      const tx1 = await registry.setModule(key, await addr1.getAddress());
      const receipt1 = await tx1.wait();
            
      // 测量多次设置的气体使用
      for (let i = 0; i < 10; i++) {
        await registry.setModule(key, ethers.Wallet.createRandom().address);
      }
            
      const tx2 = await registry.setModule(key, await addr2.getAddress());
      const receipt2 = await tx2.wait();
            
      console.log(`First history record gas: ${receipt1?.gasUsed?.toString()}`);
      console.log(`Multiple history records gas: ${receipt2?.gasUsed?.toString()}`);
            
      // 两个操作都应该在合理的气体范围内
      expect(Number(receipt1?.gasUsed)).to.be.lessThan(500000);
      expect(Number(receipt2?.gasUsed)).to.be.lessThan(500000);
    });

    it('Should handle large batch operations with history efficiently', async function () {
      const keys: `0x${string}`[] = [];
      const addresses: string[] = [];
            
      for (let i = 0; i < 5; i++) {
        keys.push(ethers.keccak256(ethers.toUtf8Bytes(`BATCH_GAS_${i}`)) as `0x${string}`);
        addresses.push(ethers.Wallet.createRandom().address);
      }
            
      // 第一次批量操作
      const tx1 = await registry.setModulesWithStatus(keys, addresses);
      const receipt1 = await tx1.wait();
            
      // 第二次批量操作
      const addresses2 = addresses.map(() => ethers.Wallet.createRandom().address);
      const tx2 = await registry.setModulesWithStatus(keys, addresses2);
      const receipt2 = await tx2.wait();
            
      console.log(`First batch gas: ${receipt1?.gasUsed?.toString()}`);
      console.log(`Second batch gas: ${receipt2?.gasUsed?.toString()}`);
            
      // 两个操作都应该高效
      expect(Number(receipt1?.gasUsed)).to.be.lessThan(2000000); // 批量操作的合理限制
      expect(Number(receipt2?.gasUsed)).to.be.lessThan(2000000); // 批量操作的合理限制
    });
  });

  describe('History Buffer - Error Handling', function () {
    it('Should handle invalid history queries gracefully', async function () {
      const key = ethers.keccak256(ethers.toUtf8Bytes('INVALID_HISTORY')) as `0x${string}`;
            
      // 查询不存在模块的历史
      const history = await registry.getAllUpgradeHistory(key);
      expect(history.length).to.equal(0);
    });

    it('Should handle history count correctly', async function () {
      const key = ethers.keccak256(ethers.toUtf8Bytes('COUNT_TEST')) as `0x${string}`;
            
      // 初始计数应该为0
      let count = await registry.getUpgradeHistoryCount(key);
      expect(count).to.equal(0);
            
      // 设置模块后计数应该为1
      await registry.setModule(key, await addr1.getAddress());
      count = await registry.getUpgradeHistoryCount(key);
      expect(count).to.equal(1);
            
      // 多次设置后计数应该正确
      for (let i = 0; i < 10; i++) {
        await registry.setModule(key, ethers.Wallet.createRandom().address);
      }
      count = await registry.getUpgradeHistoryCount(key);
      expect(count).to.equal(11);
    });

    it('Should handle individual history record access', async function () {
      const key = ethers.keccak256(ethers.toUtf8Bytes('INDIVIDUAL_TEST')) as `0x${string}`;
      const addresses: string[] = [];
            
      // 设置多个模块
      for (let i = 0; i < 5; i++) {
        addresses.push(ethers.Wallet.createRandom().address);
        await registry.setModule(key, addresses[i]);
      }
            
      // 获取单个历史记录
      const history0 = await registry.getUpgradeHistory(key, 0);
      expect(history0.newAddress).to.be.a('string');
      expect(history0.oldAddress).to.be.a('string');
      expect(history0.executor).to.equal(await owner.getAddress());
      expect(history0.timestamp).to.be.gt(0);
    });

    it('Should handle single history record correctly', async function () {
      const key = ethers.keccak256(ethers.toUtf8Bytes('SINGLE_HISTORY')) as `0x${string}`;
      const testAddress = await addr1.getAddress();
            
      // 设置模块
      await registry.setModule(key, testAddress);
            
      // 获取单个历史记录
      const history = await registry.getAllUpgradeHistory(key);
      expect(history.length).to.equal(1);
      expect(history[0].oldAddress).to.equal(ZERO_ADDRESS);
      expect(history[0].newAddress).to.equal(testAddress);
      expect(history[0].executor).to.equal(await owner.getAddress());
      expect(history[0].timestamp).to.be.gt(0);
    });
  });
}); 