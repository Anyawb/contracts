/**
 * 清理服务配置参数脚本
 * 
 * 功能:
 * - 清理已初始化的FeatureUnlockConfig参数
 * - 清理已初始化的GovernanceAccessConfig参数
 * - 重置ACM权限设置
 * - 准备干净的测试环境
 */
import hardhat from 'hardhat';
import fs from 'fs';
import path from 'path';
import rimraf from 'rimraf';
const { ethers, upgrades } = hardhat;

async function main() {
  console.log('🧹 开始清理服务配置参数...');
  
  try {
    const [deployer] = await ethers.getSigners();
    console.log('👤 部署者地址:', deployer.address);
    
    // 1. 清理本地部署记录
    console.log('📁 清理本地部署记录...');
    
    // 检查是否存在部署记录文件
    
    const deploymentFiles = [
      'scripts/deployments/localhost-complete.json',
      'scripts/deployments/localhost-simple.json'
    ];
    
    for (const file of deploymentFiles) {
      if (fs.existsSync(file)) {
        console.log(`🗑️  删除部署记录: ${file}`);
        fs.unlinkSync(file);
      }
    }
    
    // 2. 清理缓存
    console.log('🗂️  清理缓存文件...');
    
    const cacheDirs = [
      'cache',
      'artifacts',
      'typechain-types'
    ];
    
    for (const dir of cacheDirs) {
      if (fs.existsSync(dir)) {
        console.log(`🗑️  清理缓存目录: ${dir}`);
        rimraf.sync(dir);
      }
    }
    
    // 3. 重新编译合约
    console.log('🔨 重新编译合约...');
    await hardhat.run('compile');
    
    // 4. 生成类型文件
    console.log('📝 生成TypeScript类型文件...');
    await hardhat.run('typechain');
    
    console.log('✅ 清理完成！');
    console.log('');
    console.log('📋 清理内容:');
    console.log('  - 删除了本地部署记录文件');
    console.log('  - 清理了缓存目录');
    console.log('  - 重新编译了合约');
    console.log('  - 生成了新的类型文件');
    console.log('');
    console.log('🚀 现在可以运行测试了:');
    console.log('  npm run test:service-configs');
    
  } catch (error) {
    console.error('❌ 清理过程中出错:', error);
    process.exit(1);
  }
}

// 执行清理
main().catch((error) => {
  console.error('❌ 脚本执行失败:', error);
  process.exit(1);
}); 