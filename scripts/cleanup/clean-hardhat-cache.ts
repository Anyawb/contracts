#!/usr/bin/env node

/**
 * Hardhat 缓存清理脚本
 * 
 * 清理内容:
 * - cache/ 目录 (编译缓存)
 * - artifacts/ 目录 (构建产物)
 * - coverage/ 目录 (测试覆盖率报告)
 * - 临时文件和日志
 */

import { execSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';

const ROOT_DIR = join(__dirname, '../../');

// 需要清理的目录和文件
const CLEANUP_TARGETS = [
  'cache',
  'artifacts', 
  'coverage',
  'typechain',
  'typechain-types',
  'gas-report.txt',
  'coverage.json',
  'test-results',
  'test-coverage',
  '.hardhat_contract_sizer_output.json'
];

// 需要清理的临时文件模式
const TEMP_FILE_PATTERNS = [
  '*.log',
  '*.tmp',
  '*.temp',
  '*.cache',
  '.eslintcache'
];

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
      log(`✓ 已清理目录: ${dirPath}`, 'success');
    } catch (error) {
      log(`✗ 清理目录失败: ${dirPath} - ${error}`, 'error');
    }
  } else {
    log(`- 目录不存在: ${dirPath}`, 'info');
  }
}

function cleanFile(filePath: string) {
  const fullPath = join(ROOT_DIR, filePath);
  
  if (existsSync(fullPath)) {
    try {
      rmSync(fullPath, { force: true });
      log(`✓ 已清理文件: ${filePath}`, 'success');
    } catch (error) {
      log(`✗ 清理文件失败: ${filePath} - ${error}`, 'error');
    }
  } else {
    log(`- 文件不存在: ${filePath}`, 'info');
  }
}

function cleanTempFiles() {
  log('清理临时文件...', 'info');
  
  TEMP_FILE_PATTERNS.forEach(pattern => {
    try {
      execSync(`find ${ROOT_DIR} -name "${pattern}" -type f -delete`, { stdio: 'ignore' });
      log(`✓ 已清理模式: ${pattern}`, 'success');
    } catch (error) {
      // 忽略 find 命令的错误（文件不存在等）
    }
  });
}

function cleanNodeModulesCache() {
  log('清理 npm 缓存...', 'info');
  
  try {
    execSync('npm cache clean --force', { stdio: 'inherit' });
    log('✓ npm 缓存已清理', 'success');
  } catch (error) {
    log('✗ npm 缓存清理失败', 'error');
  }
}

function main() {
  console.log(chalk.bold.cyan('🧹 Hardhat 缓存清理工具\n'));
  
  // 清理目录
  log('开始清理 Hardhat 相关目录...', 'info');
  CLEANUP_TARGETS.forEach(target => {
    if (target.includes('.')) {
      cleanFile(target);
    } else {
      cleanDirectory(target);
    }
  });
  
  // 清理临时文件
  cleanTempFiles();
  
  // 清理 npm 缓存
  cleanNodeModulesCache();
  
  console.log(chalk.bold.green('\n🎉 清理完成！'));
  console.log(chalk.yellow('\n💡 提示:'));
  console.log(chalk.yellow('   - 下次运行测试前需要重新编译合约'));
  console.log(chalk.yellow('   - 可以使用 "npm run compile" 重新编译'));
  console.log(chalk.yellow('   - 可以使用 "npm run test" 运行测试'));
}

// 如果直接运行此脚本
if (require.main === module) {
  main();
}

export { main as cleanHardhatCache }; 