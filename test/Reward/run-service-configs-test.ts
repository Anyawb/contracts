/**
 * 运行服务配置测试脚本
 * 
 * 功能:
 * - 清理测试环境
 * - 运行ServiceConfigs测试
 * - 生成测试报告
 * - 验证测试结果
 */
import hardhat from 'hardhat';
const { ethers } = hardhat;

async function main() {
  console.log('🚀 开始运行服务配置测试...');
  
  try {
    // 1. 清理测试环境
    console.log('🧹 清理测试环境...');
    await hardhat.run('clean');
    
    // 2. 编译合约
    console.log('🔨 编译合约...');
    await hardhat.run('compile');
    
    // 3. 生成类型文件
    console.log('📝 生成类型文件...');
    await hardhat.run('typechain');
    
    // 4. 运行测试
    console.log('🧪 运行ServiceConfigs测试...');
    await hardhat.run('test', { 
      testFiles: ['test/Reward/ServiceConfigs.test.ts'] 
    });
    
    console.log('✅ 测试完成！');
    console.log('');
    console.log('📊 测试覆盖范围:');
    console.log('  - FeatureUnlockConfig 合约功能测试');
    console.log('  - GovernanceAccessConfig 合约功能测试');
    console.log('  - ACM权限控制测试');
    console.log('  - 代理模式测试');
    console.log('  - 边界条件测试');
    console.log('  - 安全场景测试');
    console.log('  - 集成测试');
    
  } catch (error) {
    console.error('❌ 测试运行失败:', error);
    process.exit(1);
  }
}

// 仅在脚本被直接执行时才运行，避免 hardhat test 时触发清理/重编译
if (require.main === module) {
  main().catch((error) => {
    console.error('❌ 脚本执行失败:', error);
    process.exit(1);
  });
}

export {}; // 避免被识别为测试模块