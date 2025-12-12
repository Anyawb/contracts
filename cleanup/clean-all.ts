#!/usr/bin/env node

/**
 * 一键清理脚本
 * 
 * 清理所有开发相关的缓存和构建产物
 */

import { execSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';

const ROOT_DIR = join(__dirname, '../../');

function log(message: string, type: 'info' | 'success' | 'error' | 'warning' = 'info') {
  const colors = {
    info: chalk.blue,
    success: chalk.green,
    error: chalk.red,
    warning: chalk.yellow
  };
  console.log(colors[type](`[${type.toUpperCase()}] ${message}`));
}

function cleanDirectory(dirPath: string) {
  const fullPath = join(ROOT_DIR, dirPath);
  
  if (existsSync(fullPath)) {
    try {
      rmSync(fullPath, { recursive: true, force: true });
      log(`✓ 已清理: ${dirPath}`, 'success');
    } catch (error) {
      log(`✗ 清理失败: ${dirPath}`, 'error');
    }
  }
}

function main() {
  console.log(chalk.bold.cyan('🧹 一键清理工具\n'));
  
  // 清理 Hardhat 相关
  log('清理 Hardhat 缓存...', 'info');
  cleanDirectory('cache');
  cleanDirectory('artifacts');
  cleanDirectory('coverage');
  cleanDirectory('typechain');
  cleanDirectory('typechain-types');
  
  // 清理测试相关
  log('清理测试产物...', 'info');
  cleanDirectory('test-results');
  cleanDirectory('test-coverage');
  
  // 清理构建产物
  log('清理构建产物...', 'info');
  cleanDirectory('build');
  cleanDirectory('dist');
  cleanDirectory('out');
  
  // 清理临时文件
  log('清理临时文件...', 'info');
  try {
    execSync('find . -name "*.log" -type f -delete', { stdio: 'ignore' });
    execSync('find . -name "*.tmp" -type f -delete', { stdio: 'ignore' });
    execSync('find . -name "*.temp" -type f -delete', { stdio: 'ignore' });
    execSync('find . -name ".eslintcache" -type f -delete', { stdio: 'ignore' });
    log('✓ 临时文件已清理', 'success');
  } catch (error) {
    // 忽略错误
  }
  
  // 清理 npm 缓存
  log('清理 npm 缓存...', 'info');
  try {
    execSync('npm cache clean --force', { stdio: 'inherit' });
    log('✓ npm 缓存已清理', 'success');
  } catch (error) {
    log('✗ npm 缓存清理失败', 'error');
  }
  
  console.log(chalk.bold.green('\n🎉 清理完成！'));
  console.log(chalk.yellow('\n💡 下一步:'));
  console.log(chalk.yellow('   1. npm install (如果需要)'));
  console.log(chalk.yellow('   2. npm run compile (重新编译合约)'));
  console.log(chalk.yellow('   3. npm run test (运行测试)'));
}

if (require.main === module) {
  main();
}

export { main as cleanAll }; 