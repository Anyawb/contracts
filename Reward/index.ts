/**
 * Reward模块测试索引
 * 
 * 统一管理Reward模块的所有测试文件和脚本
 */

// 测试文件路径
export const TEST_FILES = {
  ServiceConfigs: './ServiceConfigs.test',
  RewardManagerCore: './RewardManagerCore.test',
  PriorityServiceConfig: './PriorityServiceConfig.test',
  RewardManagerIntegration: './RewardManagerIntegration.test',
  AdvancedAnalyticsConfig: './AdvancedAnalyticsConfig.test',
  RewardConfig: './RewardConfig.test'
};

// 测试脚本路径
export const TEST_SCRIPTS = {
  cleanupServiceConfigs: './cleanup-service-configs',
  runServiceConfigsTest: './run-service-configs-test'
};

// 测试配置
export const TEST_CONFIG = {
  // 测试文件列表
  testFiles: [
    'test/Reward/ServiceConfigs.test.ts',
    'test/Reward/RewardManagerCore.test.ts',
    'test/Reward/PriorityServiceConfig.test.ts',
    'test/Reward/RewardManagerIntegration.test.ts',
    'test/Reward/AdvancedAnalyticsConfig.test.ts',
    'test/Reward/RewardConfig.test.ts'
  ],
  
  // 测试脚本列表
  testScripts: [
    'test/Reward/cleanup-service-configs.ts',
    'test/Reward/run-service-configs-test.ts'
  ],
  
  // 测试分类
  testCategories: {
    // 服务配置测试
    serviceConfigs: [
      'ServiceConfigs.test.ts',
      'PriorityServiceConfig.test.ts',
      'AdvancedAnalyticsConfig.test.ts'
    ],
    
    // 奖励管理测试
    rewardManagement: [
      'RewardManagerCore.test.ts',
      'RewardManagerIntegration.test.ts',
      'RewardConfig.test.ts'
    ],
    
    // 工具脚本
    utilities: [
      'cleanup-service-configs.ts',
      'run-service-configs-test.ts'
    ]
  }
};

// 测试运行器
export class RewardTestRunner {
  /**
   * 运行所有Reward模块测试
   */
  static async runAllTests() {
    console.log('🚀 开始运行所有Reward模块测试...');
    
    for (const testFile of TEST_CONFIG.testFiles) {
      console.log(`📋 运行测试: ${testFile}`);
      // 这里可以添加具体的测试运行逻辑
    }
  }
  
  /**
   * 运行服务配置相关测试
   */
  static async runServiceConfigsTests() {
    console.log('🔧 开始运行服务配置测试...');
    
    for (const testFile of TEST_CONFIG.testCategories.serviceConfigs) {
      console.log(`📋 运行测试: ${testFile}`);
      // 这里可以添加具体的测试运行逻辑
    }
  }
  
  /**
   * 运行奖励管理相关测试
   */
  static async runRewardManagementTests() {
    console.log('🎁 开始运行奖励管理测试...');
    
    for (const testFile of TEST_CONFIG.testCategories.rewardManagement) {
      console.log(`📋 运行测试: ${testFile}`);
      // 这里可以添加具体的测试运行逻辑
    }
  }
  
  /**
   * 清理测试环境
   */
  static async cleanupTestEnvironment() {
    console.log('🧹 清理测试环境...');
    // 这里可以添加清理逻辑
  }
}

// 默认导出
export default {
  TEST_CONFIG,
  RewardTestRunner
}; 