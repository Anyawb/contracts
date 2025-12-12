#!/usr/bin/env ts-node

import hardhat from 'hardhat';
import logger from '../utils/logger';

const { ethers } = hardhat;

/**
 * ModuleKeys 检查脚本
 * 
 * 测试目标:
 * - 验证所有 ModuleKeys 是否正确生成
 * - 检查是否存在零键或无效键
 * - 确保键的唯一性
 */
async function checkKeys(): Promise<void> {
  logger.info('开始检查 ModuleKeys...');

  // 部署测试合约
  const TestModuleKeysFactory = await ethers.getContractFactory('TestModuleKeys');
  const test = await TestModuleKeysFactory.deploy();
  await test.waitForDeployment();
  
  logger.success(`测试合约已部署到: ${await test.getAddress()}`);

  // 获取所有模块键
  const keys = await test.getAllModuleKeys();
  logger.info(`共发现 ${keys.length} 个模块键`);

  // 检查可疑路径模式
  const badPathPattern = /\/Users\/[^/]+\/\.cursor\/extensions\/ms-python\.python-[0-9.-a-z]+\/python_files\/printEnvVariablesToFile\.py0x[a-fA-F0-9]{64}$/;
  
  // 检查重复键
  const uniqueKeys = new Set<string>();
  let hasErrors = false;

  for (const key of keys) {
    // 检查可疑路径
    if (badPathPattern.test(key)) {
      logger.error(`发现可疑路径键: ${key}`);
      hasErrors = true;
    }
    
    // 检查零键
    if (key === '0x0000000000000000000000000000000000000000000000000000000000000000') {
      logger.error(`发现零键: ${key}`);
      hasErrors = true;
    }
    
    // 检查重复键
    if (uniqueKeys.has(key)) {
      logger.error(`发现重复键: ${key}`);
      hasErrors = true;
    } else {
      uniqueKeys.add(key);
    }
  }

  // 检查键的数量是否符合预期
  try {
    // 尝试调用 getExpectedKeyCount 方法，如果存在的话
    const testContract = test as unknown as { getExpectedKeyCount?: () => Promise<number> };
    const expectedKeyCount = await testContract.getExpectedKeyCount?.();
    if (expectedKeyCount && keys.length !== expectedKeyCount) {
      logger.error(`键数量不匹配: 发现 ${keys.length} 个, 预期 ${expectedKeyCount} 个`);
      hasErrors = true;
    }
  } catch (error) {
    // 如果方法不存在，则跳过此检查
    logger.warning('无法检查预期键数量，getExpectedKeyCount 方法可能不存在');
  }

  // 总结结果
  if (hasErrors) {
    logger.error('ModuleKeys 检查失败，请修复上述问题');
    process.exitCode = 1;
  } else {
    logger.success('ModuleKeys 检查通过！所有键都是有效的');
  }
}

// 执行检查
if (require.main === module) {
  checkKeys().catch(error => {
    logger.error('ModuleKeys 检查过程中出错', error);
    process.exitCode = 1;
  });
}

export { checkKeys }; 